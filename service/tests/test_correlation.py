from __future__ import annotations

import json
import logging
from pathlib import Path
import re

from fastapi.testclient import TestClient

from app.correlation import CORRELATION_HEADER, safe_analysis_error_code
from app.errors import Conflict
from app.main import create_app


SAFE_GENERATED_ID = re.compile(r"^fr-[a-f0-9]{32}$")


def _request_records(caplog):
    unique: dict[int, logging.LogRecord] = {}
    for record in caplog.records:
        if record.name == "found_roll.http":
            unique[id(record)] = record
    return list(unique.values())


def test_service_returns_and_safely_logs_bounded_correlation(caplog):
    private_answer = "private-answer-marker-4118"
    query_marker = "query-secret-marker-8742"
    auth_marker = "Bearer auth-secret-marker-9981"
    correlation_id = "corr-service-request-0001"

    request_logger = logging.getLogger("found_roll.http")
    request_logger.propagate = True
    try:
        with caplog.at_level(logging.INFO, logger="found_roll.http"):
            with TestClient(create_app()) as client:
                response = client.post(
                    f"/api/v1/passports/FR-20260829-0042/claim-evidence?debug={query_marker}",
                    headers={
                        CORRELATION_HEADER: correlation_id,
                        "Authorization": auth_marker,
                    },
                    json={
                        "expected_version": 0,
                        "idempotency_key": "correlation-test-001",
                        "answer": private_answer,
                    },
                )
    finally:
        request_logger.propagate = False

    assert response.headers[CORRELATION_HEADER] == correlation_id
    records = _request_records(caplog)
    assert len(records) == 1
    record = records[0]
    assert record.getMessage() == "request_complete"
    assert record.service == "found-roll-custody"
    assert record.correlation_id == correlation_id
    assert record.http_method == "POST"
    assert record.route_template == "/api/v1/passports/{case_id}/claim-evidence"
    assert record.status_code == response.status_code
    assert isinstance(record.latency_ms, float)
    rendered = " ".join(str(value) for value in record.__dict__.values())
    assert private_answer not in rendered
    assert query_marker not in rendered
    assert auth_marker not in rendered
    assert "FR-20260829-0042" not in record.route_template
    safe_handler = next(
        handler
        for handler in request_logger.handlers
        if getattr(handler, "_found_roll_safe_request_handler", False)
    )
    structured = json.loads(safe_handler.format(record))
    assert set(structured) == {
        "service",
        "correlation_id",
        "http_method",
        "route_template",
        "status_code",
        "error_code",
        "latency_ms",
    }
    assert structured["error_code"] is None
    assert private_answer not in safe_handler.format(record)
    assert logging.getLogger("uvicorn.access").disabled is True
    assert "--no-access-log" in (
        Path(__file__).resolve().parents[1] / "Dockerfile"
    ).read_text(encoding="utf-8")


def test_invalid_correlation_is_replaced_and_health_reports_inventory_config(caplog):
    rejected_marker = "invalid-correlation-private-marker-" + ("x" * 80)
    request_logger = logging.getLogger("found_roll.http")
    request_logger.propagate = True
    try:
        with caplog.at_level(logging.INFO, logger="found_roll.http"):
            with TestClient(create_app()) as client:
                response = client.get(
                    "/healthz?private=query-marker",
                    headers={CORRELATION_HEADER: rejected_marker},
                )
    finally:
        request_logger.propagate = False

    generated = response.headers[CORRELATION_HEADER]
    assert SAFE_GENERATED_ID.fullmatch(generated)
    assert rejected_marker not in " ".join(
        str(value)
        for record in _request_records(caplog)
        for value in record.__dict__.values()
    )
    assert response.json()["inventory_mode"] == "fixture"
    assert response.json()["inventory_base_url_configured"] is False
    assert response.json()["inventory_gateway_configured"] is True
    assert response.json()["inventory_gateway_ready"] is True
    assert response.json()["inventory_timeout_seconds"] == 3.0
    assert response.json()["analyst_wall_clock_timeout_seconds"] == 240.0
    assert response.json()["task_dispatch_deadline_seconds"] == 305


def test_only_allowlisted_analysis_code_enters_request_log(caplog):
    private_message = "private-model-output-marker-5531"
    application = create_app()

    class FailedAnalyst:
        mode = "test-failed-analyst"
        model_name = "test-failed-analyst"
        prompt_version = "test-failed-analyst"
        output_schema_version = "found-roll-analysis-proposal-v2"

        @staticmethod
        def analyze(_case, _candidates):
            raise Conflict("agent_tool_trajectory_incomplete", private_message)

    request_logger = logging.getLogger("found_roll.http")
    request_logger.propagate = True
    try:
        with caplog.at_level(logging.INFO, logger="found_roll.http"):
            with TestClient(application) as client:
                started = client.post(
                    "/api/v1/passports/FR-20260829-0042/analysis-jobs",
                    json={
                        "expected_version": 1,
                        "idempotency_key": "correlation-analysis-failure-001",
                    },
                )
                assert started.status_code == 200, started.text
                application.state.custody_service.analyst = FailedAnalyst()
                failed = client.post("/tasks/outbox", json=started.json()["task"]["payload"])
    finally:
        request_logger.propagate = False

    assert failed.status_code == 409, failed.text
    task_record = next(
        record
        for record in _request_records(caplog)
        if record.route_template == "/tasks/outbox"
    )
    assert task_record.error_code == "agent_tool_trajectory_incomplete"
    safe_handler = next(
        handler
        for handler in request_logger.handlers
        if getattr(handler, "_found_roll_safe_request_handler", False)
    )
    rendered = safe_handler.format(task_record)
    assert private_message not in rendered
    assert safe_analysis_error_code("adk_wall_clock_timeout") == "adk_wall_clock_timeout"
    assert safe_analysis_error_code("untrusted_dynamic_failure_code") is None

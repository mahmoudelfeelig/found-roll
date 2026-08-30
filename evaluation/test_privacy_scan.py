from __future__ import annotations

from contextlib import redirect_stdout
import hashlib
import importlib.util
import io
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "privacy-scan.py"
FIXTURES = ROOT / "evaluation" / "privacy-fixtures"
RAW_TEST_CANARY = "FR-LEAK-CANARY-7Q2M9X"


def load_scanner():
    spec = importlib.util.spec_from_file_location("found_roll_privacy_scan", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_clean_publication_fixture_passes(tmp_path):
    scanner = load_scanner()
    output = tmp_path / "clean-report.json"
    report = scanner.run_scan(
        roots=[FIXTURES / "clean"],
        manifest_path=FIXTURES / "canaries.json",
        output_path=output,
    )
    assert report["status"] == "PASS"
    assert report["finding_count"] == 0
    assert RAW_TEST_CANARY not in output.read_text(encoding="utf-8")


def test_binary_file_is_reported_as_unsupported(tmp_path):
    scanner = load_scanner()
    fixture_root = tmp_path / "mixed-publication"
    fixture_root.mkdir()
    (fixture_root / "view.json").write_text('{"status":"safe"}\n', encoding="utf-8")
    (fixture_root / "capture.png").write_bytes(b"\x89PNG\r\n\x1a\nsynthetic-test-bytes")
    output = tmp_path / "mixed-report.json"
    report = scanner.run_scan(
        roots=[fixture_root],
        manifest_path=FIXTURES / "canaries.json",
        output_path=output,
    )
    assert report["status"] == "PASS"
    assert report["scanned_file_count"] == 1
    assert report["unsupported_file_count"] == 1
    assert report["unsupported_extensions"] == {".png": 1}


def test_source_and_mermaid_text_extensions_are_scanned(tmp_path):
    scanner = load_scanner()
    fixture_root = tmp_path / "text-publication"
    fixture_root.mkdir()
    (fixture_root / "view.jsx").write_text("export const status = 'safe';\n", encoding="utf-8")
    (fixture_root / "architecture.mmd").write_text("flowchart LR\nA --> B\n", encoding="utf-8")
    output = tmp_path / "text-report.json"
    report = scanner.run_scan(
        roots=[fixture_root],
        manifest_path=FIXTURES / "canaries.json",
        output_path=output,
    )
    assert report["status"] == "PASS"
    assert report["scanned_file_count"] == 2
    assert report["unsupported_file_count"] == 0


def test_leaky_fixture_is_detected_without_value_echo(tmp_path):
    scanner = load_scanner()
    output = tmp_path / "leak-report.json"
    stdout = io.StringIO()
    with redirect_stdout(stdout):
        exit_code = scanner.main(
            [
                "--root",
                str(FIXTURES / "leaky"),
                "--canary-manifest",
                str(FIXTURES / "canaries.json"),
                "--output",
                str(output),
                "--fail-on-findings",
            ]
        )
    report_text = output.read_text(encoding="utf-8")
    report = json.loads(report_text)
    assert exit_code == 1
    assert report["status"] == "FAIL"
    assert report["findings_by_rule"]["self-test-restricted-canary"] == 1
    assert report["findings_by_rule"]["embedded-demo-credential-uri"] == 1
    assert report["finding_values_included"] is False
    assert RAW_TEST_CANARY not in report_text
    assert RAW_TEST_CANARY not in stdout.getvalue()


def test_structured_canary_ignores_opaque_substrings_but_detects_semantic_echo(tmp_path):
    scanner = load_scanner()
    assert scanner.privacy_field_mode("cloud_build_asset_snapshot_before_utc") == "opaque"
    assert scanner.privacy_field_mode("cloud_build_asset_snapshot_after_utc") == "opaque"
    assert scanner.privacy_field_mode("image_resources") == "reference"
    assert scanner.privacy_field_mode("package") == "reference"
    assert scanner.privacy_field_mode("image_package") == "reference"
    raw_value = "4118"
    manifest = tmp_path / "canaries.json"
    manifest.write_text(
        json.dumps(
            {
                "canaries": [
                    {
                        "id": "short-private-answer",
                        "sha256": hashlib.sha256(raw_value.encode("utf-8")).hexdigest(),
                        "length": len(raw_value),
                        "matching": "structured_values",
                    }
                ],
                "patterns": [],
            }
        ),
        encoding="utf-8",
    )

    hash_fixture = tmp_path / "hash-fixture"
    hash_fixture.mkdir()
    (hash_fixture / "events.json").write_text(
        json.dumps(
            {
                "event_hash": f"abc{raw_value}def",
                "evidence_digests": [f"abc{raw_value}def"],
                "idempotency_key": f"idem-abc{raw_value}def",
                "last_replay_task_name": f"replay-abc{raw_value}def",
                "occurred_at": f"2026-08-30T03:{raw_value}:00Z",
                "original_generation": f"gen-abc{raw_value}def",
                "preview_generation": f"gen-abc{raw_value}def",
                "release_task_name": f"release-abc{raw_value}def",
                "sha256": f"abc{raw_value}def",
                "task_name": f"task-abc{raw_value}def",
                "workflow_epoch": f"epoch-abc{raw_value}def",
                "evidence_refs": [f"ref://item/abc{raw_value}def"],
                "bytes": int(f"14{raw_value}"),
                "app_origin": f"https://abc{raw_value}def.example",
                "app_revision": f"found-roll-app-abc{raw_value}def",
                "commit_sha": f"abc{raw_value}def",
                "project_created_at_utc": f"2026-08-30T03:{raw_value}:00Z",
                "cloud_build_asset_snapshot_before_utc": f"2026-08-30T03:{raw_value}:00Z",
                "cloud_build_asset_snapshot_after_utc": f"2026-08-30T04:{raw_value}:00Z",
                "project_number": f"106{raw_value}7746",
                "revision": f"revision-abc{raw_value}def",
                "revision_resource": f"projects/abc{raw_value}def/revisions/current",
                "service_resource": f"projects/abc{raw_value}def/services/found-roll",
                "image_resources": [
                    f"us-central1-docker.pkg.dev/project/repository/abc{raw_value}def@sha256:abcdef"
                ],
                "package": f"us-central1-docker.pkg.dev/project/repository/abc{raw_value}def",
                "image_package": f"us-central1-docker.pkg.dev/project/repository/abc{raw_value}def",
                "submitted_commit": f"abc{raw_value}def",
                "tree_sha": f"abc{raw_value}def",
            }
        ),
        encoding="utf-8",
    )
    clean_report = scanner.run_scan(
        roots=[hash_fixture],
        manifest_path=manifest,
        output_path=tmp_path / "hash-report.json",
    )
    assert clean_report["status"] == "PASS"
    assert clean_report["finding_count"] == 0

    reference_leak_fixture = tmp_path / "reference-leak-fixture"
    reference_leak_fixture.mkdir()
    (reference_leak_fixture / "events.json").write_text(
        json.dumps(
            {
                "evidence_refs": [f"ref://item/{raw_value}"],
                "image_resources": [
                    f"us-central1-docker.pkg.dev/project/repository/{raw_value}@sha256:abcdef"
                ],
                "package": f"us-central1-docker.pkg.dev/project/repository/{raw_value}",
                "image_package": f"us-central1-docker.pkg.dev/project/repository/{raw_value}",
            }
        ),
        encoding="utf-8",
    )
    reference_leak_report = scanner.run_scan(
        roots=[reference_leak_fixture],
        manifest_path=manifest,
        output_path=tmp_path / "reference-leak-report.json",
    )
    assert reference_leak_report["status"] == "FAIL"
    assert reference_leak_report["findings_by_rule"] == {"short-private-answer": 4}

    numeric_leak_fixture = tmp_path / "numeric-leak-fixture"
    numeric_leak_fixture.mkdir()
    (numeric_leak_fixture / "events.json").write_text(
        json.dumps({"bytes": int(raw_value)}),
        encoding="utf-8",
    )
    numeric_leak_report = scanner.run_scan(
        roots=[numeric_leak_fixture],
        manifest_path=manifest,
        output_path=tmp_path / "numeric-leak-report.json",
    )
    assert numeric_leak_report["status"] == "FAIL"
    assert numeric_leak_report["findings_by_rule"] == {"short-private-answer": 1}

    opaque_receipt_leak_fixture = tmp_path / "opaque-receipt-leak-fixture"
    opaque_receipt_leak_fixture.mkdir()
    (opaque_receipt_leak_fixture / "release.json").write_text(
        json.dumps(
            {
                "project_number": raw_value,
                "cloud_build_asset_snapshot_before_utc": raw_value,
                "cloud_build_asset_snapshot_after_utc": raw_value,
            }
        ),
        encoding="utf-8",
    )
    opaque_receipt_leak_report = scanner.run_scan(
        roots=[opaque_receipt_leak_fixture],
        manifest_path=manifest,
        output_path=tmp_path / "opaque-receipt-leak-report.json",
    )
    assert opaque_receipt_leak_report["status"] == "FAIL"
    assert opaque_receipt_leak_report["findings_by_rule"] == {"short-private-answer": 3}

    leak_fixture = tmp_path / "leak-fixture"
    leak_fixture.mkdir()
    (leak_fixture / "events.json").write_text(
        json.dumps({"reason": f"private-answer-{raw_value}-was-rejected"}),
        encoding="utf-8",
    )
    leak_report = scanner.run_scan(
        roots=[leak_fixture],
        manifest_path=manifest,
        output_path=tmp_path / "leak-report.json",
    )
    assert leak_report["status"] == "FAIL"
    assert leak_report["findings_by_rule"] == {"short-private-answer": 1}

    unstructured_fixture = tmp_path / "unstructured-fixture"
    unstructured_fixture.mkdir()
    (unstructured_fixture / "view.txt").write_text(
        f"private-answer-{raw_value}-was-rejected",
        encoding="utf-8",
    )
    unstructured_report = scanner.run_scan(
        roots=[unstructured_fixture],
        manifest_path=manifest,
        output_path=tmp_path / "unstructured-report.json",
    )
    assert unstructured_report["status"] == "FAIL"
    assert unstructured_report["findings_by_rule"] == {"short-private-answer": 1}


def test_wrong_answer_scenario_ignores_private_answer_substring_inside_event_hash(monkeypatch):
    import evaluation.run_evaluation as runner

    assert runner.privacy_field_mode("cloud_build_asset_snapshot_before_utc") == "opaque"
    assert runner.privacy_field_mode("cloud_build_asset_snapshot_after_utc") == "opaque"
    assert runner.privacy_field_mode("image_resources") == "reference"
    assert runner.privacy_field_mode("package") == "reference"
    assert runner.privacy_field_mode("image_package") == "reference"
    assert runner.structured_value_contains_private_token(
        {"event_hash": f"abc{runner.DEMO_PRIVATE_ANSWER}def"},
        runner.DEMO_PRIVATE_ANSWER,
    ) is False
    assert runner.structured_value_contains_private_token(
        {
            "sha256": f"abc{runner.DEMO_PRIVATE_ANSWER}def",
            "evidence_digests": [f"abc{runner.DEMO_PRIVATE_ANSWER}def"],
            "idempotency_key": f"idem-abc{runner.DEMO_PRIVATE_ANSWER}def",
            "last_replay_task_name": f"replay-abc{runner.DEMO_PRIVATE_ANSWER}def",
            "original_generation": f"gen-abc{runner.DEMO_PRIVATE_ANSWER}def",
            "preview_generation": f"gen-abc{runner.DEMO_PRIVATE_ANSWER}def",
            "release_task_name": f"release-abc{runner.DEMO_PRIVATE_ANSWER}def",
            "task_name": f"task-abc{runner.DEMO_PRIVATE_ANSWER}def",
            "workflow_epoch": f"epoch-abc{runner.DEMO_PRIVATE_ANSWER}def",
            "evidence_refs": [f"ref://item/abc{runner.DEMO_PRIVATE_ANSWER}def"],
            "bytes": int(f"14{runner.DEMO_PRIVATE_ANSWER}"),
            "app_origin": f"https://abc{runner.DEMO_PRIVATE_ANSWER}def.example",
            "app_revision": f"found-roll-app-abc{runner.DEMO_PRIVATE_ANSWER}def",
            "commit_sha": f"abc{runner.DEMO_PRIVATE_ANSWER}def",
            "project_created_at_utc": f"2026-08-30T03:{runner.DEMO_PRIVATE_ANSWER}:00Z",
            "cloud_build_asset_snapshot_before_utc": f"2026-08-30T03:{runner.DEMO_PRIVATE_ANSWER}:00Z",
            "cloud_build_asset_snapshot_after_utc": f"2026-08-30T04:{runner.DEMO_PRIVATE_ANSWER}:00Z",
            "project_number": f"106{runner.DEMO_PRIVATE_ANSWER}7746",
            "revision": f"revision-abc{runner.DEMO_PRIVATE_ANSWER}def",
            "revision_resource": f"projects/abc{runner.DEMO_PRIVATE_ANSWER}def/revisions/current",
            "service_resource": f"projects/abc{runner.DEMO_PRIVATE_ANSWER}def/services/found-roll",
            "image_resources": [
                f"us-central1-docker.pkg.dev/project/repository/abc{runner.DEMO_PRIVATE_ANSWER}def@sha256:abcdef"
            ],
            "package": f"us-central1-docker.pkg.dev/project/repository/abc{runner.DEMO_PRIVATE_ANSWER}def",
            "image_package": f"us-central1-docker.pkg.dev/project/repository/abc{runner.DEMO_PRIVATE_ANSWER}def",
            "submitted_commit": f"abc{runner.DEMO_PRIVATE_ANSWER}def",
            "tree_sha": f"abc{runner.DEMO_PRIVATE_ANSWER}def",
        },
        runner.DEMO_PRIVATE_ANSWER,
    ) is False
    assert runner.structured_value_contains_private_token(
        {"reason": f"abc{runner.DEMO_PRIVATE_ANSWER}def"},
        runner.DEMO_PRIVATE_ANSWER,
    ) is True
    assert runner.structured_value_contains_private_token(
        {f"private-{runner.DEMO_PRIVATE_ANSWER}-field": "redacted"},
        runner.DEMO_PRIVATE_ANSWER,
    ) is True
    assert runner.structured_value_contains_private_token(
        {"event_hash": runner.DEMO_PRIVATE_ANSWER},
        runner.DEMO_PRIVATE_ANSWER,
    ) is True
    assert runner.structured_value_contains_private_token(
        {"evidence_refs": [f"ref://item/{runner.DEMO_PRIVATE_ANSWER}"]},
        runner.DEMO_PRIVATE_ANSWER,
    ) is True
    assert runner.structured_value_contains_private_token(
        {"bytes": int(runner.DEMO_PRIVATE_ANSWER)},
        runner.DEMO_PRIVATE_ANSWER,
    ) is True
    assert runner.structured_value_contains_private_token(
        {"project_number": runner.DEMO_PRIVATE_ANSWER},
        runner.DEMO_PRIVATE_ANSWER,
    ) is True
    for private_surface in (
        {"cloud_build_asset_snapshot_before_utc": runner.DEMO_PRIVATE_ANSWER},
        {"cloud_build_asset_snapshot_after_utc": runner.DEMO_PRIVATE_ANSWER},
        {"image_resources": [f"pkg/{runner.DEMO_PRIVATE_ANSWER}@sha256:abcdef"]},
        {"package": f"pkg/{runner.DEMO_PRIVATE_ANSWER}"},
        {"image_package": f"pkg/{runner.DEMO_PRIVATE_ANSWER}"},
    ):
        assert runner.structured_value_contains_private_token(
            private_surface,
            runner.DEMO_PRIVATE_ANSWER,
        ) is True

    original_event_items = runner.event_items

    def event_items_with_hash_collision(client):
        items = original_event_items(client)
        items[0]["event_hash"] = f"abc{runner.DEMO_PRIVATE_ANSWER}def"
        return items

    monkeypatch.setattr(runner, "event_items", event_items_with_hash_collision)
    observed = runner.scenario_wrong_answer_review(runner.RunContext())
    assert observed["final_state"] == "MANUAL_REVIEW"
    assert observed["restricted_event_findings"] == 0

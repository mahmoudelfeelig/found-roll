from copy import deepcopy
from importlib.metadata import version
from types import SimpleNamespace

import pytest
from google.adk.agents.invocation_context import InvocationContext, LlmCallsLimitExceededError
from google.adk.events import Event
from google.genai._transformers import process_schema
from google.genai.types import (
    Content,
    FunctionCall,
    FunctionResponse,
    GenerateContentResponseUsageMetadata,
    Part,
)

from app.agent import (
    VertexAdkCaseAnalyst,
    _observed_execution_evidence,
    _tool_outcome,
    deterministic_candidate_packet,
)
from app.agent_contract import (
    CASE_ANALYST_INSTRUCTION,
    CASE_ANALYST_PROMPT_VERSION,
    build_case_analyst_request,
)
from app.domain import (
    ANALYSIS_PROPOSAL_SCHEMA_VERSION,
    AgentExecutionEvidence,
    AnalysisProposal,
    CaseRecord,
    EvidenceOrigin,
    EvidenceProvenance,
    EvidenceRecord,
    EvidenceVisibility,
)
from app.fixtures import fixture_candidates, fixture_case
from app.errors import Conflict, Unavailable


def test_pinned_adk_builds_bounded_typed_agent_without_network_access(monkeypatch):
    assert version("google-adk") == "2.8.0"
    assert version("google-genai") == "2.20.0"

    analyst = VertexAdkCaseAnalyst(
        project="fixture-project",
        location="us-central1",
        model_name="gemini-3.5-flash",
    )
    agent = analyst._build_agent(fixture_candidates("test-pepper"))

    assert type(agent).__name__ == "LlmAgent"
    assert type(agent.model).__name__ == "Gemini"
    assert agent.model.model == "gemini-3.5-flash"
    assert agent.generate_content_config is not None
    assert agent.generate_content_config.max_output_tokens == 2048
    assert agent.mode == "chat"
    assert agent.output_schema is AnalysisProposal
    assert agent.instruction == CASE_ANALYST_INSTRUCTION
    assert len(agent.tools) == 5
    assert analyst.max_llm_calls == 12
    assert analyst.prompt_version == CASE_ANALYST_PROMPT_VERSION
    assert analyst.output_schema_version == ANALYSIS_PROPOSAL_SCHEMA_VERSION
    assert CASE_ANALYST_PROMPT_VERSION == "found-roll-case-analyst-prompt-v2"
    assert "Preserve that list exactly, keep its order" in agent.instruction
    assert "search_custodian exactly once for every authorized_tenants entry" in agent.instruction
    assert "without repeating a successful call" in agent.instruction
    ranked = deterministic_candidate_packet(fixture_case(), fixture_candidates("test-pepper"))
    request = build_case_analyst_request(fixture_case(), ranked)
    assert request["candidate_ids"] == ["NA-PCH-231", "ML-PCH-219"]
    assert request["authorized_tenants"] == ["metro-loop", "northport-air"]
    tools = {tool.__name__: tool for tool in agent.tools}
    loaded = tools["load_candidate"]("NA-PCH-231")
    assert loaded["allowed_discriminator_id"] == "lens_serial_last4"
    assert loaded["restricted_value_included"] is False
    assert "restricted_value_hash" not in loaded
    allowed = tools["propose_discriminator"](
        "NA-PCH-231",
        "lens_serial_last4",
        "What are the final four digits of the lens serial?",
    )
    assert allowed["accepted"] is True
    invented = tools["propose_discriminator"](
        "NA-PCH-231",
        "invented_private_field",
        "What hidden value should be revealed?",
    )
    assert invented == {"accepted": False, "reason": "discriminator_not_authorized"}
    monkeypatch.delenv("GOOGLE_GENAI_USE_ENTERPRISE", raising=False)
    monkeypatch.delenv("GOOGLE_GENAI_USE_VERTEXAI", raising=False)
    analyst._configure_vertex_environment()
    assert __import__("os").environ["GOOGLE_GENAI_USE_ENTERPRISE"] == "TRUE"
    assert __import__("os").environ["GOOGLE_GENAI_USE_VERTEXAI"] == "true"


def test_analysis_schema_is_vertex_compatible_and_keeps_claim_authority_fail_closed():
    schema = deepcopy(AnalysisProposal.model_json_schema())

    # Exercise the exact pinned google-genai schema transformer that prepares
    # the ADK response schema for Vertex AI, without making a network request.
    process_schema(schema, None)

    evidence_schema = schema["properties"]["evidence_sufficient_for_claim"]
    assert evidence_schema["type"] == "boolean"
    assert "const" not in evidence_schema
    proposal = {
        "ranked_candidate_ids": ["NA-PCH-231"],
        "selected_candidate_id": "NA-PCH-231",
        "visible_signals": ["repaired lower corner seam"],
        "restricted_attribute_id": "lens_serial_last4",
        "next_question": "What are the final four characters on the lens serial label?",
        "tool_trajectory": ["load_candidate:success"],
    }
    assert AnalysisProposal(**proposal).evidence_sufficient_for_claim is False
    assert (
        AnalysisProposal(
            **proposal,
            evidence_sufficient_for_claim=False,
        ).evidence_sufficient_for_claim
        is False
    )
    with pytest.raises(ValueError, match="cannot declare evidence sufficient"):
        AnalysisProposal(
            **proposal,
            evidence_sufficient_for_claim=True,
        )
    for non_boolean_false in ("false", "true", 0, 1, None):
        with pytest.raises(ValueError):
            AnalysisProposal(
                **proposal,
                evidence_sufficient_for_claim=non_boolean_false,
            )


def test_live_invocation_evidence_accepts_the_frozen_cap_and_rejects_overflow():
    execution = AgentExecutionEvidence(
        trace_id="bounded-trace",
        invocation_count=12,
        tool_trajectory=[{"name": "search_custodian", "outcome": "success"}],
        typed_output_valid=True,
    )
    assert execution.invocation_count == 12
    with pytest.raises(ValueError):
        AgentExecutionEvidence(
            trace_id="overflow-trace",
            invocation_count=13,
            tool_trajectory=[{"name": "search_custodian", "outcome": "success"}],
            typed_output_valid=True,
        )

    case_payload = fixture_case().model_dump()
    case_payload["model_invocation_count"] = 12
    assert CaseRecord.model_validate(case_payload).model_invocation_count == 12
    case_payload["model_invocation_count"] = 13
    with pytest.raises(ValueError):
        CaseRecord.model_validate(case_payload)


def test_adk_events_become_sanitized_bound_execution_evidence():
    ranked = deterministic_candidate_packet(fixture_case(), fixture_candidates("test-pepper"))
    selected = ranked[0]
    proposal = AnalysisProposal(
        ranked_candidate_ids=[item.id for item in ranked],
        selected_candidate_id=selected.id,
        visible_signals=selected.public_signals,
        evidence_sufficient_for_claim=False,
        restricted_attribute_id=selected.restricted_attribute_id,
        next_question="What are the final four characters on the lens serial label?",
        tool_trajectory=["untrusted-model-reported-value"],
    )

    calls = [
        FunctionCall(id="call-search-metro", name="search_custodian", args={"tenant_id": "metro-loop"}),
        FunctionCall(id="call-search-air", name="search_custodian", args={"tenant_id": "northport-air"}),
        FunctionCall(id="call-load", name="load_candidate", args={"candidate_id": selected.id}),
        FunctionCall(
            id="call-submit",
            name="submit_observations",
            args={"candidate_id": selected.id, "visible_signals": selected.public_signals},
        ),
        FunctionCall(
            id="call-question",
            name="propose_discriminator",
            args={
                "candidate_id": selected.id,
                "attribute_id": selected.restricted_attribute_id,
                "question": proposal.next_question,
            },
        ),
    ]
    responses = [
        FunctionResponse(id=call.id, name=call.name, response={"accepted": True})
        for call in calls
    ]
    invocation_id = "adk-invocation-live-123"

    def adk_event(event_id, *, calls=(), responses=(), usage=False):
        parts = [Part(function_call=call) for call in calls]
        parts.extend(Part(function_response=response) for response in responses)
        return Event(
            id=event_id,
            invocation_id=invocation_id,
            author="case_analyst",
            content=Content(role="model", parts=parts) if parts else None,
            usage_metadata=(
                GenerateContentResponseUsageMetadata(
                    prompt_token_count=1,
                    candidates_token_count=1,
                    total_token_count=2,
                )
                if usage
                else None
            ),
        )

    evidence = _observed_execution_evidence(
        events=[
            adk_event("llm-1", calls=calls[:3], usage=True),
            adk_event("tools-1", responses=responses[:3]),
            adk_event("llm-2", calls=calls[3:], usage=True),
            adk_event("tools-2", responses=responses[3:]),
            adk_event("llm-final", usage=True),
        ],
        ranked_candidates=ranked,
        proposal=proposal,
    )

    assert evidence.trace_id == invocation_id
    assert evidence.invocation_count == 3
    assert [entry.name for entry in evidence.tool_trajectory] == [call.name for call in calls]
    assert {entry.outcome for entry in evidence.tool_trajectory} == {"success"}
    assert evidence.typed_output_valid is True
    assert _tool_outcome({"accepted": False}) == "denied"
    assert _tool_outcome({"error": "unavailable"}) == "unavailable"
    assert _tool_outcome(
        {"review_requested": True, "approved": False},
        tool_name="request_manual_review",
    ) == "abstained"


def test_adk_execution_evidence_rejects_unpaired_tool_response():
    ranked = deterministic_candidate_packet(fixture_case(), fixture_candidates("test-pepper"))
    selected = ranked[0]
    proposal = AnalysisProposal(
        ranked_candidate_ids=[item.id for item in ranked],
        selected_candidate_id=selected.id,
        visible_signals=selected.public_signals,
        evidence_sufficient_for_claim=False,
        restricted_attribute_id=selected.restricted_attribute_id,
        next_question="What are the final four characters on the lens serial label?",
        tool_trajectory=["untrusted"],
    )

    class PairingEvent:
        id = "llm-1"
        invocation_id = "adk-invocation-live-456"
        usage_metadata = object()

        @staticmethod
        def get_function_calls():
            return [SimpleNamespace(id="call-1", name="search_custodian", args={"tenant_id": "metro-loop"})]

        @staticmethod
        def get_function_responses():
            return [SimpleNamespace(id="call-1", name="load_candidate", response={"accepted": True})]

    with pytest.raises(Conflict) as raised:
        _observed_execution_evidence(
            events=[PairingEvent()],
            ranked_candidates=ranked,
            proposal=proposal,
        )

    assert raised.value.code == "agent_tool_pairing_invalid"


def test_adk_llm_call_ceiling_is_translated_to_terminal_unavailability(monkeypatch):
    def exhaust_call_budget(_context):
        raise LlmCallsLimitExceededError("Max number of llm calls limit of `12` exceeded")

    # Keep the real Runner path so root-agent mode validation executes. The
    # patched call counter stops immediately before any model request.
    monkeypatch.setattr(InvocationContext, "increment_llm_call_count", exhaust_call_budget)
    analyst = VertexAdkCaseAnalyst(
        project="fixture-project",
        location="us-central1",
        model_name="gemini-3.5-flash",
    )

    with pytest.raises(Unavailable) as raised:
        analyst.analyze(fixture_case(), fixture_candidates("test-pepper"))

    assert raised.value.code == "adk_llm_call_limit_exceeded"


def test_vertex_request_attaches_only_explicitly_authorized_gcs_images():
    authorized = EvidenceRecord(
        id=f"evd-{'1' * 32}",
        case_id=fixture_case().id,
        object_name=f"evidence/{'a' * 32}",
        storage_uri=f"gs://fixture-private/evidence/{'a' * 32}",
        provenance=EvidenceProvenance(
            origin=EvidenceOrigin.DERIVED,
            source_evidence_id=f"evd-{'0' * 32}",
            transform="exif-transpose-fit-1600-jpeg-v1",
        ),
        sha256="b" * 64,
        generation=7,
        mime_type="image/jpeg",
        byte_size=123,
        visibility=EvidenceVisibility.MODEL_AUTHORIZED,
    )
    staff_only = authorized.model_copy(
        update={
            "id": f"evd-{'2' * 32}",
            "storage_uri": f"gs://fixture-private/evidence/{'c' * 32}",
            "visibility": EvidenceVisibility.STAFF_ONLY,
        }
    )
    non_gcs = authorized.model_copy(
        update={
            "id": f"evd-{'3' * 32}",
            "storage_uri": f"memory://evidence/{'d' * 32}",
        }
    )
    authorized_original = authorized.model_copy(
        update={
            "id": f"evd-{'4' * 32}",
            "storage_uri": f"gs://fixture-private/evidence/{'e' * 32}",
            "provenance": EvidenceProvenance(
                origin=EvidenceOrigin.ORIGINAL,
                transform="unaltered-upload-v1",
            ),
        }
    )

    class DefensiveStoreStub:
        def list_model_authorized(self, _case_id, _workflow_epoch):
            # Deliberately returns invalid rows to prove the analyst rechecks the boundary.
            return [authorized, staff_only, non_gcs, authorized_original]

    analyst = VertexAdkCaseAnalyst(
        project="fixture-project",
        location="us-central1",
        model_name="gemini-3.5-flash",
        evidence_store=DefensiveStoreStub(),
    )
    parts = analyst._request_parts(fixture_case(), fixture_candidates("test-pepper"), Part)

    assert len(parts) == 2
    assert parts[1].file_data.file_uri == authorized.storage_uri
    assert parts[1].file_data.mime_type == "image/jpeg"
    assert '"private_expected_answer_included":false' in parts[0].text
    assert "4118" not in parts[0].text


def test_live_candidate_packet_is_hard_filtered_before_model_construction():
    case = fixture_case()
    candidates = fixture_candidates("test-pepper")
    ranked = deterministic_candidate_packet(case, candidates)
    assert [candidate.id for candidate in ranked] == ["NA-PCH-231", "ML-PCH-219"]

    ambiguous = [
        candidate.model_copy(update={"frozen_score": 0.82})
        if candidate.id == "ML-PCH-219"
        else candidate
        for candidate in candidates
    ]
    try:
        deterministic_candidate_packet(case, ambiguous)
    except Conflict as exc:
        assert exc.code == "candidate_evidence_insufficient"
    else:
        raise AssertionError("An insufficient score margin reached the model candidate packet.")

from importlib.metadata import version

from google.genai.types import Part

from app.agent import VertexAdkCaseAnalyst, deterministic_candidate_packet
from app.agent_contract import CASE_ANALYST_INSTRUCTION, CASE_ANALYST_PROMPT_VERSION
from app.domain import (
    ANALYSIS_PROPOSAL_SCHEMA_VERSION,
    AnalysisProposal,
    EvidenceOrigin,
    EvidenceProvenance,
    EvidenceRecord,
    EvidenceVisibility,
)
from app.fixtures import fixture_candidates, fixture_case
from app.errors import Conflict


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
    assert agent.output_schema is AnalysisProposal
    assert agent.instruction == CASE_ANALYST_INSTRUCTION
    assert len(agent.tools) == 5
    assert analyst.max_llm_calls == 8
    assert analyst.prompt_version == CASE_ANALYST_PROMPT_VERSION
    assert analyst.output_schema_version == ANALYSIS_PROPOSAL_SCHEMA_VERSION
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

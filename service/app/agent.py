"""Bounded Case Analyst adapters.

The analyst can rank already-authorized candidates and propose one private
question. It cannot receive the expected answer and has no custody-changing
tool. The deterministic fixture adapter is for tests/local demos only; the
VertexAdk adapter is the canonical live path.
"""

from __future__ import annotations

import asyncio
import json
import os
from typing import TYPE_CHECKING, Protocol
from uuid import uuid4

from .agent_contract import (
    CASE_ANALYST_INSTRUCTION,
    CASE_ANALYST_PROMPT_VERSION,
    build_case_analyst_request,
)
from .domain import (
    ANALYSIS_PROPOSAL_SCHEMA_VERSION,
    AnalysisProposal,
    Candidate,
    CaseRecord,
    EvidenceOrigin,
    EvidenceVisibility,
)
from .errors import Conflict, Unavailable
from .inventory import FixtureInventoryGateway, InventoryGateway

if TYPE_CHECKING:
    from .evidence import EvidenceStore


class CaseAnalyst(Protocol):
    mode: str
    model_name: str
    prompt_version: str
    output_schema_version: str

    def analyze(self, case: CaseRecord, candidates: list[Candidate]) -> tuple[str, AnalysisProposal]: ...


def deterministic_candidate_packet(case: CaseRecord, candidates: list[Candidate]) -> list[Candidate]:
    """Apply custody-engine gates before either analyst can ask a private question."""

    eligible = [
        item
        for item in candidates
        if item.category == case.category
        and item.route_compatible
        and item.time_compatible
        and item.availability == "AVAILABLE"
    ]
    if not eligible:
        raise Conflict("no_eligible_candidates", "No candidate survived the deterministic hard filters.")
    ranked = sorted(eligible, key=lambda item: item.frozen_score, reverse=True)
    selected = ranked[0]
    runner_up = ranked[1].frozen_score if len(ranked) > 1 else 0.0
    if (
        selected.visible_signal_count < 2
        or selected.frozen_score - runner_up < 0.10
        or not selected.restricted_attribute_id
        or not selected.restricted_value_hash
    ):
        raise Conflict(
            "candidate_evidence_insufficient",
            "No candidate has enough deterministic evidence to justify a private discriminator question.",
        )
    return ranked


class FixtureCaseAnalyst:
    mode = "fixture"
    model_name = "deterministic-fixture-no-model"
    prompt_version = "fixture-no-model"
    output_schema_version = ANALYSIS_PROPOSAL_SCHEMA_VERSION

    def analyze(self, case: CaseRecord, candidates: list[Candidate]) -> tuple[str, AnalysisProposal]:
        ranked = deterministic_candidate_packet(case, candidates)
        selected = ranked[0]
        proposal = AnalysisProposal(
            ranked_candidate_ids=[item.id for item in ranked],
            selected_candidate_id=selected.id,
            visible_signals=selected.public_signals,
            evidence_sufficient_for_claim=False,
            restricted_attribute_id=selected.restricted_attribute_id or "staff_private_discriminator",
            next_question="What are the final four characters on the lens serial label kept inside the pouch?",
            tool_trajectory=[
                "search_custodian:grand-hall",
                "search_custodian:metro-loop",
                "search_custodian:northport-air",
                f"load_candidate:{selected.id}",
                "submit_observations",
                "propose_discriminator:lens_serial_last4",
            ],
        )
        return f"fixture-run-{uuid4().hex[:16]}", proposal


class VertexAdkCaseAnalyst:
    mode = "vertex_adk"
    max_llm_calls = 8
    prompt_version = CASE_ANALYST_PROMPT_VERSION
    output_schema_version = ANALYSIS_PROPOSAL_SCHEMA_VERSION

    def __init__(
        self,
        *,
        project: str | None,
        location: str,
        model_name: str,
        evidence_store: "EvidenceStore | None" = None,
        inventory_gateway: InventoryGateway | None = None,
    ) -> None:
        if not project:
            raise Unavailable("vertex_project_missing", "GOOGLE_CLOUD_PROJECT is required for Vertex ADK mode.")
        self.project = project
        self.location = location
        self.model_name = model_name
        self.evidence_store = evidence_store
        self.inventory_gateway = inventory_gateway or FixtureInventoryGateway()

    def _configure_vertex_environment(self) -> None:
        # ADK 2.8's current Vertex/enterprise selector. Keep the Gen AI SDK's
        # Vertex selector as well because the pinned Gemini model adapter reads it.
        os.environ["GOOGLE_GENAI_USE_ENTERPRISE"] = "TRUE"
        os.environ["GOOGLE_GENAI_USE_VERTEXAI"] = "true"
        os.environ["GOOGLE_CLOUD_PROJECT"] = self.project
        os.environ["GOOGLE_CLOUD_LOCATION"] = self.location

    def _request_parts(self, case: CaseRecord, candidates: list[Candidate], part_type):
        prompt = build_case_analyst_request(case, candidates)
        parts = [part_type(text=json.dumps(prompt, separators=(",", ":")))]
        if self.evidence_store is None:
            return parts
        try:
            records = self.evidence_store.list_model_authorized(case.id, case.workflow_epoch)
        except Exception as exc:
            raise Unavailable(
                "evidence_store_unavailable",
                "The analyst could not load the authorized evidence packet.",
            ) from exc
        for record in records:
            # Vertex file Parts are allowed only for explicit model-authorized GCS images.
            if record.visibility != EvidenceVisibility.MODEL_AUTHORIZED:
                continue
            if record.provenance.origin != EvidenceOrigin.DERIVED:
                continue
            if not record.storage_uri.startswith("gs://"):
                continue
            if record.mime_type not in {"image/jpeg", "image/png"}:
                continue
            parts.append(
                part_type.from_uri(
                    file_uri=record.storage_uri,
                    mime_type=record.mime_type,
                )
            )
        return parts

    def _build_agent(self, candidates: list[Candidate]):
        try:
            from google.adk.agents import LlmAgent
            from google.adk.models import Gemini
            from google.genai import types
        except ImportError as exc:  # pragma: no cover - requires optional live dependencies
            raise Unavailable(
                "adk_dependency_missing",
                "Install google-adk[gcp] and google-genai to use the live Case Analyst.",
            ) from exc

        authorized_ids = {candidate.id for candidate in candidates}
        allowed_discriminators = {
            candidate.id: candidate.restricted_attribute_id
            for candidate in candidates
        }

        def search_custodian(tenant_id: str) -> dict:
            """Read claimant-safe candidates from one authorized custodian boundary."""
            return self.inventory_gateway.search_custodian(tenant_id, candidates)

        def load_candidate(candidate_id: str) -> dict:
            """Read one candidate plus its allowed discriminator ID, never its answer."""
            loaded = self.inventory_gateway.load_candidate(candidate_id, candidates)
            if loaded.get("error"):
                return loaded
            return {
                **loaded,
                "allowed_discriminator_id": allowed_discriminators[candidate_id],
                "restricted_value_included": False,
            }

        def submit_observations(candidate_id: str, visible_signals: list[str]) -> dict:
            """Validate source-linked visible observations; this cannot mutate custody."""
            if candidate_id not in authorized_ids:
                return {"accepted": False, "reason": "candidate_not_authorized"}
            return {"accepted": True, "candidate_id": candidate_id, "signal_count": len(visible_signals)}

        def propose_discriminator(candidate_id: str, attribute_id: str, question: str) -> dict:
            """Return a non-leading question identifier; no expected answer is available to this tool."""
            if candidate_id not in authorized_ids:
                return {"accepted": False, "reason": "candidate_not_authorized"}
            if attribute_id != allowed_discriminators[candidate_id]:
                return {"accepted": False, "reason": "discriminator_not_authorized"}
            return {
                "accepted": True,
                "candidate_id": candidate_id,
                "attribute_id": attribute_id,
                "question": question,
                "expected_answer_included": False,
            }

        def request_manual_review(reason_code: str) -> dict:
            """Record a bounded review proposal; this tool cannot approve or release anything."""
            return {"review_requested": True, "reason_code": reason_code, "approved": False}

        model = Gemini(
            model=self.model_name,
            retry_options=types.HttpRetryOptions(attempts=3),
        )
        return LlmAgent(
            name="found_roll_case_analyst",
            model=model,
            mode="single_turn",
            include_contents="none",
            instruction=CASE_ANALYST_INSTRUCTION,
            tools=[
                search_custodian,
                load_candidate,
                submit_observations,
                propose_discriminator,
                request_manual_review,
            ],
            output_schema=AnalysisProposal,
        )

    def _validate_selected_inventory(
        self,
        candidate_id: str,
        candidates: list[Candidate],
    ) -> dict:
        """Recheck the selected live row before any proposal is committed."""

        selected = self.inventory_gateway.load_candidate(candidate_id, candidates)
        if selected.get("error"):
            raise Conflict(
                "agent_scope_violation",
                "The analyst selected a candidate unavailable through its authorized inventory tool.",
            )
        if selected.get("availability") != "AVAILABLE":
            raise Conflict(
                "agent_candidate_unavailable",
                "The analyst selected a candidate that is not currently available.",
            )
        return selected

    async def _analyze_async(
        self, case: CaseRecord, candidates: list[Candidate]
    ) -> tuple[str, AnalysisProposal]:
        try:
            from google.adk.agents.run_config import RunConfig
            from google.adk.runners import Runner
            from google.adk.sessions import InMemorySessionService
            from google.genai.types import Content, Part
        except ImportError as exc:  # pragma: no cover - requires optional live dependencies
            raise Unavailable(
                "adk_dependency_missing",
                "Install google-adk[gcp] and google-genai to use the live Case Analyst.",
            ) from exc

        ranked_candidates = deterministic_candidate_packet(case, candidates)
        self._configure_vertex_environment()
        run_id = f"adk-run-{uuid4().hex}"
        app_name = "found_roll_case_analyst"
        user_id = f"case:{case.id}"
        session_id = run_id
        session_service = InMemorySessionService()
        await session_service.create_session(app_name=app_name, user_id=user_id, session_id=session_id)
        runner = Runner(
            agent=self._build_agent(ranked_candidates),
            app_name=app_name,
            session_service=session_service,
        )
        final_text = ""
        async for event in runner.run_async(
            user_id=user_id,
            session_id=session_id,
            new_message=Content(
                role="user",
                parts=self._request_parts(case, ranked_candidates, Part),
            ),
            run_config=RunConfig(max_llm_calls=self.max_llm_calls),
        ):
            if event.is_final_response() and event.content:
                final_text = "".join(
                    part.text or "" for part in event.content.parts if getattr(part, "text", None)
                )
        if not final_text:
            raise Unavailable("adk_empty_response", "The live Case Analyst returned no final proposal.")
        try:
            proposal = AnalysisProposal.model_validate_json(final_text)
        except ValueError as exc:
            raise Unavailable(
                "adk_invalid_response",
                "The live Case Analyst response did not satisfy the proposal schema.",
            ) from exc
        authorized_ids = {candidate.id for candidate in ranked_candidates}
        if set(proposal.ranked_candidate_ids) - authorized_ids:
            raise Conflict("agent_scope_violation", "The analyst referenced an unauthorized candidate.")
        if proposal.selected_candidate_id and proposal.selected_candidate_id not in authorized_ids:
            raise Conflict("agent_scope_violation", "The analyst selected an unauthorized candidate.")
        if (
            len(proposal.ranked_candidate_ids) != len(authorized_ids)
            or set(proposal.ranked_candidate_ids) != authorized_ids
            or proposal.selected_candidate_id != ranked_candidates[0].id
            or proposal.ranked_candidate_ids[0] != proposal.selected_candidate_id
        ):
            raise Conflict(
                "agent_candidate_packet_invalid",
                "The analyst proposal did not preserve the custody engine's eligible candidate packet and selected winner.",
            )
        if proposal.selected_candidate_id:
            # Re-read the selected candidate through the configured live boundary.
            # This prevents a model from succeeding after skipped or failed tools.
            self._validate_selected_inventory(
                proposal.selected_candidate_id,
                ranked_candidates,
            )
            selected = next(
                candidate for candidate in ranked_candidates if candidate.id == proposal.selected_candidate_id
            )
            if proposal.restricted_attribute_id != selected.restricted_attribute_id:
                raise Conflict(
                    "agent_discriminator_invalid",
                    "The analyst proposed a discriminator outside the selected candidate's allowed private fact.",
                )
        return run_id, proposal

    def analyze(self, case: CaseRecord, candidates: list[Candidate]) -> tuple[str, AnalysisProposal]:
        return asyncio.run(self._analyze_async(case, candidates))

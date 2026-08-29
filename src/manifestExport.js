export function manifestExportPayload(demo) {
  if (!demo?.caseId || demo.state !== "CLOSED" || !demo.manifest) {
    throw new Error("A closed service manifest is required before export.");
  }
  return {
    schema_version: "1",
    case_id: demo.caseId,
    custody_state: demo.state,
    case_version: demo.version,
    manifest: demo.manifest,
    events: (demo.events || []).map((event) => ({
      id: event.id,
      sequence: event.sequence,
      type: event.type,
      actor: event.actor,
      reason: event.reason,
      occurred_at: event.occurred_at,
      previous_hash: event.previous_hash,
      event_hash: event.event_hash,
      evidence_refs: event.evidence_refs || [],
      task_id: event.task_id || null,
      model_run_id: event.model_run_id || null,
      simulator_attestation_id: event.simulator_attestation_id || null,
    })),
    disclosure: "Application-enforced internal consistency record; not proof of physical transfer.",
  };
}

export function downloadManifest(demo, documentRef = document) {
  const payload = manifestExportPayload(demo);
  const blob = new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: "application/json" });
  const objectUrl = URL.createObjectURL(blob);
  const anchor = documentRef.createElement("a");
  anchor.href = objectUrl;
  anchor.download = `found-roll-${demo.caseId.replace(/[^A-Za-z0-9._-]/g, "-")}-manifest.json`;
  anchor.click();
  URL.revokeObjectURL(objectUrl);
}

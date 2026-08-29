import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { downloadManifest, manifestExportPayload } from "../src/manifestExport.js";

test("manifest export includes only the closed service record and safe event fields", () => {
  const exported = manifestExportPayload({
    caseId: "FR-TEST-001",
    state: "CLOSED",
    version: 19,
    manifest: { id: "manifest-001", internally_consistent: true },
    claimantToken: { value: "must-not-export" },
    events: [{
      id: "evt-001",
      sequence: 1,
      type: "ITEM_PASSPORT_CREATED",
      actor: "fixture:system",
      reason: "Synthetic fixture created.",
      occurred_at: "2026-08-29T09:00:00Z",
      previous_hash: "0".repeat(64),
      event_hash: "1".repeat(64),
      evidence_refs: [],
      label: "presentation-only label",
    }],
  });

  assert.equal(exported.case_id, "FR-TEST-001");
  assert.equal(exported.manifest.internally_consistent, true);
  assert.equal(exported.events[0].type, "ITEM_PASSPORT_CREATED");
  assert.equal(exported.events[0].previous_hash, "0".repeat(64));
  assert.equal(exported.events[0].previous_event_hash, undefined);
  assert.equal(exported.events[0].label, undefined);
  assert.doesNotMatch(JSON.stringify(exported), /must-not-export/);
});

test("manifest export fails closed before the case is closed", () => {
  assert.throws(
    () => manifestExportPayload({ caseId: "FR-TEST-001", state: "RELEASED", manifest: null }),
    /closed service manifest/i,
  );
});

test("manifest download uses the safe closed payload and revokes its object URL", async () => {
  const demo = {
    caseId: "FR-TEST-001",
    state: "CLOSED",
    version: 19,
    manifest: { id: "manifest-001", internally_consistent: true },
    events: [{
      id: "evt-001",
      sequence: 1,
      type: "ITEM_PASSPORT_CREATED",
      actor: "fixture:system",
      reason: "Synthetic fixture created.",
      occurred_at: "2026-08-29T09:00:00Z",
      previous_hash: "0".repeat(64),
      event_hash: "1".repeat(64),
      evidence_refs: [],
    }],
  };
  const anchor = { href: "", download: "", clicked: false, click() { this.clicked = true; } };
  const documentRef = {
    createElement(tagName) {
      assert.equal(tagName, "a");
      return anchor;
    },
  };
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  let exportedBlob;
  let revokedUrl;
  URL.createObjectURL = (blob) => {
    exportedBlob = blob;
    return "blob:manifest-export";
  };
  URL.revokeObjectURL = (objectUrl) => {
    revokedUrl = objectUrl;
  };

  try {
    downloadManifest(demo, documentRef);
  } finally {
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }

  assert.equal(anchor.clicked, true);
  assert.equal(anchor.href, "blob:manifest-export");
  assert.equal(anchor.download, "found-roll-FR-TEST-001-manifest.json");
  assert.equal(revokedUrl, "blob:manifest-export");
  const exported = JSON.parse(await exportedBlob.text());
  assert.equal(exported.events[0].previous_hash, "0".repeat(64));
});

test("the toolbar exposes a functional manifest export only for closed cases", async () => {
  const workspaceSource = await readFile(new URL("../src/components/StaffWorkspace.jsx", import.meta.url), "utf8");
  assert.match(
    workspaceSource,
    /\{demo\.state === "CLOSED" && <ToolButton icon=\{Printer\} label="Export Manifest" onClick=\{\(\) => downloadManifest\(demo\)\} \/>\}/,
  );
  assert.equal((workspaceSource.match(/label="Export Manifest"/g) || []).length, 1);
});

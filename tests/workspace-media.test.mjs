import assert from "node:assert/strict";
import test from "node:test";

import { resolveWorkspaceMedia } from "../src/workspaceMedia.js";

test("the frozen demo case retains its owned synthetic photo library", () => {
  const media = resolveWorkspaceMedia({ caseId: "FR-20260829-0042" });
  assert.equal(media.fixture, true);
  assert.ok(media.items.length > 1);
  assert.equal(media.items[0].src, "/assets/pouch-front.jpg");
});

test("the connected frozen case prefers its current server-authorized preview over bundled fixture media", () => {
  const media = resolveWorkspaceMedia({
    caseId: "FR-20260829-0042",
    authoritativeCase: {
      assigned_tenant: "northport",
      found_at: "2026-08-29T09:42:00Z",
      found_zone: "Gate C transfer desk",
      public_description: "Black camera pouch with a red lining.",
    },
    intakeEvidence: {
      id: "evd-current-epoch-preview",
      filename: "pouch-front-preview.jpg",
      src: "blob:current-epoch-server-preview",
      displaySource: "server-derived-preview",
    },
  });

  assert.equal(media.fixture, false);
  assert.equal(media.items.length, 1);
  assert.equal(media.items[0].id, "evd-current-epoch-preview");
  assert.equal(media.items[0].src, "blob:current-epoch-server-preview");
  assert.equal(media.items.some((item) => item.src.startsWith("/assets/")), false);
});

test("an imported case exposes only its accepted intake preview in the primary workspace", () => {
  const media = resolveWorkspaceMedia({
    caseId: "FR-imported-001",
    authoritativeCase: {
      assigned_tenant: "metro-loop",
      found_at: "2026-08-29T10:00:00Z",
      found_zone: "Blue Line carriage 7",
      public_description: "Blue canvas camera bag with a brass zip.",
    },
    intakeEvidence: {
      id: "evd-preview-001",
      filename: "blue-bag.jpg",
      src: "blob:accepted-staff-preview",
      displaySource: "server-derived-preview",
    },
  });

  assert.equal(media.fixture, false);
  assert.equal(media.items.length, 1);
  assert.equal(media.items[0].id, "evd-preview-001");
  assert.equal(media.items[0].src, "blob:accepted-staff-preview");
  assert.equal(media.items[0].custodianId, "metro-loop");
  assert.equal(media.items.some((item) => item.src.startsWith("/assets/")), false);
  assert.equal(media.custodians.find((item) => item.id === "metro-loop").folders[0].count, 1);
});

test("an imported case never falls back to unrelated fixture photos when staff bytes are unavailable", () => {
  const media = resolveWorkspaceMedia({
    caseId: "FR-imported-without-tab-preview",
    authoritativeCase: {
      assigned_tenant: "northport",
      found_at: "2026-08-29T10:00:00Z",
    },
  });

  assert.equal(media.fixture, false);
  assert.deepEqual(media.items, []);
  assert.deepEqual(media.trayItems, []);
  assert.equal(media.defaultSelectedItemId, "");
});

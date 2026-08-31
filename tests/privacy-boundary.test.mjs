import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

import { resolveDemoAction } from "../src/demoController.js";
import { canNavigateSurface, claimantProofUrl, chromePolicyFor, resolveSurfaceScope } from "../src/surfaceAccess.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const restrictedFixtureValue = `${41}${18}`;

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(target) : [target];
  }));
  return nested.flat();
}

test("the restricted fixture answer and prebuilt credentials are absent from every browser source module", async () => {
  const files = await sourceFiles(path.join(projectRoot, "src"));
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  const browserSource = contents.join("\n");
  assert.equal(browserSource.includes(restrictedFixtureValue), false);
  assert.equal(browserSource.includes("found-roll://"), false);
  assert.equal(browserSource.includes("localStorage"), false);
  assert.equal(browserSource.includes("X-Found-Roll-Admin-Token"), false);
  assert.equal(browserSource.includes("/api/v1/demo/reset"), false);
});

test("the generated browser chunks do not contain the restricted fixture answer", async () => {
  const result = await build({
    root: projectRoot,
    logLevel: "silent",
    build: { write: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((row) => row.output || []);
  const browserText = outputs
    .filter((output) => output.type === "chunk" || /\.(?:html|css|js)$/.test(output.fileName))
    .map((output) => output.code || output.source?.toString() || "")
    .join("\n");
  assert.equal(browserText.includes(restrictedFixtureValue), false);
  assert.equal(outputs.some((output) => output.fileName.includes("pouch-serial-detail")), false);
});

test("the public browser build has no staff-only serial asset or source reference", async () => {
  await assert.rejects(
    access(path.join(projectRoot, "public", "assets", "pouch-serial-detail.jpg")),
    { code: "ENOENT" },
  );
  const [files, publicAssets] = await Promise.all([
    sourceFiles(path.join(projectRoot, "src")),
    readdir(path.join(projectRoot, "public", "assets")),
  ]);
  const sourceText = (await Promise.all(files.map((file) => readFile(file, "utf8")))).join("\n");
  assert.equal(sourceText.includes("pouch-serial-detail"), false);
  assert.equal(publicAssets.includes("pouch-serial-detail.jpg"), false);
});

test("staff session controls stay functional while claimant secrets remain isolated", async () => {
  const [staffWorkspace, claimantPortal] = await Promise.all([
    readFile(path.join(projectRoot, "src", "components", "StaffWorkspace.jsx"), "utf8"),
    readFile(path.join(projectRoot, "src", "components", "ClaimantPortal.jsx"), "utf8"),
  ]);

  assert.equal(staffWorkspace.includes("navigator.clipboard"), false);
  assert.match(staffWorkspace, /onSignOut=\{\(\) => void configureRuntimeCredentials\(\{\}\)\}/);
  assert.match(claimantPortal, /<input\s+id="private-answer"[^\n]*\btype="password"/);
});

test("direct claimant and relay scopes cannot navigate into staff or each other", () => {
  assert.equal(resolveSurfaceScope(""), "walkthrough");
  assert.equal(resolveSurfaceScope("?view=walkthrough"), "walkthrough");
  assert.equal(canNavigateSurface("walkthrough", "walkthrough"), true);
  assert.equal(canNavigateSurface("walkthrough", "staff"), false);

  assert.equal(resolveSurfaceScope("?view=claimant"), "claimant");
  assert.equal(canNavigateSurface("claimant", "claimant"), true);
  assert.equal(canNavigateSurface("claimant", "staff"), false);
  assert.equal(canNavigateSurface("claimant", "relay"), false);

  assert.equal(resolveSurfaceScope("?view=relay"), "relay");
  assert.equal(canNavigateSurface("relay", "relay"), true);
  assert.equal(canNavigateSurface("relay", "staff"), false);
  assert.equal(canNavigateSurface("relay", "claimant"), false);

  assert.equal(canNavigateSurface("staff", "claimant"), false);
  assert.equal(canNavigateSurface("staff", "relay"), true);
});

test("claimant proof URLs carry only case scope and a fragment token into a separate surface", () => {
  const url = new URL(claimantProofUrl(
    "https://found-roll.example.test/?view=staff&case=FR-old&utm_source=operator&claim=query-secret",
    "FR-claimant-001",
    "frcl_scoped_token",
  ));
  assert.deepEqual([...url.searchParams.keys()], ["view", "case"]);
  assert.equal(url.searchParams.get("view"), "claimant");
  assert.equal(url.searchParams.get("case"), "FR-claimant-001");
  assert.equal(url.hash, "#claim=frcl_scoped_token");
  assert.equal(url.searchParams.has("claim"), false);
});

test("public, claimant, and relay chrome policies expose no staff menu, identity, reset, or view picker", () => {
  for (const surface of ["walkthrough", "claimant", "relay"]) {
    const policy = chromePolicyFor(surface);
    assert.equal(policy.showStaffMenus, false);
    assert.equal(policy.showViewPicker, false);
    assert.equal(policy.showStaffIdentity, false);
    assert.equal(policy.showReset, false);
    assert.match(
      policy.scopeLabel,
      surface === "walkthrough" ? /public judge walkthrough/i : /no staff access/i,
    );
  }
});

test("connected actions resolve only to an authoritative hydrate action", async () => {
  const originalAction = { type: "APPROVE" };
  const serviceProjection = { authoritative: true, state: "APPROVAL_REQUIRED", version: 15 };
  const calls = [];
  const client = {
    async perform(action) {
      calls.push(action);
      return serviceProjection;
    },
  };
  const result = await resolveDemoAction({ action: originalAction, connected: true, client });
  assert.deepEqual(calls, [originalAction]);
  assert.deepEqual(result, { type: "HYDRATE_SERVICE", payload: serviceProjection });
  assert.notStrictEqual(result, originalAction);
});

test("connected intake may publish an authoritative queued projection before its final hydrate", async () => {
  const originalAction = { type: "IMPORT_INTAKE", intake: { useSyntheticFixture: true } };
  const queuedProjection = { authoritative: true, caseId: "case-queued-001", state: "ANALYZING", version: 3 };
  const finalProjection = { authoritative: true, caseId: "case-queued-001", state: "CLARIFICATION_REQUIRED", version: 5 };
  const published = [];
  const client = {
    async perform(action, { onQueuedProjection }) {
      assert.equal(action, originalAction);
      onQueuedProjection(queuedProjection);
      return finalProjection;
    },
  };

  const result = await resolveDemoAction({
    action: originalAction,
    connected: true,
    client,
    onQueuedProjection: (projection) => published.push(projection),
  });

  assert.deepEqual(published, [queuedProjection]);
  assert.deepEqual(result, { type: "HYDRATE_SERVICE", payload: finalProjection });
});

test("offline actions are blocked except for resetting the read-only fixture", async () => {
  const client = { perform: async () => assert.fail("offline mode must not call the custody service") };
  assert.deepEqual(
    await resolveDemoAction({ action: { type: "SUBMIT_CLAIM", answer: "6730" }, connected: false, client }),
    { type: "OFFLINE_ACTION_BLOCKED" },
  );
  assert.deepEqual(
    await resolveDemoAction({ action: { type: "REFRESH" }, connected: false, client }),
    { type: "RESET" },
  );
});

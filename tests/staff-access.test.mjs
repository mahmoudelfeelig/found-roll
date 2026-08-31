import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { initialDemoState } from "../src/demoMachine.js";
import { hasAuthoritativeStaffProjection } from "../src/staffAccess.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("staff projection remains locked until all runtime roles hydrate an authoritative service case", () => {
  const roles = {
    operatorTokenLoaded: true,
    staffTokenLoaded: true,
    supervisorTokenLoaded: true,
  };

  assert.equal(hasAuthoritativeStaffProjection({ demo: initialDemoState, ...roles }), false);
  assert.equal(hasAuthoritativeStaffProjection({
    demo: {
      authoritative: true,
      source: "service",
      authoritativeCase: { id: "FR-live-001" },
    },
    ...roles,
  }), true);
  assert.equal(hasAuthoritativeStaffProjection({
    demo: {
      authoritative: true,
      source: "service",
      authoritativeCase: { id: "FR-live-001" },
    },
    operatorTokenLoaded: true,
    staffTokenLoaded: true,
    supervisorTokenLoaded: false,
  }), false);
});

test("the locked staff branch contains no fixture or agent activity projection", async () => {
  const source = await readFile(path.join(projectRoot, "src", "components", "StaffWorkspace.jsx"), "utf8");
  const match = source.match(/function LockedStaffWorkspace[\s\S]*?\n}\n\nfunction AuthenticatedStaffWorkspace/);

  assert.ok(match, "expected a separate locked staff component before the authenticated workspace");
  const lockedSource = match[0];
  assert.equal(lockedSource.includes("demo."), false);
  assert.equal(lockedSource.includes("initialEvents"), false);
  assert.equal(lockedSource.includes("Gemini 3.5 Flash"), false);
  assert.equal(lockedSource.includes("Case Analyst"), false);
  assert.match(source, /if \(!staffProjectionReady\) return <LockedStaffWorkspace \{\.\.\.props\} \/>;/);
});

test("staff chrome cannot claim authentication before the projection gate passes", async () => {
  const source = await readFile(path.join(projectRoot, "src", "components", "Chrome.jsx"), "utf8");

  assert.match(source, /authenticated = false/);
  assert.match(source, /Protected staff workspace — credentials required/);
  assert.match(source, /authenticated && policy\.showViewPicker/);
  assert.match(source, /authenticated && policy\.showReset/);
  assert.match(source, /authenticated && policy\.showStaffIdentity && <button/);
});

test("anonymous visual QA verifies the locked staff shell rather than a protected intake modal", async () => {
  const source = await readFile(path.join(projectRoot, "scripts", "design-qa-capture.mjs"), "utf8");

  assert.match(source, /heading", \{ name: "Staff workspace locked" \}/);
  assert.match(source, /unauthenticated staff shell remains locked/);
  assert.match(source, /locked staff shell exposes no intake mutation/);
  assert.match(source, /locked staff shell mounts no intake modal/);
  assert.equal(source.includes("intakeTrigger.click"), false);
  assert.equal(source.includes("const lockedCreate"), false);
});

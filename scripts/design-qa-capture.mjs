import { mkdir } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";
import { createServer as createViteServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "artifacts", "design-qa");
const liveMode = Boolean(process.env.FOUND_ROLL_URL);
const configuredQaBaseUrl = process.env.FOUND_ROLL_QA_BASE_URL;
let baseUrl = process.env.FOUND_ROLL_URL || configuredQaBaseUrl || "";
const executablePath = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

const walkthroughFixture = {
  schema_version: "1",
  kind: "found-roll-judge-walkthrough",
  available: true,
  read_only: true,
  synthetic: true,
  case: {
    id: "FR-20260829-0042",
    state: "CLOSED",
    version: 19,
    category: "camera_pouch",
    risk_tier: "VALUABLE",
    reported_route_count: 3,
  },
  agentic: {
    mode: "vertex_adk",
    model_name: "gemini-3.5-flash",
    model_run_recorded: true,
    bounded_tool_step_count: 4,
  },
  passport: {
    event_count: 19,
    hash_chain_valid: true,
    manifest_id: "manifest-public-synthetic",
    final_event_hash: "a".repeat(64),
    internally_consistent: true,
    physical_transfer_proven: false,
  },
  timeline: [
    {
      sequence: 1,
      type: "RECEIVED",
      from_state: "NEW",
      to_state: "RECEIVED",
      actor_label: "synthetic fixture system",
      occurred_at: "2026-08-30T12:00:00Z",
      event_hash: "b".repeat(64),
    },
    {
      sequence: 19,
      type: "CLOSED",
      from_state: "RELEASED",
      to_state: "CLOSED",
      actor_label: "custody service",
      occurred_at: "2026-08-30T12:04:00Z",
      event_hash: "a".repeat(64),
    },
  ],
  disclosure: "This is a read-only projection of a closed synthetic case.",
};

const healthFixture = {
  service: "found-roll-custody",
  analyst_mode: "vertex_adk",
};

await mkdir(outputDir, { recursive: true });

async function findAvailableLoopbackPort() {
  const probe = createNetServer();
  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  await new Promise((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string") {
    throw new Error("Found Roll QA could not reserve a loopback port.");
  }
  return address.port;
}

async function startOwnedLocalServer() {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await findAvailableLoopbackPort();
    const server = await createViteServer({
      root,
      logLevel: "error",
      server: { host: "127.0.0.1", port, strictPort: true },
    });
    try {
      await server.listen();
      return server;
    } catch (error) {
      lastError = error;
      await server.close();
    }
  }
  throw new Error(`Found Roll QA could not start an isolated local Vite server: ${lastError?.message || "unknown error"}`);
}

// Local QA must never attach to whichever unrelated Vite server happens to own
// a common development port. An explicit QA URL remains useful for focused
// environments, while the default run owns an ephemeral Found Roll server.
let localServer = null;
if (!baseUrl) {
  localServer = await startOwnedLocalServer();
  const address = localServer.httpServer?.address();
  if (!address || typeof address === "string") {
    await localServer.close();
    throw new Error("Found Roll QA could not determine its local Vite address.");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
const report = { baseUrl, liveMode, ownedLocalServer: Boolean(localServer), screenshots: [], assertions: [], viewportChecks: [], apiRequests: [] };

function recordAssertion(label, passed, details = undefined) {
  report.assertions.push({ label, passed, ...(details === undefined ? {} : { details }) });
}

async function screenshot(name) {
  const outputPath = path.join(outputDir, name);
  await page.screenshot({ path: outputPath, fullPage: false });
  report.screenshots.push(outputPath);
}

async function go(pathname = "/") {
  await page.goto(new URL(pathname, `${baseUrl}/`).toString(), { waitUntil: "networkidle" });
}

async function confirmImagesLoaded(label) {
  const loaded = await page.waitForFunction(
    () => [...document.images].every((image) => image.complete && image.naturalWidth > 0 && image.naturalHeight > 0),
    undefined,
    { timeout: 10_000 },
  ).then(() => true).catch(() => false);
  recordAssertion(`${label}: images loaded`, loaded);
}

async function assertNoHorizontalOverflow(label) {
  const overflow = await page.evaluate(() => (
    Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) > window.innerWidth + 1
  ));
  recordAssertion(`${label}: no horizontal overflow`, !overflow);
}

async function inspectJudgeViewport(width, height, name) {
  await page.setViewportSize({ width, height });
  await go("/?view=walkthrough");
  await page.getByRole("heading", { name: "Inspect the redacted completed case" }).waitFor();
  await confirmImagesLoaded(`judge ${width}x${height}`);
  await page.getByRole("button", { name: /Refresh live record/ }).waitFor();
  await assertNoHorizontalOverflow(`judge ${width}x${height}`);
  const criticalBounds = await page.evaluate(() => {
    const selectors = [".judge-intro", ".judge-refresh", ".judge-grid", ".judge-footer"];
    return selectors.map((selector) => {
      const element = document.querySelector(selector);
      const rect = element?.getBoundingClientRect();
      return { selector, exists: Boolean(element), left: rect?.left, right: rect?.right };
    });
  });
  const inBounds = criticalBounds.every((item) => item.exists && item.left >= -1 && item.right <= width + 1);
  recordAssertion(`judge ${width}x${height}: critical regions stay in bounds`, inBounds, criticalBounds);
  report.viewportChecks.push({ width, height, view: "walkthrough", criticalBounds });
  await screenshot(name);
}

page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.pathname.startsWith("/api/")) {
    report.apiRequests.push({ method: request.method(), path: url.pathname });
  }
});

if (!liveMode) {
  await page.route("**/api/v1/healthz", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(healthFixture) });
  });
  await page.route("**/api/v1/judge-walkthrough", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(walkthroughFixture) });
  });
}

try {
  await go("/");
  await page.getByRole("heading", { name: "Inspect the redacted completed case" }).waitFor();
  await confirmImagesLoaded("public root");
  recordAssertion("public root identifies the Judge Walkthrough", await page.getByText("PUBLIC · READ-ONLY", { exact: true }).isVisible());
  recordAssertion("public root has a working read-only refresh", await page.getByRole("button", { name: "Refresh live record" }).isEnabled());
  recordAssertion("public root has no password controls", await page.locator('input[type="password"]').count() === 0);
  recordAssertion("public root has no staff menu", await page.getByText("Authenticated staff", { exact: false }).count() === 0);
  recordAssertion("public root has no protected mutation CTA", await page.getByRole("button", { name: /Issue & Open Separate Claimant Link|Create passport & analyze|Approve Valuable Item/ }).count() === 0);
  const publicText = await page.locator("body").innerText();
  const forbiddenPublicText = ["pouch-serial-detail", "4118", "staff.northport", "supervisor.northport", "claimant_token", "custodian_token", "trace_id"];
  recordAssertion("public projection is redacted", forbiddenPublicText.every((value) => !publicText.includes(value)), forbiddenPublicText.filter((value) => publicText.includes(value)));
  if (liveMode) {
    const removedAssetStatus = await page.evaluate(async () => {
      const response = await fetch("/assets/pouch-serial-detail.jpg", { cache: "no-store" });
      return response.status;
    });
    recordAssertion("removed public serial asset returns 404", removedAssetStatus === 404, { status: removedAssetStatus });
  }
  await screenshot("judge-1440x960.png");

  const beforeRefreshCount = report.apiRequests.filter((request) => request.path === "/api/v1/judge-walkthrough").length;
  await page.getByRole("button", { name: "Refresh live record" }).click();
  await page.waitForTimeout(100);
  const afterRefreshCount = report.apiRequests.filter((request) => request.path === "/api/v1/judge-walkthrough").length;
  recordAssertion("judge refresh uses its public read-only endpoint", afterRefreshCount > beforeRefreshCount);
  const protectedRequest = report.apiRequests.some((request) => request.method !== "GET" || !["/api/v1/healthz", "/api/v1/judge-walkthrough"].includes(request.path));
  recordAssertion("judge surface made no protected or mutating API request", !protectedRequest, report.apiRequests);

  await inspectJudgeViewport(900, 800, "judge-900x800.png");
  await inspectJudgeViewport(390, 844, "judge-390x844.png");

  await page.setViewportSize({ width: 1440, height: 960 });
  await go("/?view=staff");
  await page.getByRole("heading", { name: "Staff workspace locked" }).waitFor();
  recordAssertion("unauthenticated staff shell remains locked", await page.getByText("AUTHORITATIVE PROJECTION REQUIRED", { exact: true }).isVisible());
  recordAssertion("locked staff shell exposes no intake mutation", await page.getByRole("button", { name: "Import Intake" }).count() === 0);
  recordAssertion("locked staff shell exposes no case or agent activity", (
    await page.getByText(/Case Analyst|Item Passport|Candidate packet/i).count()
  ) === 0);
  recordAssertion("locked staff shell mounts no intake modal", await page.locator("dialog.intake-dialog").count() === 0);
  await screenshot("staff-locked-1440x960.png");

  await page.setViewportSize({ width: 900, height: 800 });
  await go("/?view=staff");
  recordAssertion("narrow staff workspace discloses workstation requirement", await page.getByText(/optimized for a 1120px\+ workstation/i).isVisible());
} finally {
  await browser.close();
  await localServer?.close();
}

const failures = report.assertions.filter((item) => !item.passed);
process.stdout.write(`${JSON.stringify({ ...report, passed: failures.length === 0 }, null, 2)}\n`);
if (failures.length) process.exitCode = 1;

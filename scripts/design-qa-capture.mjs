import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "..");
const outputDir = path.join(root, "artifacts", "design-qa");
const baseUrl = process.env.FOUND_ROLL_URL || "http://127.0.0.1:5173";
const executablePath = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";

await mkdir(outputDir, { recursive: true });

const browser = await chromium.launch({ executablePath, headless: true });
const page = await browser.newPage({ viewport: { width: 1488, height: 1058 }, deviceScaleFactor: 1 });
const report = { baseUrl, screenshots: [], assertions: [], viewportChecks: [] };

async function screenshot(name) {
  const outputPath = path.join(outputDir, name);
  await page.screenshot({ path: outputPath, fullPage: false });
  report.screenshots.push(outputPath);
}

async function assertVisible(role, name, label = name) {
  const locator = page.getByRole(role, { name });
  const visible = await locator.isVisible();
  report.assertions.push({ label, passed: visible });
  if (!visible) throw new Error(`Expected visible: ${label}`);
  return locator;
}

async function inspectViewport(width, height, view) {
  await page.setViewportSize({ width, height });
  await page.goto(`${baseUrl}/?view=${view}`, { waitUntil: "networkidle" });
  const result = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    const visibleButtons = [...document.querySelectorAll("button")].filter((element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== "hidden" && style.display !== "none" && rect.width > 0 && rect.height > 0;
    });
    const hasScrollableAncestor = (element) => {
      let parent = element.parentElement;
      while (parent && parent !== document.body) {
        const style = getComputedStyle(parent);
        if (["auto", "scroll"].includes(style.overflowY) && parent.scrollHeight > parent.clientHeight) return true;
        parent = parent.parentElement;
      }
      return root.scrollHeight > window.innerHeight && getComputedStyle(body).overflowY !== "hidden";
    };
    const clippedControls = visibleButtons.filter((element) => {
      const rect = element.getBoundingClientRect();
      const verticallyInaccessible = (rect.bottom > window.innerHeight + 1 || rect.top < -1) && !hasScrollableAncestor(element);
      return rect.right > window.innerWidth + 1 || rect.left < -1 || verticallyInaccessible;
    }).map((element) => element.textContent.trim().slice(0, 60));
    return {
      horizontalOverflow: Math.max(root.scrollWidth, body.scrollWidth) > window.innerWidth,
      verticalOverflow: Math.max(root.scrollHeight, body.scrollHeight) > window.innerHeight,
      clippedControls,
    };
  });
  report.viewportChecks.push({ width, height, view, ...result });
}

await page.goto(`${baseUrl}/?view=staff`, { waitUntil: "networkidle" });
await page.getByRole("button", { name: "Reset demo" }).click();
await assertVisible("button", "Open Claimant Proof");
await screenshot("staff-initial-1488x1058.png");

await page.getByRole("button", { name: "Open Claimant Proof" }).click();
await assertVisible("heading", "One private detail can resolve this match");
await screenshot("claimant-proof-1488x1058.png");
await page.getByLabel("What are the last four digits of the lens serial inside the pouch?").fill("4118");
await page.getByRole("button", { name: "Submit private answer" }).click();
await assertVisible("heading", "Your evidence matched the staff-only record", "correct private evidence accepted");
await page.getByRole("button", { name: "Return to staff workspace" }).click();

await page.getByRole("button", { name: "Record Identity Attestation" }).click();
await assertVisible("button", "Approve Valuable Item");
await page.getByRole("button", { name: "Approve Valuable Item" }).click();
await assertVisible("button", "Reserve SIMULATED Relay");
await page.getByRole("button", { name: "Reserve SIMULATED Relay" }).click();
await assertVisible("button", "Open Relay Terminal");
await screenshot("staff-reserved-1488x1058.png");
await page.getByRole("button", { name: "Open Relay Terminal" }).click();

await assertVisible("button", "Present custodian credential");
await page.getByRole("button", { name: "Present custodian credential" }).click();
await page.getByRole("button", { name: "Present claimant credential" }).click();
await assertVisible("button", "Send simulated handoff callback");
await page.getByRole("button", { name: "Send simulated handoff callback" }).click();
await assertVisible("button", "Replay callback (must be idempotent)");
await page.getByRole("button", { name: "Replay callback (must be idempotent)" }).click();
await page.getByText("DUPLICATE CALLBACK ACKNOWLEDGED · NO NEW EVENT", { exact: true }).waitFor();
report.assertions.push({ label: "duplicate callback acknowledged idempotently", passed: true });
await screenshot("relay-closed-1488x1058.png");

await inspectViewport(1280, 800, "staff");
await inspectViewport(1120, 720, "staff");
await inspectViewport(900, 800, "claimant");
await inspectViewport(900, 800, "relay");
await inspectViewport(390, 844, "claimant");
await inspectViewport(390, 844, "relay");

await browser.close();

const failures = report.assertions.filter((item) => !item.passed);
process.stdout.write(`${JSON.stringify({ ...report, passed: failures.length === 0 }, null, 2)}\n`);

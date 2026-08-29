import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createFrontendBuildManifest,
  prepareSitesBuild,
} from "../scripts/prepare-sites-build.mjs";

async function makeFixtureProject(t) {
  const projectRoot = await mkdtemp(path.join(tmpdir(), "found-roll-frontend-manifest-"));
  t.after(() => rm(projectRoot, { recursive: true, force: true }));
  await Promise.all([
    mkdir(path.join(projectRoot, "dist", "client", "assets", "nested"), { recursive: true }),
    mkdir(path.join(projectRoot, "worker"), { recursive: true }),
    mkdir(path.join(projectRoot, ".openai"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(path.join(projectRoot, "worker", "index.js"), "export default {};\n"),
    writeFile(path.join(projectRoot, ".openai", "hosting.json"), "{\"entrypoint\":\"dist/server/index.js\"}\n"),
  ]);
  return projectRoot;
}

test("writes a deterministic manifest for every regular frontend build file", async (t) => {
  const projectRoot = await makeFixtureProject(t);
  const contents = new Map([
    ["dist/client/index.html", Buffer.from("<!doctype html><title>Found Roll</title>\n")],
    ["dist/client/assets/app.js", Buffer.from("console.log('found-roll');\n")],
    ["dist/client/assets/nested/logo.bin", Buffer.from([0, 1, 2, 255])],
  ]);
  const expectedSha256 = new Map([
    ["dist/client/index.html", "40fa7f968b75138c5be4314a79d3c6f6d74726e9a183d3375a88d0b30333f3c3"],
    ["dist/client/assets/app.js", "b310fc30dd40f6116965254daada6e9684bafbcaa56111ebf86ac8314a524a7f"],
    ["dist/client/assets/nested/logo.bin", "3d1f57c984978ef98a18378c8166c1cb8ede02c03eeb6aee7e2f121dfeee3e56"],
  ]);
  await Promise.all([...contents].map(([relativePath, content]) => (
    writeFile(path.join(projectRoot, ...relativePath.split("/")), content)
  )));

  const first = prepareSitesBuild({ projectRoot });
  const manifestPath = path.join(projectRoot, "artifacts", "verification", "frontend-build-manifest.json");
  const firstBytes = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(firstBytes);
  const expectedFiles = [...contents]
    .map(([relativePath, content]) => ({
      path: relativePath,
      bytes: content.byteLength,
      sha256: expectedSha256.get(relativePath),
    }))
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  assert.deepEqual(first.manifest, manifest);
  assert.deepEqual(manifest, {
    schema_version: "1",
    kind: "found-roll-frontend-build",
    entrypoint: "dist/client/index.html",
    file_count: expectedFiles.length,
    total_bytes: expectedFiles.reduce((total, file) => total + file.bytes, 0),
    files: expectedFiles,
  });
  assert.equal(firstBytes.endsWith("\n"), true);
  assert.equal(firstBytes.includes("timestamp"), false);
  assert.equal(await readFile(path.join(projectRoot, "dist", "server", "index.js"), "utf8"), "export default {};\n");

  prepareSitesBuild({ projectRoot });
  assert.equal(await readFile(manifestPath, "utf8"), firstBytes);
});

test("rejects symbolic links anywhere in the frontend build tree", async (t) => {
  const projectRoot = await makeFixtureProject(t);
  await writeFile(path.join(projectRoot, "dist", "client", "index.html"), "<!doctype html>\n");
  const outsideDirectory = path.join(projectRoot, "outside-assets");
  await mkdir(outsideDirectory);
  await writeFile(path.join(outsideDirectory, "escaped.js"), "must not be packaged\n");
  try {
    await symlink(
      outsideDirectory,
      path.join(projectRoot, "dist", "client", "linked-assets"),
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("The current Windows account cannot create a test junction.");
      return;
    }
    throw error;
  }

  assert.throws(
    () => createFrontendBuildManifest({ projectRoot }),
    /symbolic link/i,
  );
});

test("rejects an unsupported non-directory frontend build root", async (t) => {
  const projectRoot = await makeFixtureProject(t);
  await rm(path.join(projectRoot, "dist", "client"), { recursive: true, force: true });
  await writeFile(path.join(projectRoot, "dist", "client"), "not a directory\n");

  assert.throws(
    () => createFrontendBuildManifest({ projectRoot }),
    /dist\/client must be a directory/i,
  );
});

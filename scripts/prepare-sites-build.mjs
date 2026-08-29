#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptPath), "..");
const frontendEntrypoint = "dist/client/index.html";
const manifestRelativePath = "artifacts/verification/frontend-build-manifest.json";

function validatePathSegment(segment, displayPath) {
  if (
    !segment
    || segment === "."
    || segment === ".."
    || /[\\/\u0000-\u001f\u007f]/u.test(segment)
  ) {
    throw new Error(`Unsupported Sites build path: ${displayPath}`);
  }
}

function repoRelativePath(projectRoot, absolutePath) {
  const relative = path.relative(projectRoot, path.resolve(absolutePath));
  if (
    !relative
    || path.isAbsolute(relative)
    || relative === ".."
    || relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("Unsupported Sites build path outside the project root.");
  }
  const segments = relative.split(path.sep);
  const displayPath = segments.join("/");
  for (const segment of segments) validatePathSegment(segment, displayPath);
  return displayPath;
}

function requireProjectDirectory(projectRoot) {
  const resolvedRoot = path.resolve(projectRoot);
  if (!existsSync(resolvedRoot)) throw new Error("Sites project root does not exist.");
  const rootStat = lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("Sites project root must be a regular directory, not a symbolic link.");
  }
  return resolvedRoot;
}

function ensureSupportedDirectory(projectRoot, directoryPath, { create = false } = {}) {
  const relative = repoRelativePath(projectRoot, directoryPath);
  let current = projectRoot;
  for (const segment of relative.split("/")) {
    current = path.join(current, segment);
    if (!existsSync(current)) {
      if (!create) throw new Error(`${relative} must be a directory.`);
      mkdirSync(current);
      continue;
    }
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) {
      throw new Error(`Sites build directories must not be symbolic links: ${relative}`);
    }
    if (!stat.isDirectory()) throw new Error(`${relative} must be a directory.`);
  }
}

function requireRegularFile(projectRoot, filePath) {
  const relative = repoRelativePath(projectRoot, filePath);
  if (!existsSync(filePath)) throw new Error(`Missing Sites build input: ${relative}`);
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Sites build files must not be symbolic links: ${relative}`);
  }
  if (!stat.isFile()) throw new Error(`Unsupported Sites build path type: ${relative}`);
}

function requireWritableRegularFile(projectRoot, filePath) {
  const relative = repoRelativePath(projectRoot, filePath);
  if (!existsSync(filePath)) return;
  const stat = lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new Error(`Sites build outputs must not be symbolic links: ${relative}`);
  }
  if (!stat.isFile()) throw new Error(`Unsupported Sites build output path type: ${relative}`);
}

function collectFrontendFiles(projectRoot, clientRoot) {
  const candidates = [];

  function visit(directoryPath) {
    const names = readdirSync(directoryPath);
    names.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
    for (const name of names) {
      const absolutePath = path.join(directoryPath, name);
      const relativePath = repoRelativePath(projectRoot, absolutePath);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Frontend build must not contain symbolic links: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        visit(absolutePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Unsupported frontend build path type: ${relativePath}`);
      }
      candidates.push({ path: relativePath, absolutePath });
    }
  }

  visit(clientRoot);
  candidates.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);

  const exactPaths = new Set();
  const caseFoldedPaths = new Set();
  for (const candidate of candidates) {
    const foldedPath = candidate.path.toLowerCase();
    if (exactPaths.has(candidate.path) || caseFoldedPaths.has(foldedPath)) {
      throw new Error(`Unsupported duplicate or case-colliding frontend build path: ${candidate.path}`);
    }
    exactPaths.add(candidate.path);
    caseFoldedPaths.add(foldedPath);
  }

  return candidates.map(({ path: relativePath, absolutePath }) => {
    const content = readFileSync(absolutePath);
    return {
      path: relativePath,
      bytes: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
}

export function createFrontendBuildManifest({ projectRoot = defaultRoot } = {}) {
  const root = requireProjectDirectory(projectRoot);
  const clientRoot = path.join(root, "dist", "client");
  ensureSupportedDirectory(root, clientRoot);
  const files = collectFrontendFiles(root, clientRoot);
  if (!files.some((file) => file.path === frontendEntrypoint)) {
    throw new Error(`Missing Sites build input: ${frontendEntrypoint}`);
  }

  return {
    schema_version: "1",
    kind: "found-roll-frontend-build",
    entrypoint: frontendEntrypoint,
    file_count: files.length,
    total_bytes: files.reduce((total, file) => total + file.bytes, 0),
    files,
  };
}

export function writeFrontendBuildManifest({ projectRoot = defaultRoot } = {}) {
  const root = requireProjectDirectory(projectRoot);
  const manifest = createFrontendBuildManifest({ projectRoot: root });
  const manifestPath = path.join(root, ...manifestRelativePath.split("/"));
  ensureSupportedDirectory(root, path.dirname(manifestPath), { create: true });
  requireWritableRegularFile(root, manifestPath);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { manifest, manifestPath };
}

export function prepareSitesBuild({ projectRoot = defaultRoot } = {}) {
  const root = requireProjectDirectory(projectRoot);
  const index = path.join(root, "dist", "client", "index.html");
  const worker = path.join(root, "worker", "index.js");
  const hosting = path.join(root, ".openai", "hosting.json");
  const serverDirectory = path.join(root, "dist", "server");
  const hostingDirectory = path.join(root, "dist", ".openai");
  const serverOutput = path.join(serverDirectory, "index.js");
  const hostingOutput = path.join(hostingDirectory, "hosting.json");

  ensureSupportedDirectory(root, path.dirname(index));
  ensureSupportedDirectory(root, path.dirname(worker));
  ensureSupportedDirectory(root, path.dirname(hosting));
  for (const file of [index, worker, hosting]) requireRegularFile(root, file);

  ensureSupportedDirectory(root, serverDirectory, { create: true });
  ensureSupportedDirectory(root, hostingDirectory, { create: true });
  requireWritableRegularFile(root, serverOutput);
  requireWritableRegularFile(root, hostingOutput);
  copyFileSync(worker, serverOutput);
  copyFileSync(hosting, hostingOutput);

  return writeFrontendBuildManifest({ projectRoot: root });
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const { manifest } = prepareSitesBuild();
  console.log(
    `Prepared Sites build and deterministic ${manifest.file_count}-file frontend manifest.`,
  );
}

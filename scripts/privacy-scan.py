"""Scan publication artifacts without echoing canary or matched values.

Canaries are supplied as SHA-256 digests plus exact character lengths. The
scanner hashes same-length windows from text artifacts, so raw canary values do
not need to appear in the manifest, report, or console output.
"""

from __future__ import annotations

import argparse
from collections import Counter
import fnmatch
import hashlib
import json
from pathlib import Path
import re
import sys
from typing import Any, Iterable


DEFAULT_EXTENSIONS = {
    ".cjs",
    ".css",
    ".csv",
    ".cts",
    ".html",
    ".js",
    ".jsx",
    ".json",
    ".jsonl",
    ".log",
    ".map",
    ".md",
    ".mmd",
    ".mjs",
    ".mts",
    ".py",
    ".svg",
    ".toml",
    ".txt",
    ".ts",
    ".tsx",
    ".xml",
    ".yaml",
    ".yml",
}
MAX_RECORDED_FINDINGS = 500


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Scan text publication artifacts using digest-only canaries and named patterns."
    )
    parser.add_argument("--root", action="append", required=True, type=Path, help="File or directory to scan; repeatable.")
    parser.add_argument("--canary-manifest", required=True, type=Path, help="Digest-only JSON canary and pattern manifest.")
    parser.add_argument("--output", required=True, type=Path, help="JSON report destination.")
    parser.add_argument("--exclude", action="append", default=[], help="Glob relative to each scan root; repeatable.")
    parser.add_argument("--max-file-bytes", type=int, default=5_000_000)
    parser.add_argument("--canaries-only", action="store_true", help="Disable named patterns; useful for technical docs that quote pattern names.")
    parser.add_argument("--fail-on-findings", action="store_true")
    return parser.parse_args(argv)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def portable_path(path: Path) -> str:
    resolved = path.resolve()
    try:
        return resolved.relative_to(Path.cwd().resolve()).as_posix()
    except ValueError:
        return str(resolved)


def load_manifest(path: Path) -> dict[str, Any]:
    manifest = json.loads(path.read_text(encoding="utf-8"))
    canaries = manifest.get("canaries", [])
    patterns = manifest.get("patterns", [])
    if not isinstance(canaries, list) or not isinstance(patterns, list):
        raise ValueError("Canary manifest must contain list fields named canaries and patterns.")
    seen_ids: set[str] = set()
    for item in [*canaries, *patterns]:
        item_id = item.get("id") if isinstance(item, dict) else None
        if not isinstance(item_id, str) or not item_id or item_id in seen_ids:
            raise ValueError("Every canary and pattern requires one unique non-empty id.")
        seen_ids.add(item_id)
    for canary in canaries:
        digest = canary.get("sha256")
        length = canary.get("length")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-fA-F]{64}", digest):
            raise ValueError("Every canary requires a 64-character SHA-256 digest.")
        if not isinstance(length, int) or length < 1 or length > 4096:
            raise ValueError("Every canary requires an exact character length from 1 to 4096.")
    for pattern in patterns:
        expression = pattern.get("regex")
        if not isinstance(expression, str) or not expression:
            raise ValueError("Every named pattern requires a regex string.")
        re.compile(expression)
    return manifest


def iter_files(
    roots: Iterable[Path],
    excludes: list[str],
    output: Path,
    manifest: Path,
) -> Iterable[tuple[Path, str, bool]]:
    excluded_exact = {output.resolve(), manifest.resolve()}
    for root in roots:
        root = root.resolve()
        candidates = [root] if root.is_file() else root.rglob("*") if root.is_dir() else []
        for path in candidates:
            if not path.is_file() or path.resolve() in excluded_exact:
                continue
            try:
                relative = path.relative_to(root).as_posix() if root.is_dir() else path.name
            except ValueError:
                relative = path.name
            if any(fnmatch.fnmatch(relative, pattern) for pattern in excludes):
                continue
            label = f"{root.name}/{relative}" if root.is_dir() else relative
            yield path, label, path.suffix.lower() in DEFAULT_EXTENSIONS


def line_column(text: str, index: int) -> tuple[int, int]:
    line = text.count("\n", 0, index) + 1
    previous_newline = text.rfind("\n", 0, index)
    column = index + 1 if previous_newline < 0 else index - previous_newline
    return line, column


def record_finding(
    findings: list[dict[str, Any]],
    counts: Counter[str],
    *,
    rule_id: str,
    kind: str,
    file_label: str,
    text: str,
    index: int,
) -> None:
    counts[rule_id] += 1
    if len(findings) >= MAX_RECORDED_FINDINGS:
        return
    line, column = line_column(text, index)
    findings.append(
        {
            "rule_id": rule_id,
            "kind": kind,
            "file": file_label,
            "line": line,
            "column": column,
        }
    )


def scan_text(
    text: str,
    file_label: str,
    canaries: list[dict[str, Any]],
    compiled_patterns: list[tuple[str, re.Pattern[str]]],
    findings: list[dict[str, Any]],
    counts: Counter[str],
) -> None:
    by_length: dict[int, dict[str, list[str]]] = {}
    for canary in canaries:
        by_length.setdefault(canary["length"], {}).setdefault(canary["sha256"].lower(), []).append(canary["id"])
    for length, digest_to_ids in by_length.items():
        if len(text) < length:
            continue
        for index in range(0, len(text) - length + 1):
            window_digest = hashlib.sha256(text[index : index + length].encode("utf-8")).hexdigest()
            for canary_id in digest_to_ids.get(window_digest, []):
                record_finding(
                    findings,
                    counts,
                    rule_id=canary_id,
                    kind="digest_canary",
                    file_label=file_label,
                    text=text,
                    index=index,
                )
    for pattern_id, pattern in compiled_patterns:
        for match in pattern.finditer(text):
            record_finding(
                findings,
                counts,
                rule_id=pattern_id,
                kind="named_pattern",
                file_label=file_label,
                text=text,
                index=match.start(),
            )


def run_scan(
    *,
    roots: list[Path],
    manifest_path: Path,
    output_path: Path,
    excludes: list[str] | None = None,
    max_file_bytes: int = 5_000_000,
    canaries_only: bool = False,
) -> dict[str, Any]:
    excludes = excludes or []
    manifest = load_manifest(manifest_path)
    compiled_patterns = [] if canaries_only else [
        (item["id"], re.compile(item["regex"])) for item in manifest.get("patterns", [])
    ]
    findings: list[dict[str, Any]] = []
    counts: Counter[str] = Counter()
    scanned_files = 0
    scanned_bytes = 0
    skipped_large = 0
    unsupported_files = 0
    unsupported_extensions: Counter[str] = Counter()
    decode_replacements = 0
    for path, file_label, supported in iter_files(roots, excludes, output_path, manifest_path):
        if not supported:
            unsupported_files += 1
            unsupported_extensions[path.suffix.lower() or "[no extension]"] += 1
            continue
        size = path.stat().st_size
        if size > max_file_bytes:
            skipped_large += 1
            continue
        raw = path.read_bytes()
        text = raw.decode("utf-8", errors="replace")
        decode_replacements += text.count("\ufffd")
        scanned_files += 1
        scanned_bytes += size
        scan_text(
            text,
            file_label,
            manifest.get("canaries", []),
            compiled_patterns,
            findings,
            counts,
        )
    total_findings = sum(counts.values())
    report = {
        "schema_version": "1.0",
        "status": "PASS" if total_findings == 0 and skipped_large == 0 else "FAIL" if total_findings else "INCOMPLETE",
        "scope": [portable_path(path) for path in roots],
        "manifest_sha256": file_sha256(manifest_path),
        "canary_count": len(manifest.get("canaries", [])),
        "pattern_count": len(compiled_patterns),
        "scanned_file_count": scanned_files,
        "scanned_byte_count": scanned_bytes,
        "skipped_large_file_count": skipped_large,
        "unsupported_file_count": unsupported_files,
        "unsupported_extensions": dict(sorted(unsupported_extensions.items())),
        "decode_replacement_count": decode_replacements,
        "finding_count": total_findings,
        "findings_by_rule": dict(sorted(counts.items())),
        "recorded_findings": findings,
        "finding_values_included": False,
        "disclosure": "This is a UTF-8 text scan. Unsupported binary files are counted but not content-scanned. Findings contain rule IDs and locations only; canary and matched values are never written or printed.",
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    report = run_scan(
        roots=args.root,
        manifest_path=args.canary_manifest,
        output_path=args.output,
        excludes=args.exclude,
        max_file_bytes=args.max_file_bytes,
        canaries_only=args.canaries_only,
    )
    console = {
        "status": report["status"],
        "scanned_file_count": report["scanned_file_count"],
        "skipped_large_file_count": report["skipped_large_file_count"],
        "unsupported_file_count": report["unsupported_file_count"],
        "finding_count": report["finding_count"],
        "findings_by_rule": report["findings_by_rule"],
        "finding_values_included": False,
        "output": str(args.output.resolve()),
    }
    print(json.dumps(console, indent=2, sort_keys=True))
    if args.fail_on_findings and report["status"] != "PASS":
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

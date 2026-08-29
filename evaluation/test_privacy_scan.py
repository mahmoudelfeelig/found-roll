from __future__ import annotations

from contextlib import redirect_stdout
import importlib.util
import io
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "privacy-scan.py"
FIXTURES = ROOT / "evaluation" / "privacy-fixtures"
RAW_TEST_CANARY = "FR-LEAK-CANARY-7Q2M9X"


def load_scanner():
    spec = importlib.util.spec_from_file_location("found_roll_privacy_scan", SCRIPT)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_clean_publication_fixture_passes(tmp_path):
    scanner = load_scanner()
    output = tmp_path / "clean-report.json"
    report = scanner.run_scan(
        roots=[FIXTURES / "clean"],
        manifest_path=FIXTURES / "canaries.json",
        output_path=output,
    )
    assert report["status"] == "PASS"
    assert report["finding_count"] == 0
    assert RAW_TEST_CANARY not in output.read_text(encoding="utf-8")


def test_binary_file_is_reported_as_unsupported(tmp_path):
    scanner = load_scanner()
    fixture_root = tmp_path / "mixed-publication"
    fixture_root.mkdir()
    (fixture_root / "view.json").write_text('{"status":"safe"}\n', encoding="utf-8")
    (fixture_root / "capture.png").write_bytes(b"\x89PNG\r\n\x1a\nsynthetic-test-bytes")
    output = tmp_path / "mixed-report.json"
    report = scanner.run_scan(
        roots=[fixture_root],
        manifest_path=FIXTURES / "canaries.json",
        output_path=output,
    )
    assert report["status"] == "PASS"
    assert report["scanned_file_count"] == 1
    assert report["unsupported_file_count"] == 1
    assert report["unsupported_extensions"] == {".png": 1}


def test_source_and_mermaid_text_extensions_are_scanned(tmp_path):
    scanner = load_scanner()
    fixture_root = tmp_path / "text-publication"
    fixture_root.mkdir()
    (fixture_root / "view.jsx").write_text("export const status = 'safe';\n", encoding="utf-8")
    (fixture_root / "architecture.mmd").write_text("flowchart LR\nA --> B\n", encoding="utf-8")
    output = tmp_path / "text-report.json"
    report = scanner.run_scan(
        roots=[fixture_root],
        manifest_path=FIXTURES / "canaries.json",
        output_path=output,
    )
    assert report["status"] == "PASS"
    assert report["scanned_file_count"] == 2
    assert report["unsupported_file_count"] == 0


def test_leaky_fixture_is_detected_without_value_echo(tmp_path):
    scanner = load_scanner()
    output = tmp_path / "leak-report.json"
    stdout = io.StringIO()
    with redirect_stdout(stdout):
        exit_code = scanner.main(
            [
                "--root",
                str(FIXTURES / "leaky"),
                "--canary-manifest",
                str(FIXTURES / "canaries.json"),
                "--output",
                str(output),
                "--fail-on-findings",
            ]
        )
    report_text = output.read_text(encoding="utf-8")
    report = json.loads(report_text)
    assert exit_code == 1
    assert report["status"] == "FAIL"
    assert report["findings_by_rule"]["self-test-restricted-canary"] == 1
    assert report["findings_by_rule"]["embedded-demo-credential-uri"] == 1
    assert report["finding_values_included"] is False
    assert RAW_TEST_CANARY not in report_text
    assert RAW_TEST_CANARY not in stdout.getvalue()

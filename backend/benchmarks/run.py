from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

BENCHMARK_DIRECTORY = Path(__file__).resolve().parent
BACKEND_DIRECTORY = BENCHMARK_DIRECTORY.parent
MANIFEST_PATH = BENCHMARK_DIRECTORY / "capability-benchmarks.json"
CASE_TIMEOUT_SECONDS = 180


def run_case(case: dict[str, Any]) -> dict[str, Any]:
    selectors = case.get("selectors")
    if not isinstance(selectors, list) or not all(
        isinstance(selector, str) for selector in selectors
    ):
        raise ValueError(f"Benchmark {case.get('id', '<unknown>')} has invalid selectors")
    started = time.perf_counter()
    result = subprocess.run(
        [sys.executable, "-m", "pytest", "-q", *selectors],
        cwd=BACKEND_DIRECTORY,
        capture_output=True,
        check=False,
        text=True,
        timeout=CASE_TIMEOUT_SECONDS,
    )
    duration_seconds = round(time.perf_counter() - started, 3)
    output = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
    return {
        "id": case["id"],
        "description": case["description"],
        "passed": result.returncode == 0,
        "duration_seconds": duration_seconds,
        "selectors": selectors,
        "evidence": output[-4_000:],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run deterministic MAF harness benchmarks.")
    parser.add_argument("--output", type=Path, help="Optional path for the JSON report.")
    arguments = parser.parse_args()
    manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    cases = manifest.get("cases")
    if not isinstance(cases, list):
        raise ValueError("Benchmark manifest must contain a cases list")

    results = [run_case(case) for case in cases]
    report = {
        "schema_version": 1,
        "suite": manifest["suite"],
        "passed": all(result["passed"] for result in results),
        "passed_cases": sum(result["passed"] for result in results),
        "total_cases": len(results),
        "cases": results,
    }
    rendered = json.dumps(report, indent=2)
    if arguments.output:
        arguments.output.parent.mkdir(parents=True, exist_ok=True)
        arguments.output.write_text(f"{rendered}\n", encoding="utf-8")
    print(rendered)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())

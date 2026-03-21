"""lm-eval benchmark runner for the closed-loop evaluation step.

Benchmarks run in an isolated subprocess so that the CUDA context
(and all VRAM) is fully released when evaluation completes.
"""
from __future__ import annotations

import json
import logging
import multiprocessing
import tempfile
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


def compute_gate_score(scores: dict[str, float]) -> float:
    """Return the simple average of all benchmark scores.

    The ``"average"`` key is excluded so that a previously stored average
    does not skew the result.
    """
    values = [v for k, v in scores.items() if k != "average"]
    if not values:
        return 0.0
    return sum(values) / len(values)


def extract_per_question_results(raw_results: dict) -> list[dict]:
    """Extract per-question pass/fail records from an lm-eval log_samples output.

    lm-eval structure::

        raw_results["samples"][task_name] -> list of sample dicts, each with:
            "doc"           -- contains "question" or "input"
            "target"        -- correct answer string
            "filtered_resps"-- list of (response, score) tuples
            "acc"           -- 1 (pass) or 0 (fail)

    Returns a list of dicts with keys:
        "task", "question", "model_answer", "correct_answer", "passed"
    """
    records: list[dict] = []
    samples_by_task: dict[str, list[dict]] = raw_results.get("samples", {})

    for task_name, samples in samples_by_task.items():
        for sample in samples:
            doc: dict = sample.get("doc", {})
            question: str = doc.get("question") or doc.get("input", "")

            filtered_resps: list = sample.get("filtered_resps", [])
            if filtered_resps and filtered_resps[0]:
                model_answer = filtered_resps[0][0]
            else:
                model_answer = ""

            records.append(
                {
                    "task": task_name,
                    "question": question,
                    "model_answer": model_answer,
                    "correct_answer": sample.get("target", ""),
                    "passed": bool(sample.get("acc", 0)),
                }
            )

    return records


def _benchmark_worker(
    model_path: str,
    suites: list[str],
    batch_size: int,
    results_file: str,
) -> None:
    """Run benchmarks in an isolated process. Writes results to a JSON file.

    When this function returns (or crashes), the process exits and ALL VRAM
    is released -- including the CUDA context itself.
    """
    import gc
    import json as _json

    import torch
    from lm_eval import evaluator
    from lm_eval.models.huggingface import HFLM

    torch.cuda.empty_cache()
    gc.collect()

    log = logging.getLogger(__name__)
    log.info("Loading model %s for benchmarking (dtype=float16)", model_path)
    model = HFLM(
        pretrained=model_path,
        batch_size=batch_size,
        dtype="float16",
        device="cuda",
    )

    try:
        log.info("Running suites: %s", suites)
        raw_results = evaluator.simple_evaluate(
            model=model,
            tasks=suites,
            log_samples=True,
        )
    finally:
        del model
        torch.cuda.empty_cache()
        gc.collect()
        log.info("Model deleted -- VRAM freed")

    # Extract scores
    scores: dict[str, float] = {}
    task_results: dict = raw_results.get("results", {})
    for task_name, metrics in task_results.items():
        if "acc_norm,none" in metrics:
            scores[task_name] = metrics["acc_norm,none"] * 100.0
        elif "acc,none" in metrics:
            scores[task_name] = metrics["acc,none"] * 100.0
        else:
            for v in metrics.values():
                if isinstance(v, (int, float)):
                    scores[task_name] = float(v)
                    break

    scores["average"] = compute_gate_score(scores)

    per_question = extract_per_question_results(raw_results)

    # Write results to temp file (can't return from spawn process)
    with open(results_file, "w") as f:
        _json.dump({
            "scores": scores,
            "per_question": per_question,
        }, f)

    log.info("Benchmark results written to %s", results_file)


def run_benchmarks(
    model_path: str,
    suites: list[str],
    batch_size: int = 4,
) -> dict[str, Any]:
    """Run lm-eval benchmarks in an isolated subprocess.

    The subprocess loads the model, runs evaluation, writes results to a
    temp file, and exits -- fully releasing all VRAM including the CUDA
    context. The parent process reads the results and returns them.
    """
    results_file = tempfile.mktemp(suffix=".json", prefix="benchmark_")

    ctx = multiprocessing.get_context("spawn")
    proc = ctx.Process(
        target=_benchmark_worker,
        args=(model_path, suites, batch_size, results_file),
        name="benchmark-worker",
    )

    logger.info("Starting benchmark subprocess for %s", model_path)
    proc.start()
    proc.join()

    if proc.exitcode != 0:
        raise RuntimeError(
            f"Benchmark subprocess exited with code {proc.exitcode}"
        )

    results_path = Path(results_file)
    if not results_path.exists():
        raise RuntimeError("Benchmark subprocess did not produce results")

    with open(results_path) as f:
        results = json.load(f)

    results_path.unlink(missing_ok=True)
    logger.info("Benchmark subprocess completed -- VRAM fully released")

    return results

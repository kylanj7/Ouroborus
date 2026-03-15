"""lm-eval benchmark runner for the closed-loop evaluation step."""
from __future__ import annotations

import logging
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
            # Each entry in filtered_resps is (response_text, score); take
            # the first response from the first entry.
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


def run_benchmarks(
    model_path: str,
    suites: list[str],
    batch_size: int = 4,
) -> dict[str, Any]:
    """Run lm-eval benchmarks against a local HuggingFace model.

    Loads the model with HFLM, runs ``simple_evaluate`` with
    ``log_samples=True``, then extracts scores and per-question results.

    Returns::

        {
            "scores":       {task: score_pct, ..., "average": avg_pct},
            "per_question": [{"task", "question", "model_answer",
                              "correct_answer", "passed"}, ...],
            "raw":          <lm-eval results dict>,
        }

    The model is deleted after evaluation to free VRAM.
    """
    from lm_eval import evaluator  # noqa: PLC0415
    from lm_eval.models.huggingface import HFLM  # noqa: PLC0415

    logger.info("Loading model %s for benchmarking", model_path)
    model = HFLM(pretrained=model_path, batch_size=batch_size)

    try:
        logger.info("Running suites: %s", suites)
        raw_results = evaluator.simple_evaluate(
            model=model,
            tasks=suites,
            log_samples=True,
        )
    finally:
        del model
        logger.info("Model deleted -- VRAM freed")

    # Extract numeric scores as percentages.
    scores: dict[str, float] = {}
    task_results: dict = raw_results.get("results", {})
    for task_name, metrics in task_results.items():
        if "acc_norm,none" in metrics:
            scores[task_name] = metrics["acc_norm,none"] * 100.0
        elif "acc,none" in metrics:
            scores[task_name] = metrics["acc,none"] * 100.0
        else:
            # Fall back to the first numeric metric available.
            for v in metrics.values():
                if isinstance(v, (int, float)):
                    scores[task_name] = float(v)
                    break

    scores["average"] = compute_gate_score(scores)

    per_question = extract_per_question_results(raw_results)

    return {
        "scores": scores,
        "per_question": per_question,
        "raw": raw_results,
    }

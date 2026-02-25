"""Analyze evaluation results and produce feedback signals for the next evolution."""
from __future__ import annotations

import logging
import re
from collections import defaultdict
from dataclasses import dataclass, field

from .config import EvolutionConfig, FeedbackConfig
from .state import EvolutionRecord

log = logging.getLogger(__name__)


@dataclass
class DomainFeedback:
    domain: str
    factual_accuracy: float = 0.0
    completeness: float = 0.0
    technical_precision: float = 0.0
    overall_score: float = 0.0
    delta_from_previous: float = 0.0
    weak_topics: list[str] = field(default_factory=list)
    sample_budget: int = 0
    error_patterns: list[str] = field(default_factory=list)


@dataclass
class FeedbackSignal:
    evolution: int
    stop: bool
    stop_reason: str | None
    overall_score: float
    best_score_so_far: float
    delta_from_previous: float
    delta_from_best: float
    consecutive_regressions: int
    consecutive_plateaus: int
    target_reached: bool
    domains: list[DomainFeedback] = field(default_factory=list)


def analyze_evaluation(
    detailed_results: list[dict],
    previous_records: list[EvolutionRecord],
    evolution: int,
    evo_config: EvolutionConfig,
    feedback_config: FeedbackConfig,
) -> FeedbackSignal:
    """Analyze evaluation results and determine whether the loop should continue.

    Args:
        detailed_results: Per-question results from QFTL evaluation.
        previous_records: History of all prior evolution records.
        evolution: Current evolution number (1-indexed).
        evo_config: Evolution termination parameters.
        feedback_config: Feedback weighting parameters.

    Returns:
        FeedbackSignal with termination decision and per-domain feedback.
    """
    weights = feedback_config.dimension_weights
    w_fa = weights.get("factual_accuracy", 0.5)
    w_co = weights.get("completeness", 0.3)
    w_tp = weights.get("technical_precision", 0.2)

    # --- aggregate scores ---
    all_fa, all_co, all_tp = [], [], []
    domain_scores: dict[str, dict[str, list[float]]] = defaultdict(lambda: {
        "factual_accuracy": [], "completeness": [], "technical_precision": [],
        "justifications": [], "topics": [],
    })

    for r in detailed_results:
        scores = r.get("scores") or {}
        fa = scores.get("factual_accuracy", r.get("factual_accuracy"))
        co = scores.get("completeness", r.get("completeness"))
        tp = scores.get("technical_precision", r.get("technical_precision"))

        if fa is None or co is None or tp is None:
            continue
        if fa == 0 and co == 0 and tp == 0:
            continue

        all_fa.append(float(fa))
        all_co.append(float(co))
        all_tp.append(float(tp))

        topic = r.get("topic", "general")
        domain_scores[topic]["factual_accuracy"].append(float(fa))
        domain_scores[topic]["completeness"].append(float(co))
        domain_scores[topic]["technical_precision"].append(float(tp))

        justification = r.get("justification", "")
        if justification:
            domain_scores[topic]["justifications"].append(justification)

    if not all_fa:
        return FeedbackSignal(
            evolution=evolution, stop=True,
            stop_reason="ABORTED", overall_score=0, best_score_so_far=0,
            delta_from_previous=0, delta_from_best=0,
            consecutive_regressions=0, consecutive_plateaus=0,
            target_reached=False,
        )

    avg_fa = sum(all_fa) / len(all_fa)
    avg_co = sum(all_co) / len(all_co)
    avg_tp = sum(all_tp) / len(all_tp)
    overall = avg_fa * w_fa + avg_co * w_co + avg_tp * w_tp

    # --- compare with history ---
    prev_score = previous_records[-1].overall_score if previous_records else 0.0
    best_score = max((r.overall_score for r in previous_records), default=0.0)
    best_score = max(best_score, overall)

    delta_prev = overall - prev_score
    delta_best = overall - best_score

    prev_regressions = previous_records[-1].consecutive_regressions if previous_records else 0
    prev_plateaus = previous_records[-1].consecutive_plateaus if previous_records else 0

    if delta_prev < 0:
        consecutive_regressions = prev_regressions + 1
    else:
        consecutive_regressions = 0

    if abs(delta_prev) < evo_config.convergence_threshold:
        consecutive_plateaus = prev_plateaus + 1
    else:
        consecutive_plateaus = 0

    target_reached = overall >= evo_config.target_accuracy

    # --- termination checks ---
    stop = False
    stop_reason = None

    if target_reached:
        stop = True
        stop_reason = "TARGET_REACHED"
    elif consecutive_regressions >= evo_config.regression_patience:
        stop = True
        stop_reason = "REGRESSION_DETECTED"
    elif consecutive_plateaus >= evo_config.convergence_patience:
        stop = True
        stop_reason = "CONVERGED"
    elif evolution >= evo_config.max_evolutions:
        stop = True
        stop_reason = "MAX_EVOLUTIONS"

    # --- per-domain feedback ---
    domains: list[DomainFeedback] = []
    for domain, scores_dict in domain_scores.items():
        d_fa = _avg(scores_dict["factual_accuracy"])
        d_co = _avg(scores_dict["completeness"])
        d_tp = _avg(scores_dict["technical_precision"])
        d_overall = d_fa * w_fa + d_co * w_co + d_tp * w_tp

        weak_topics = []
        if d_fa < feedback_config.weak_score_threshold:
            weak_topics.append(f"low factual accuracy ({d_fa:.1f})")
        if d_co < feedback_config.weak_score_threshold:
            weak_topics.append(f"low completeness ({d_co:.1f})")
        if d_tp < feedback_config.weak_score_threshold:
            weak_topics.append(f"low technical precision ({d_tp:.1f})")

        error_patterns = _extract_error_patterns(scores_dict["justifications"])

        is_weak = d_overall < feedback_config.weak_score_threshold
        budget = feedback_config.__dict__.get("weak_domain_bonus_samples", 200) if is_weak else 0

        domains.append(DomainFeedback(
            domain=domain,
            factual_accuracy=d_fa,
            completeness=d_co,
            technical_precision=d_tp,
            overall_score=d_overall,
            delta_from_previous=0.0,
            weak_topics=weak_topics,
            sample_budget=budget,
            error_patterns=error_patterns,
        ))

    log.info(
        "Evo %d analysis: overall=%.1f  best=%.1f  delta=%.1f  regressions=%d  plateaus=%d  stop=%s (%s)",
        evolution, overall, best_score, delta_prev,
        consecutive_regressions, consecutive_plateaus, stop, stop_reason,
    )

    return FeedbackSignal(
        evolution=evolution,
        stop=stop,
        stop_reason=stop_reason,
        overall_score=overall,
        best_score_so_far=best_score,
        delta_from_previous=delta_prev,
        delta_from_best=delta_best,
        consecutive_regressions=consecutive_regressions,
        consecutive_plateaus=consecutive_plateaus,
        target_reached=target_reached,
        domains=domains,
    )


def build_evolution_record(
    signal: FeedbackSignal,
    dataset_path: str | None = None,
    adapter_path: str | None = None,
    gguf_path: str | None = None,
    qftl_training_id: int | None = None,
    qftl_eval_id: int | None = None,
    qftl_convert_id: int | None = None,
    started_at: str | None = None,
    completed_at: str | None = None,
) -> EvolutionRecord:
    """Build an EvolutionRecord from a FeedbackSignal plus artifact paths."""
    domain_scores_dict = {}
    for d in signal.domains:
        domain_scores_dict[d.domain] = {
            "factual_accuracy": d.factual_accuracy,
            "completeness": d.completeness,
            "technical_precision": d.technical_precision,
            "overall_score": d.overall_score,
        }

    # Compute factual_accuracy, completeness, technical_precision from domains
    all_fa = [d.factual_accuracy for d in signal.domains]
    all_co = [d.completeness for d in signal.domains]
    all_tp = [d.technical_precision for d in signal.domains]

    return EvolutionRecord(
        evolution=signal.evolution,
        overall_score=signal.overall_score,
        factual_accuracy=_avg(all_fa),
        completeness=_avg(all_co),
        technical_precision=_avg(all_tp),
        best_score_so_far=signal.best_score_so_far,
        delta_from_previous=signal.delta_from_previous,
        delta_from_best=signal.delta_from_best,
        consecutive_regressions=signal.consecutive_regressions,
        consecutive_plateaus=signal.consecutive_plateaus,
        target_reached=signal.target_reached,
        domain_scores=domain_scores_dict,
        dataset_path=dataset_path,
        adapter_path=adapter_path,
        gguf_path=gguf_path,
        qftl_training_id=qftl_training_id,
        qftl_eval_id=qftl_eval_id,
        qftl_convert_id=qftl_convert_id,
        started_at=started_at,
        completed_at=completed_at,
    )


def _avg(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def _extract_error_patterns(justifications: list[str], max_patterns: int = 5) -> list[str]:
    """Extract recurring error phrases from judge justifications."""
    error_keywords = [
        r"incorrect", r"inaccurate", r"missing", r"incomplete",
        r"wrong", r"error", r"fail", r"lack",
    ]
    pattern = re.compile("|".join(error_keywords), re.IGNORECASE)

    error_sentences: list[str] = []
    for text in justifications:
        for sentence in re.split(r"[.!?]", text):
            sentence = sentence.strip()
            if pattern.search(sentence) and len(sentence) > 20:
                error_sentences.append(sentence[:200])

    # Deduplicate roughly by taking first N unique-ish patterns
    seen: set[str] = set()
    unique: list[str] = []
    for s in error_sentences:
        key = s[:50].lower()
        if key not in seen:
            seen.add(key)
            unique.append(s)
        if len(unique) >= max_patterns:
            break

    return unique

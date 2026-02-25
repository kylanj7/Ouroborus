"""Loop configuration loader."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

CONFIGS_DIR = Path(__file__).resolve().parent.parent.parent / "configs"
DEFAULT_LOOP_CONFIG = CONFIGS_DIR / "loop.yaml"


@dataclass
class QFTLConfig:
    base_url: str = "http://localhost:8000"
    username: str = ""
    password: str = ""
    poll_interval_seconds: int = 30
    request_timeout_seconds: int = 600


@dataclass
class EvolutionConfig:
    max_evolutions: int = 10
    target_accuracy: float = 70.0
    regression_patience: int = 3
    convergence_threshold: float = 2.0
    convergence_patience: int = 3
    stage_retry_limit: int = 2


@dataclass
class GenerationConfig:
    initial_samples_per_domain: int = 500
    weak_domain_bonus_samples: int = 200
    provider: str = "openai"
    task_config: str = "paper_qa"
    domains: list[str] = field(default_factory=lambda: ["quantum", "physics", "chemistry", "biology", "math"])


@dataclass
class TrainingConfig:
    model_config: str = "qwen2.5-14b-instruct"
    training_config: str = "default"


@dataclass
class EvaluationConfig:
    sample_count: int = 50
    judge_model: str = "nemotron-3-nano:latest"


@dataclass
class FeedbackConfig:
    weak_score_threshold: float = 70.0
    dimension_weights: dict[str, float] = field(default_factory=lambda: {
        "factual_accuracy": 0.5,
        "completeness": 0.3,
        "technical_precision": 0.2,
    })


@dataclass
class LoopConfig:
    qftl: QFTLConfig = field(default_factory=QFTLConfig)
    evolution: EvolutionConfig = field(default_factory=EvolutionConfig)
    generation: GenerationConfig = field(default_factory=GenerationConfig)
    training: TrainingConfig = field(default_factory=TrainingConfig)
    evaluation: EvaluationConfig = field(default_factory=EvaluationConfig)
    feedback: FeedbackConfig = field(default_factory=FeedbackConfig)


def _build_dataclass(cls: type, raw: dict[str, Any] | None):
    """Build a dataclass from a dict, ignoring unknown keys."""
    if not raw:
        return cls()
    valid_keys = {f.name for f in cls.__dataclass_fields__.values()}
    return cls(**{k: v for k, v in raw.items() if k in valid_keys})


def load_loop_config(path: Path | str | None = None) -> LoopConfig:
    """Load loop configuration from a YAML file."""
    path = Path(path) if path else DEFAULT_LOOP_CONFIG
    if not path.exists():
        return LoopConfig()

    with open(path) as f:
        raw = yaml.safe_load(f) or {}

    return LoopConfig(
        qftl=_build_dataclass(QFTLConfig, raw.get("qftl")),
        evolution=_build_dataclass(EvolutionConfig, raw.get("evolution")),
        generation=_build_dataclass(GenerationConfig, raw.get("generation")),
        training=_build_dataclass(TrainingConfig, raw.get("training")),
        evaluation=_build_dataclass(EvaluationConfig, raw.get("evaluation")),
        feedback=_build_dataclass(FeedbackConfig, raw.get("feedback")),
    )

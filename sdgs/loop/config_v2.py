"""Closed-loop training configuration (v2).

Replaces the QFTL-oriented LoopConfig with dataclasses that model the new
closed-loop training mechanism.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


# ---------------------------------------------------------------------------
# Dataclasses
# ---------------------------------------------------------------------------

@dataclass
class GateConfig:
    improvement_threshold: float = 0.5
    fail_cap: int = 3
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587


@dataclass
class TrainingStrategyConfig:
    strategy: str = "merge-and-continue"
    base_model: str = "Qwen/Qwen2.5-7B-Instruct"
    preserve_original: bool = True
    model_config: str = "qwen2.5-7b-instruct"
    training_config: str = "default"
    checkpoint_dir: str = "models/merged/"
    max_checkpoints: int = 5


@dataclass
class BenchmarkConfig:
    suites: list[str] = field(default_factory=lambda: [
        "gpqa_diamond",
        "mmlu_college_physics",
        "mmlu_conceptual_physics",
        "scibench",
    ])
    batch_size: int = 4


@dataclass
class TallyConfig:
    model: str = "gpt-oss:120b"
    provider: str = "ollama"
    max_clusters: int = 10
    history_window: int = 5
    max_retries: int = 3
    max_tool_calls: int = 20
    timeout_seconds: int = 600


@dataclass
class VerificationConfig:
    citation_matching: bool = True
    entailment_model: str = "facebook/bart-large-mnli"
    entailment_min_ratio: float = 0.5
    embedding_model: str = "all-MiniLM-L6-v2"
    chunk_similarity_threshold: float = 0.3
    rejects_log: str = "curation_rejects.jsonl"


@dataclass
class CurationConfig:
    model: str = "gpt-oss:120b"
    provider: str = "ollama"
    min_pairs_per_cycle: int = 1000
    max_pairs_per_cycle: int = -1
    format: str = "chain-of-thought"
    max_retries_per_pair: int = 3
    verification: VerificationConfig = field(default_factory=VerificationConfig)


@dataclass
class RetrievalConfig:
    sources: list[str] = field(default_factory=lambda: ["semantic_scholar", "arxiv"])
    max_papers_per_cluster: int = 10


@dataclass
class LoggingConfig:
    cycle_log: str = "loop_log.jsonl"
    project_log: str = "loop_projects.json"
    log_dir: str = "logs/loop/"


@dataclass
class TerminationConfig:
    target_score: float = 85.0
    max_cycles: int = 50


@dataclass
class ClosedLoopConfig:
    gate: GateConfig = field(default_factory=GateConfig)
    training: TrainingStrategyConfig = field(default_factory=TrainingStrategyConfig)
    benchmarks: BenchmarkConfig = field(default_factory=BenchmarkConfig)
    tally: TallyConfig = field(default_factory=TallyConfig)
    curation: CurationConfig = field(default_factory=CurationConfig)
    retrieval: RetrievalConfig = field(default_factory=RetrievalConfig)
    logging: LoggingConfig = field(default_factory=LoggingConfig)
    termination: TerminationConfig = field(default_factory=TerminationConfig)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _dataclass_from_dict(cls: type, data: dict[str, Any] | None):
    """Recursively instantiate a dataclass from a dict.

    - Unknown keys are ignored.
    - Nested dataclass fields are recursively instantiated when the
      corresponding value is a dict.
    - Missing keys use the dataclass field defaults.
    """
    if not data:
        return cls()

    import dataclasses

    init_kwargs: dict[str, Any] = {}
    for f in dataclasses.fields(cls):
        if f.name not in data:
            continue
        value = data[f.name]
        # Resolve the actual type annotation for the field.
        field_type = f.type
        # When annotations are strings (from __future__ annotations) we need
        # to resolve them against the module's globals.
        if isinstance(field_type, str):
            field_type = cls.__annotations__.get(f.name, field_type)
            # If still a string, try evaluating it in the module's namespace.
            if isinstance(field_type, str):
                import sys
                module = sys.modules.get(cls.__module__, None)
                ns = vars(module) if module else {}
                try:
                    field_type = eval(field_type, ns)  # noqa: S307
                except Exception:
                    pass
        if (
            isinstance(value, dict)
            and isinstance(field_type, type)
            and dataclasses.is_dataclass(field_type)
        ):
            init_kwargs[f.name] = _dataclass_from_dict(field_type, value)
        else:
            init_kwargs[f.name] = value

    return cls(**init_kwargs)


# ---------------------------------------------------------------------------
# Loader
# ---------------------------------------------------------------------------

def load_closed_loop_config(path: Path | str | None = None) -> ClosedLoopConfig:
    """Load a ClosedLoopConfig from a YAML file.

    If ``path`` is None or the file does not exist, all defaults are used.
    Fields not present in the YAML retain their dataclass defaults.
    """
    if path is not None:
        path = Path(path)

    if path is None or not path.exists():
        return ClosedLoopConfig()

    with open(path) as fh:
        raw: dict[str, Any] = yaml.safe_load(fh) or {}

    return ClosedLoopConfig(
        gate=_dataclass_from_dict(GateConfig, raw.get("gate")),
        training=_dataclass_from_dict(TrainingStrategyConfig, raw.get("training")),
        benchmarks=_dataclass_from_dict(BenchmarkConfig, raw.get("benchmarks")),
        tally=_dataclass_from_dict(TallyConfig, raw.get("tally")),
        curation=_dataclass_from_dict(CurationConfig, raw.get("curation")),
        retrieval=_dataclass_from_dict(RetrievalConfig, raw.get("retrieval")),
        logging=_dataclass_from_dict(LoggingConfig, raw.get("logging")),
        termination=_dataclass_from_dict(TerminationConfig, raw.get("termination")),
    )

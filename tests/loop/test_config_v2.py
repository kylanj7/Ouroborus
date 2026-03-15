"""Tests for sdgs.loop.config_v2."""
from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from sdgs.loop.config_v2 import (
    BenchmarkConfig,
    ClosedLoopConfig,
    CurationConfig,
    GateConfig,
    LoggingConfig,
    RetrievalConfig,
    TallyConfig,
    TerminationConfig,
    TrainingStrategyConfig,
    VerificationConfig,
    load_closed_loop_config,
)


# ---------------------------------------------------------------------------
# test_load_default_config
# ---------------------------------------------------------------------------

def test_load_default_config():
    """Loading with no path returns a ClosedLoopConfig with all defaults."""
    cfg = load_closed_loop_config(path=None)

    assert isinstance(cfg, ClosedLoopConfig)

    # GateConfig
    assert cfg.gate.improvement_threshold == 0.5
    assert cfg.gate.fail_cap == 3
    assert cfg.gate.smtp_host == "smtp.gmail.com"
    assert cfg.gate.smtp_port == 587

    # TrainingStrategyConfig
    assert cfg.training.strategy == "merge-and-continue"
    assert cfg.training.base_model == "Qwen/Qwen2.5-7B-Instruct"
    assert cfg.training.preserve_original is True
    assert cfg.training.model_config == "qwen2.5-7b-instruct"
    assert cfg.training.training_config == "default"
    assert cfg.training.checkpoint_dir == "models/merged/"
    assert cfg.training.max_checkpoints == 5

    # BenchmarkConfig
    assert cfg.benchmarks.suites == [
        "gpqa_diamond",
        "mmlu_college_physics",
        "mmlu_conceptual_physics",
        "scibench",
    ]
    assert cfg.benchmarks.batch_size == 4

    # TallyConfig
    assert cfg.tally.model == "gpt-oss:120b"
    assert cfg.tally.provider == "ollama"
    assert cfg.tally.max_clusters == 10
    assert cfg.tally.history_window == 5
    assert cfg.tally.max_retries == 3

    # VerificationConfig
    assert cfg.curation.verification.citation_matching is True
    assert cfg.curation.verification.entailment_model == "microsoft/deberta-v3-base-mnli"
    assert cfg.curation.verification.entailment_min_ratio == 0.5
    assert cfg.curation.verification.embedding_model == "all-MiniLM-L6-v2"
    assert cfg.curation.verification.chunk_similarity_threshold == 0.3
    assert cfg.curation.verification.rejects_log == "curation_rejects.jsonl"

    # CurationConfig
    assert cfg.curation.model == "gpt-oss:120b"
    assert cfg.curation.provider == "ollama"
    assert cfg.curation.min_pairs_per_cycle == 1000
    assert cfg.curation.max_pairs_per_cycle == -1
    assert cfg.curation.format == "chain-of-thought"
    assert isinstance(cfg.curation.verification, VerificationConfig)

    # RetrievalConfig
    assert cfg.retrieval.sources == ["semantic_scholar", "arxiv"]
    assert cfg.retrieval.max_papers_per_cluster == 10

    # LoggingConfig
    assert cfg.logging.cycle_log == "loop_log.jsonl"
    assert cfg.logging.project_log == "loop_projects.json"
    assert cfg.logging.log_dir == "logs/loop/"

    # TerminationConfig
    assert cfg.termination.target_score == 85.0
    assert cfg.termination.max_cycles == 50


# ---------------------------------------------------------------------------
# test_load_from_yaml
# ---------------------------------------------------------------------------

def test_load_from_yaml(tmp_path: Path):
    """Loading from a YAML file overrides specified fields; unspecified fields keep defaults."""
    yaml_content = textwrap.dedent("""\
        gate:
          improvement_threshold: 1.0
          fail_cap: 5
        training:
          strategy: fine-tune-only
          base_model: mistralai/Mistral-7B-Instruct-v0.3
        benchmarks:
          batch_size: 8
        tally:
          max_clusters: 20
        curation:
          min_pairs_per_cycle: 500
          verification:
            entailment_min_ratio: 0.7
        retrieval:
          sources:
            - arxiv
        logging:
          log_dir: logs/custom/
        termination:
          target_score: 90.0
          max_cycles: 100
    """)
    config_file = tmp_path / "loop_v2.yaml"
    config_file.write_text(yaml_content)

    cfg = load_closed_loop_config(path=config_file)

    # Overridden values
    assert cfg.gate.improvement_threshold == 1.0
    assert cfg.gate.fail_cap == 5
    assert cfg.training.strategy == "fine-tune-only"
    assert cfg.training.base_model == "mistralai/Mistral-7B-Instruct-v0.3"
    assert cfg.benchmarks.batch_size == 8
    assert cfg.tally.max_clusters == 20
    assert cfg.curation.min_pairs_per_cycle == 500
    assert cfg.curation.verification.entailment_min_ratio == 0.7
    assert cfg.retrieval.sources == ["arxiv"]
    assert cfg.logging.log_dir == "logs/custom/"
    assert cfg.termination.target_score == 90.0
    assert cfg.termination.max_cycles == 100

    # Defaults preserved for unspecified fields
    assert cfg.gate.smtp_host == "smtp.gmail.com"
    assert cfg.gate.smtp_port == 587
    assert cfg.training.preserve_original is True
    assert cfg.training.model_config == "qwen2.5-7b-instruct"
    assert cfg.training.checkpoint_dir == "models/merged/"
    assert cfg.training.max_checkpoints == 5
    assert cfg.benchmarks.suites == [
        "gpqa_diamond",
        "mmlu_college_physics",
        "mmlu_conceptual_physics",
        "scibench",
    ]
    assert cfg.tally.model == "gpt-oss:120b"
    assert cfg.tally.provider == "ollama"
    assert cfg.tally.history_window == 5
    assert cfg.tally.max_retries == 3
    assert cfg.curation.model == "gpt-oss:120b"
    assert cfg.curation.provider == "ollama"
    assert cfg.curation.max_pairs_per_cycle == -1
    assert cfg.curation.format == "chain-of-thought"
    assert cfg.curation.verification.citation_matching is True
    assert cfg.curation.verification.entailment_model == "microsoft/deberta-v3-base-mnli"
    assert cfg.curation.verification.embedding_model == "all-MiniLM-L6-v2"
    assert cfg.curation.verification.chunk_similarity_threshold == 0.3
    assert cfg.curation.verification.rejects_log == "curation_rejects.jsonl"
    assert cfg.retrieval.max_papers_per_cluster == 10
    assert cfg.logging.cycle_log == "loop_log.jsonl"
    assert cfg.logging.project_log == "loop_projects.json"
    assert cfg.termination.target_score == 90.0  # overridden above

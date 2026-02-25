"""Translate SDGS output to QFTL-compatible dataset format."""
from __future__ import annotations

import json
import logging
from pathlib import Path

import yaml

log = logging.getLogger(__name__)


def format_for_qftl(
    sdgs_jsonl_path: str | Path,
    output_path: str | Path,
    domain: str,
    evolution: int,
) -> tuple[Path, str, str]:
    """Convert an SDGS JSONL dataset to QFTL training format.

    Returns:
        (output_path, config_yaml_string, config_name)
    """
    sdgs_jsonl_path = Path(sdgs_jsonl_path)
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    kept = 0
    with open(sdgs_jsonl_path) as fin, open(output_path, "w") as fout:
        for line in fin:
            line = line.strip()
            if not line:
                continue
            try:
                record = json.loads(line)
            except json.JSONDecodeError:
                continue

            if not record.get("valid", True) and not record.get("is_valid", True):
                continue

            instruction = record.get("instruction", "")
            output_text = record.get("output", record.get("response", ""))
            if not instruction or not output_text:
                continue

            fout.write(json.dumps({
                "instruction": instruction,
                "response": output_text,
            }) + "\n")
            kept += 1

    log.info("Formatted %d samples from %s → %s", kept, sdgs_jsonl_path.name, output_path.name)

    config_name = f"loop-evo{evolution:03d}-{_slug(domain)}"

    dataset_config = {
        "name": config_name,
        "dataset_name": str(output_path),
        "domain": domain,
        "is_local": True,
        "train_val_test_split": {
            "train": 0.8,
            "val": 0.1,
            "test": 0.1,
            "seed": 3407,
        },
        "fields": {
            "instruction": "instruction",
            "response": "response",
            "context_fields": [],
        },
        "prompt_template": (
            "<|im_start|>user\n{0}{1}<|im_end|>\n<|im_start|>assistant\n{2}"
        ),
    }

    config_yaml = yaml.dump(dataset_config, default_flow_style=False)
    return output_path, config_yaml, config_name


def merge_domain_datasets(
    domain_paths: dict[str, Path],
    output_path: Path,
    evolution: int,
) -> tuple[Path, str, str]:
    """Merge multiple per-domain JSONL files into a single QFTL dataset.

    Returns:
        (output_path, config_yaml_string, config_name)
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    total = 0

    with open(output_path, "w") as fout:
        for domain, path in domain_paths.items():
            if not path.exists():
                continue
            with open(path) as fin:
                for line in fin:
                    line = line.strip()
                    if line:
                        fout.write(line + "\n")
                        total += 1

    config_name = f"loop-evo{evolution:03d}-merged"
    dataset_config = {
        "name": config_name,
        "dataset_name": str(output_path),
        "domain": "Multi-Domain",
        "is_local": True,
        "train_val_test_split": {
            "train": 0.8,
            "val": 0.1,
            "test": 0.1,
            "seed": 3407,
        },
        "fields": {
            "instruction": "instruction",
            "response": "response",
            "context_fields": [],
        },
        "prompt_template": (
            "<|im_start|>user\n{0}{1}<|im_end|>\n<|im_start|>assistant\n{2}"
        ),
    }

    config_yaml = yaml.dump(dataset_config, default_flow_style=False)
    log.info("Merged %d total samples across %d domains for evo %d",
             total, len(domain_paths), evolution)
    return output_path, config_yaml, config_name


def install_dataset_config(config_yaml: str, config_name: str) -> Path:
    """Write a dataset YAML config to the engine configs directory.

    This makes it discoverable by ``discover_configs("datasets")``.
    """
    configs_dir = Path(__file__).resolve().parent.parent / "web" / "engine" / "configs" / "datasets"
    configs_dir.mkdir(parents=True, exist_ok=True)

    dest = configs_dir / f"{config_name}.yaml"
    dest.write_text(config_yaml)
    log.info("Installed dataset config %s -> %s", config_name, dest)
    return dest


def _slug(s: str) -> str:
    return s.lower().replace(" ", "-").replace("_", "-")

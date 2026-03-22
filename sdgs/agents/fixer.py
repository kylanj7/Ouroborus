"""Fixer agent -- Markdown-to-JSON sanitizer and training error recovery.

Handles two failure modes:
1. Tally agent outputs markdown instead of JSON -> multi-strategy sanitizer
2. Training subprocess crashes -> error-pattern-based config adjustment
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

import yaml

logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parent.parent.parent

# Expected schema keys for tally output
_REQUIRED_KEYS = {"clusters", "search_queries", "generation_guidance"}


# ------------------------------------------------------------------
# Markdown-to-JSON Sanitizer (Strategy 1-5)
# ------------------------------------------------------------------


def sanitize_tally_output(raw: str) -> dict | None:
    """Multi-strategy parser to extract tally JSON from LLM output.

    Tries strategies in order of reliability:
    1. Direct json.loads
    2. Extract from triple-backtick fences
    3. Find outermost JSON braces
    4. Markdown table-to-JSON converter
    5. Return None (caller uses fallback_analysis)

    Returns validated dict or None.
    """
    for strategy_num, strategy in enumerate(
        [_strategy_direct, _strategy_fenced, _strategy_braces, _strategy_table],
        start=1,
    ):
        try:
            result = strategy(raw)
            if result is not None and _validate_schema(result):
                logger.info("Sanitizer succeeded with strategy %d", strategy_num)
                return result
        except Exception as exc:
            logger.debug("Sanitizer strategy %d failed: %s", strategy_num, exc)

    logger.warning("All sanitizer strategies exhausted")
    return None


def _strategy_direct(raw: str) -> dict | None:
    """Strategy 1: Direct JSON parse."""
    stripped = raw.strip()
    if not stripped.startswith("{"):
        return None
    return json.loads(stripped)


def _strategy_fenced(raw: str) -> dict | None:
    """Strategy 2: Extract from triple-backtick code fences."""
    match = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    if not match:
        return None
    return json.loads(match.group(1).strip())


def _strategy_braces(raw: str) -> dict | None:
    """Strategy 3: Find outermost JSON object braces."""
    start = raw.find("{")
    if start == -1:
        return None
    # Find matching closing brace by counting depth
    depth = 0
    for i in range(start, len(raw)):
        if raw[i] == "{":
            depth += 1
        elif raw[i] == "}":
            depth -= 1
            if depth == 0:
                return json.loads(raw[start : i + 1])
    return None


def _strategy_table(raw: str) -> dict | None:
    """Strategy 4: Convert markdown table rows to JSON clusters.

    Looks for tables with columns that map to gap_description, root_cause,
    affected_questions, and priority_score.
    """
    # Find table rows: lines starting and ending with |
    table_lines = [
        line.strip()
        for line in raw.split("\n")
        if line.strip().startswith("|") and line.strip().endswith("|")
    ]
    if len(table_lines) < 3:  # header + separator + at least 1 data row
        return None

    # Parse header
    header = [h.strip() for h in table_lines[0].split("|")[1:-1]]
    header_lower = [h.lower().replace(" ", "_") for h in header]

    # Skip separator row (---|---|...)
    data_start = 1
    for i, line in enumerate(table_lines[1:], start=1):
        if re.match(r"^\|[\s\-:|]+\|$", line):
            data_start = i + 1
            break

    # Map columns to schema fields
    col_map = _map_columns(header_lower)
    if col_map.get("gap") is None:
        return None  # Can't build clusters without at least a gap description

    # Parse data rows into clusters
    clusters = []
    for line in table_lines[data_start:]:
        cells = [c.strip() for c in line.split("|")[1:-1]]
        if len(cells) < len(header):
            continue

        cluster: dict[str, Any] = {
            "gap_description": "",
            "root_cause": "",
            "affected_questions": [],
            "priority_score": 0.5,
        }

        gap_idx = col_map.get("gap")
        if gap_idx is not None and gap_idx < len(cells):
            cluster["gap_description"] = cells[gap_idx]

        cause_idx = col_map.get("cause")
        if cause_idx is not None and cause_idx < len(cells):
            cluster["root_cause"] = cells[cause_idx]
        elif cluster["gap_description"]:
            cluster["root_cause"] = f"Model struggles with: {cluster['gap_description']}"

        q_idx = col_map.get("questions")
        if q_idx is not None and q_idx < len(cells):
            raw_q = cells[q_idx]
            cluster["affected_questions"] = [
                q.strip() for q in re.split(r"[;,]", raw_q) if q.strip()
            ]

        score_idx = col_map.get("score")
        if score_idx is not None and score_idx < len(cells):
            try:
                cluster["priority_score"] = float(cells[score_idx])
            except ValueError:
                pass

        if cluster["gap_description"]:
            clusters.append(cluster)

    # Reasonability check
    if not clusters:
        return None

    # Synthesize search queries from gap descriptions
    search_queries = []
    for c in clusters:
        gap = c["gap_description"]
        words = re.findall(r"[a-zA-Z]{3,}", gap.lower())
        query = " ".join(words[:5]) if words else gap
        search_queries.append(query)

    if not search_queries:
        return None

    guidance = (
        "Generate training examples targeting these knowledge gaps: "
        + "; ".join(c["gap_description"] for c in clusters)
    )

    return {
        "clusters": clusters,
        "search_queries": search_queries,
        "generation_guidance": guidance,
    }


def _map_columns(headers: list[str]) -> dict[str, int]:
    """Map column headers to schema fields by keyword matching."""
    mapping: dict[str, int] = {}

    gap_keywords = ("gap", "cluster", "description", "topic", "area", "weakness")
    cause_keywords = ("cause", "root", "reason", "diagnosis", "analysis")
    question_keywords = ("question", "affected", "example", "sample")
    score_keywords = ("score", "priority", "severity", "impact", "weight")

    for i, h in enumerate(headers):
        if not mapping.get("gap") and any(k in h for k in gap_keywords):
            mapping["gap"] = i
        elif not mapping.get("cause") and any(k in h for k in cause_keywords):
            mapping["cause"] = i
        elif not mapping.get("questions") and any(k in h for k in question_keywords):
            mapping["questions"] = i
        elif not mapping.get("score") and any(k in h for k in score_keywords):
            mapping["score"] = i

    return mapping


def _validate_schema(data: dict) -> bool:
    """Check that parsed data has required keys with non-empty values."""
    if not isinstance(data, dict):
        return False
    missing = _REQUIRED_KEYS - set(data.keys())
    if missing:
        return False
    clusters = data.get("clusters", [])
    queries = data.get("search_queries", [])
    if not isinstance(clusters, list) or len(clusters) == 0:
        return False
    if not isinstance(queries, list) or len(queries) == 0:
        return False
    return True


# ------------------------------------------------------------------
# Training Error Branch
# ------------------------------------------------------------------

# Error patterns and their corresponding actions
_ERROR_PATTERNS: list[tuple[re.Pattern, str, str]] = [
    (
        re.compile(r"CUDA out of memory|OutOfMemoryError|CUDA OOM", re.IGNORECASE),
        "oom",
        "CUDA out of memory",
    ),
    (
        re.compile(r"Loss is NaN|Loss is Inf|loss.*nan|nan.*loss", re.IGNORECASE),
        "nan_loss",
        "NaN/Inf loss detected",
    ),
    (
        re.compile(r"PicklingError|Can't pickle|AttributeError.*pickle", re.IGNORECASE),
        "pickle",
        "Pickling/serialization error (code regression)",
    ),
    (
        re.compile(r"TimeoutError|DataLoader worker.*timeout", re.IGNORECASE),
        "timeout",
        "DataLoader timeout",
    ),
    (
        re.compile(
            r"CUDA error: illegal memory access|device-side assert|"
            r"CUDA error: an illegal instruction",
            re.IGNORECASE,
        ),
        "cuda_fault",
        "CUDA hardware fault",
    ),
]


class Fixer:
    """Handles tally sanitization and training crash recovery."""

    def __init__(
        self,
        config_path: str | Path = "configs/closed_loop.yaml",
        log_dir: str | Path = "logs/loop/",
        checkpoint_dir: str | Path = "models/merged/",
    ):
        self._config_path = PROJECT_ROOT / config_path
        self._log_dir = PROJECT_ROOT / log_dir
        self._checkpoint_dir = PROJECT_ROOT / checkpoint_dir
        self._pending_tally_fix: dict | None = None
        self._pending_recovery: dict | None = None

    # ------------------------------------------------------------------
    # Tally failure handling
    # ------------------------------------------------------------------

    def on_tally_failure_detected(self, log_line: str) -> None:
        """Called by Watcher when tally failure keywords appear in SSE logs.

        Extracts the raw LLM output from the log file and attempts sanitization.
        If successful, stores the fix for the Watcher to apply via restart.
        """
        raw_output = self._extract_raw_tally_output()
        if not raw_output:
            logger.warning("Could not extract raw tally output from logs")
            return

        sanitized = sanitize_tally_output(raw_output)
        if sanitized:
            logger.info(
                "Tally output sanitized: %d clusters, %d queries",
                len(sanitized.get("clusters", [])),
                len(sanitized.get("search_queries", [])),
            )
            self._pending_tally_fix = sanitized
        else:
            logger.warning("Sanitization failed -- fallback_analysis will be used")
            self._pending_tally_fix = None

    def get_tally_fix(self) -> dict | None:
        """Return and consume the pending tally fix, if any."""
        fix = self._pending_tally_fix
        self._pending_tally_fix = None
        return fix

    def apply_tally_fix_to_db(
        self, loop_id: str, cycle: int, tally_metadata: dict
    ) -> None:
        """Write sanitized tally_metadata into the SQLite cycle_records table."""
        from sdgs.loop.state_v2 import LoopStateStore

        store = LoopStateStore()
        loop_state = store.get_loop(loop_id)
        if not loop_state:
            logger.error("Cannot apply tally fix: loop %s not found", loop_id)
            return

        # Find the cycle record and update tally_metadata
        for record in loop_state.cycles:
            if record.cycle == cycle:
                record.tally_metadata = tally_metadata
                store.save_cycle(loop_id, record)
                logger.info(
                    "Tally metadata updated in DB for loop %s cycle %d",
                    loop_id, cycle,
                )
                return

        logger.warning("Cycle %d not found in loop %s", cycle, loop_id)

    def _extract_raw_tally_output(self) -> str | None:
        """Pull the most recent raw tally LLM output from log files.

        The tally_agent logs "Raw LLM output was: ..." on failure.
        """
        log_files = sorted(self._log_dir.glob("*.log"), key=lambda p: p.stat().st_mtime)
        if not log_files:
            return None

        latest_log = log_files[-1]
        try:
            content = latest_log.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return None

        # Look for the raw output marker (logged by tally_agent.py)
        pattern = re.compile(r"Raw LLM output was:\s*(.+)", re.DOTALL)
        matches = list(pattern.finditer(content))
        if not matches:
            return None

        # Take the last match (most recent failure)
        raw = matches[-1].group(1).strip()
        # Trim to ~3000 chars (tally agent logs up to 1500, but be generous)
        return raw[:3000]

    # ------------------------------------------------------------------
    # Training error handling
    # ------------------------------------------------------------------

    def handle_error(
        self,
        loop_id: str,
        error_text: str,
        current_stage: str,
        retry_count: int,
        max_retries: int,
        failed_configs: set,
    ) -> dict:
        """Analyze an error and determine recovery action.

        Returns dict with:
          action: "restart" | "stop" | "continue"
          resume_from: stage to resume from (if restart)
          overrides: config overrides to apply (if restart)
          details: dict for Auditor logging
          reason: human-readable explanation
          config_key: frozenset of config values (for Config State Lock)
        """
        # Enrich error_text with .error file content for fuller tracebacks.
        # The SSE error is often just str(exc), but the .error file has the
        # full traceback which is more useful for pattern matching.
        enriched = self._read_latest_error_file()
        if enriched:
            error_text = enriched + "\n" + error_text

        if current_stage not in ("training", "merging"):
            # Non-training/merge errors are not recoverable via config
            self._pending_recovery = {
                "action": "stop",
                "reason": f"Unhandled error in stage {current_stage}",
                "details": {"stage": current_stage, "error": error_text[:500]},
            }
            return self._pending_recovery

        # Match error pattern
        error_type, description = self._classify_error(error_text)

        if error_type in ("pickle", "cuda_fault"):
            # Hard stop -- no config change can fix these
            self._pending_recovery = {
                "action": "stop",
                "reason": f"{description} -- code/hardware issue, not recoverable via config",
                "details": {
                    "error_type": error_type,
                    "description": description,
                    "error": error_text[:500],
                },
            }
            return self._pending_recovery

        if retry_count >= max_retries:
            self._pending_recovery = {
                "action": "stop",
                "reason": f"Max retries ({max_retries}) exhausted for {description}",
                "details": {
                    "error_type": error_type,
                    "retry_count": retry_count,
                    "error": error_text[:500],
                },
            }
            return self._pending_recovery

        # Compute config adjustment
        adjustment = self._compute_adjustment(error_type)
        if not adjustment:
            self._pending_recovery = {
                "action": "stop",
                "reason": f"No config adjustment available for {error_type}",
                "details": {"error_type": error_type, "error": error_text[:500]},
            }
            return self._pending_recovery

        # Config State Lock: check if this config has already failed
        new_config = self._read_config()
        for key, value in adjustment["changes"].items():
            _set_nested(new_config, key, value)

        config_key = self._config_fingerprint(new_config)
        if config_key in failed_configs:
            self._pending_recovery = {
                "action": "stop",
                "reason": f"Config already tried and failed: {adjustment['changes']}",
                "details": {
                    "error_type": error_type,
                    "attempted_config": adjustment["changes"],
                },
            }
            return self._pending_recovery

        # Apply config changes to YAML
        old_values = {}
        for key, new_val in adjustment["changes"].items():
            old_val = _get_nested(new_config, key)
            old_values[key] = old_val

        self._write_config(new_config)

        self._pending_recovery = {
            "action": "restart",
            "resume_from": current_stage,
            "overrides": None,  # Config written to YAML directly
            "details": {
                "parameter": ", ".join(adjustment["changes"].keys()),
                "old": str(old_values),
                "new": str(adjustment["changes"]),
                "reason": description,
            },
            "reason": f"Adjusted config for {description}",
            "config_key": config_key,
        }
        return self._pending_recovery

    def get_recovery_action(
        self,
        loop_id: str,
        current_stage: str,
        retry_count: int,
        max_retries: int,
    ) -> dict | None:
        """Return and consume the pending recovery action."""
        action = self._pending_recovery
        self._pending_recovery = None
        return action

    def _read_latest_error_file(self) -> str | None:
        """Read the most recent .error file from checkpoint/temp directories.

        Workers write tracebacks to {results_file}.error on crash. These files
        contain the full traceback, unlike the SSE error which is just str(exc).
        """
        # Check for .error files in checkpoint dir and /tmp
        error_files = list(self._checkpoint_dir.glob("**/*.error"))
        error_files.extend(Path("/tmp").glob("training_*.error"))
        error_files.extend(Path("/tmp").glob("merge_*.error"))

        if not error_files:
            return None

        # Take the most recently modified
        latest = max(error_files, key=lambda p: p.stat().st_mtime)
        try:
            content = latest.read_text(encoding="utf-8", errors="replace")
            logger.info("Read .error file: %s (%d chars)", latest, len(content))
            return content
        except OSError:
            return None

    def _classify_error(self, error_text: str) -> tuple[str, str]:
        """Match error text against known patterns."""
        for pattern, error_type, description in _ERROR_PATTERNS:
            if pattern.search(error_text):
                return error_type, description
        return "unknown", "Unknown training error"

    def _compute_adjustment(self, error_type: str) -> dict | None:
        """Determine config changes for a given error type."""
        config = self._read_config()
        training = config.get("training", {})

        if error_type == "oom":
            # Halve batch_size, double grad_accumulation_steps
            current_batch = training.get("batch_size", 32)
            current_grad_accum = training.get("gradient_accumulation_steps", 4)
            new_batch = max(1, current_batch // 2)
            new_grad_accum = current_grad_accum * 2
            return {
                "changes": {
                    "training.batch_size": new_batch,
                    "training.gradient_accumulation_steps": new_grad_accum,
                },
            }

        if error_type == "nan_loss":
            # Enable gradient clipping, halve learning rate
            current_lr = training.get("learning_rate", 1e-5)
            return {
                "changes": {
                    "training.max_grad_norm": 1.0,
                    "training.learning_rate": current_lr / 2,
                },
            }

        if error_type == "timeout":
            current_timeout = training.get("dataloader_timeout", 60)
            return {
                "changes": {
                    "training.dataloader_timeout": current_timeout * 2,
                },
            }

        return None

    def _read_config(self) -> dict:
        """Read the current YAML config."""
        try:
            return yaml.safe_load(self._config_path.read_text(encoding="utf-8")) or {}
        except (OSError, yaml.YAMLError) as exc:
            logger.error("Failed to read config: %s", exc)
            return {}

    def _write_config(self, config: dict) -> None:
        """Write updated config back to YAML."""
        try:
            self._config_path.write_text(
                yaml.dump(config, default_flow_style=False, sort_keys=False),
                encoding="utf-8",
            )
            logger.info("Config updated: %s", self._config_path)
        except OSError as exc:
            logger.error("Failed to write config: %s", exc)

    @staticmethod
    def _config_fingerprint(config: dict) -> frozenset:
        """Create a hashable fingerprint of training-relevant config values."""
        training = config.get("training", {})
        keys = [
            "batch_size",
            "gradient_accumulation_steps",
            "learning_rate",
            "max_grad_norm",
            "dataloader_timeout",
        ]
        return frozenset((k, training.get(k)) for k in keys if k in training)


# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------


def _get_nested(d: dict, dotted_key: str) -> Any:
    """Get a value from a nested dict using dotted notation (e.g. 'training.batch_size')."""
    keys = dotted_key.split(".")
    for k in keys:
        if isinstance(d, dict):
            d = d.get(k)
        else:
            return None
    return d


def _set_nested(d: dict, dotted_key: str, value: Any) -> None:
    """Set a value in a nested dict using dotted notation."""
    keys = dotted_key.split(".")
    for k in keys[:-1]:
        d = d.setdefault(k, {})
    d[keys[-1]] = value

"""Cycle logger for tracking closed-loop training cycles and projects."""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)


class CycleLogger:
    """Logs training cycles and manages project state."""

    def __init__(
        self,
        log_dir: str | Path,
        cycle_log_name: str = "loop_log.jsonl",
        project_log_name: str = "loop_projects.json",
    ):
        self.log_dir = Path(log_dir)
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self.cycle_log_path = self.log_dir / cycle_log_name
        self.project_log_path = self.log_dir / project_log_name

    # ------------------------------------------------------------------
    # Cycle log
    # ------------------------------------------------------------------

    def log_cycle(self, entry: dict) -> None:
        """Append a JSON line to the cycle log. Adds timestamp if missing."""
        record = dict(entry)
        if "timestamp" not in record:
            record["timestamp"] = datetime.now(timezone.utc).isoformat()
        with self.cycle_log_path.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")
        logger.debug("Logged cycle entry: %s", record)

    def get_cycle_history(self, last_n: int | None = None) -> list[dict]:
        """Read the cycle log and return entries as a list of dicts."""
        if not self.cycle_log_path.exists():
            return []
        entries: list[dict] = []
        with self.cycle_log_path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line:
                    entries.append(json.loads(line))
        if last_n is not None:
            entries = entries[-last_n:]
        return entries

    # ------------------------------------------------------------------
    # Project log
    # ------------------------------------------------------------------

    def create_project(
        self,
        project_id: str,
        domain: str,
        base_model: str,
        baseline_score: float,
    ) -> None:
        """Create a new project entry with all required fields."""
        projects = self._load_projects()
        projects[project_id] = {
            "domain": domain,
            "base_model": base_model,
            "baseline_score": baseline_score,
            "started": datetime.now(timezone.utc).isoformat(),
            "current_score": baseline_score,
            "best_score": baseline_score,
            "total_cycles": 0,
            "successful_merges": 0,
            "failed_gates": 0,
            "current_base_version": None,
            "status": "active",
        }
        self._save_projects(projects)
        logger.info("Created project %s", project_id)

    def update_project(self, project_id: str, **kwargs: Any) -> None:
        """Update fields on an existing project."""
        projects = self._load_projects()
        if project_id not in projects:
            raise KeyError(f"Project '{project_id}' not found")
        projects[project_id].update(kwargs)
        self._save_projects(projects)
        logger.debug("Updated project %s: %s", project_id, kwargs)

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _load_projects(self) -> dict[str, dict]:
        """Load projects from the project log file."""
        if not self.project_log_path.exists():
            return {}
        with self.project_log_path.open("r", encoding="utf-8") as fh:
            return json.load(fh)

    def _save_projects(self, projects: dict[str, dict]) -> None:
        """Persist projects to the project log file."""
        with self.project_log_path.open("w", encoding="utf-8") as fh:
            json.dump(projects, fh, indent=2)

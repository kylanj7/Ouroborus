"""Loop state persistence — tracks evolution history and current stage in SQLite."""
from __future__ import annotations

import datetime
import json
import sqlite3
from dataclasses import asdict, dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class Stage(str, Enum):
    IDLE = "idle"
    GENERATING = "generating"
    FORMATTING = "formatting"
    TRANSFERRING = "transferring"
    TRAINING = "training"
    CONVERTING = "converting"
    EVALUATING = "evaluating"
    ANALYZING = "analyzing"


class StopReason(str, Enum):
    TARGET_REACHED = "TARGET_REACHED"
    REGRESSION_DETECTED = "REGRESSION_DETECTED"
    CONVERGED = "CONVERGED"
    MAX_EVOLUTIONS = "MAX_EVOLUTIONS"
    MANUAL_STOP = "MANUAL_STOP"
    ABORTED = "ABORTED"


@dataclass
class EvolutionRecord:
    evolution: int
    overall_score: float
    factual_accuracy: float
    completeness: float
    technical_precision: float
    best_score_so_far: float
    delta_from_previous: float
    delta_from_best: float
    consecutive_regressions: int
    consecutive_plateaus: int
    target_reached: bool
    domain_scores: dict[str, dict[str, float]] = field(default_factory=dict)
    dataset_path: str | None = None
    adapter_path: str | None = None
    gguf_path: str | None = None
    qftl_training_id: int | None = None
    qftl_eval_id: int | None = None
    qftl_convert_id: int | None = None
    started_at: str | None = None
    completed_at: str | None = None


@dataclass
class LoopState:
    loop_id: str
    status: str = "running"
    current_evolution: int = 0
    current_stage: str = Stage.IDLE.value
    stop_reason: str | None = None
    stop_requested: bool = False
    config_snapshot: dict[str, Any] = field(default_factory=dict)
    evolutions: list[EvolutionRecord] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""


_SCHEMA = """
CREATE TABLE IF NOT EXISTS loop_runs (
    loop_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'running',
    current_evolution INTEGER NOT NULL DEFAULT 0,
    current_stage TEXT NOT NULL DEFAULT 'idle',
    stop_reason TEXT,
    stop_requested INTEGER NOT NULL DEFAULT 0,
    config_snapshot TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evolution_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loop_id TEXT NOT NULL REFERENCES loop_runs(loop_id),
    evolution INTEGER NOT NULL,
    overall_score REAL NOT NULL,
    factual_accuracy REAL NOT NULL,
    completeness REAL NOT NULL,
    technical_precision REAL NOT NULL,
    best_score_so_far REAL NOT NULL,
    delta_from_previous REAL NOT NULL,
    delta_from_best REAL NOT NULL,
    consecutive_regressions INTEGER NOT NULL,
    consecutive_plateaus INTEGER NOT NULL,
    target_reached INTEGER NOT NULL DEFAULT 0,
    domain_scores TEXT NOT NULL DEFAULT '{}',
    dataset_path TEXT,
    adapter_path TEXT,
    gguf_path TEXT,
    qftl_training_id INTEGER,
    qftl_eval_id INTEGER,
    qftl_convert_id INTEGER,
    started_at TEXT,
    completed_at TEXT,
    UNIQUE(loop_id, evolution)
);
"""


class StateStore:
    """SQLite-backed state store for the evolution loop."""

    def __init__(self, db_path: Path | str | None = None):
        if db_path is None:
            db_path = Path(__file__).resolve().parent.parent.parent / "loop_state.db"
        self._db_path = str(db_path)
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._conn.executescript(_SCHEMA)

    def create_loop(self, loop_id: str, config_snapshot: dict) -> LoopState:
        now = datetime.datetime.utcnow().isoformat()
        self._conn.execute(
            "INSERT INTO loop_runs (loop_id, config_snapshot, created_at, updated_at) VALUES (?, ?, ?, ?)",
            (loop_id, json.dumps(config_snapshot), now, now),
        )
        self._conn.commit()
        return LoopState(
            loop_id=loop_id,
            config_snapshot=config_snapshot,
            created_at=now,
            updated_at=now,
        )

    def get_loop(self, loop_id: str) -> LoopState | None:
        row = self._conn.execute("SELECT * FROM loop_runs WHERE loop_id = ?", (loop_id,)).fetchone()
        if not row:
            return None
        evos = self._get_evolutions(loop_id)
        return LoopState(
            loop_id=row["loop_id"],
            status=row["status"],
            current_evolution=row["current_evolution"],
            current_stage=row["current_stage"],
            stop_reason=row["stop_reason"],
            stop_requested=bool(row["stop_requested"]),
            config_snapshot=json.loads(row["config_snapshot"]),
            evolutions=evos,
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def get_latest_loop(self) -> LoopState | None:
        row = self._conn.execute(
            "SELECT loop_id FROM loop_runs ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        return self.get_loop(row["loop_id"])

    def get_active_loop(self) -> LoopState | None:
        row = self._conn.execute(
            "SELECT loop_id FROM loop_runs WHERE status = 'running' ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        return self.get_loop(row["loop_id"])

    def update_stage(self, loop_id: str, evolution: int, stage: Stage):
        now = datetime.datetime.utcnow().isoformat()
        self._conn.execute(
            "UPDATE loop_runs SET current_evolution = ?, current_stage = ?, updated_at = ? WHERE loop_id = ?",
            (evolution, stage.value, now, loop_id),
        )
        self._conn.commit()

    def finish_loop(self, loop_id: str, stop_reason: StopReason):
        now = datetime.datetime.utcnow().isoformat()
        self._conn.execute(
            "UPDATE loop_runs SET status = 'stopped', stop_reason = ?, updated_at = ? WHERE loop_id = ?",
            (stop_reason.value, now, loop_id),
        )
        self._conn.commit()

    def request_stop(self, loop_id: str):
        now = datetime.datetime.utcnow().isoformat()
        self._conn.execute(
            "UPDATE loop_runs SET stop_requested = 1, updated_at = ? WHERE loop_id = ?",
            (now, loop_id),
        )
        self._conn.commit()

    def is_stop_requested(self, loop_id: str) -> bool:
        row = self._conn.execute(
            "SELECT stop_requested FROM loop_runs WHERE loop_id = ?", (loop_id,)
        ).fetchone()
        return bool(row and row["stop_requested"])

    def save_evolution(self, loop_id: str, record: EvolutionRecord):
        self._conn.execute(
            """INSERT OR REPLACE INTO evolution_records
               (loop_id, evolution, overall_score, factual_accuracy, completeness,
                technical_precision, best_score_so_far, delta_from_previous, delta_from_best,
                consecutive_regressions, consecutive_plateaus, target_reached,
                domain_scores, dataset_path, adapter_path, gguf_path,
                qftl_training_id, qftl_eval_id, qftl_convert_id, started_at, completed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                loop_id, record.evolution, record.overall_score,
                record.factual_accuracy, record.completeness, record.technical_precision,
                record.best_score_so_far, record.delta_from_previous, record.delta_from_best,
                record.consecutive_regressions, record.consecutive_plateaus,
                int(record.target_reached), json.dumps(record.domain_scores),
                record.dataset_path, record.adapter_path, record.gguf_path,
                record.qftl_training_id, record.qftl_eval_id, record.qftl_convert_id,
                record.started_at, record.completed_at,
            ),
        )
        self._conn.commit()

    def list_loops(self, limit: int = 20) -> list[dict]:
        rows = self._conn.execute(
            "SELECT loop_id, status, current_evolution, current_stage, stop_reason, created_at, updated_at "
            "FROM loop_runs ORDER BY created_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
        return [dict(r) for r in rows]

    def _get_evolutions(self, loop_id: str) -> list[EvolutionRecord]:
        rows = self._conn.execute(
            "SELECT * FROM evolution_records WHERE loop_id = ? ORDER BY evolution",
            (loop_id,),
        ).fetchall()
        records = []
        for r in rows:
            records.append(EvolutionRecord(
                evolution=r["evolution"],
                overall_score=r["overall_score"],
                factual_accuracy=r["factual_accuracy"],
                completeness=r["completeness"],
                technical_precision=r["technical_precision"],
                best_score_so_far=r["best_score_so_far"],
                delta_from_previous=r["delta_from_previous"],
                delta_from_best=r["delta_from_best"],
                consecutive_regressions=r["consecutive_regressions"],
                consecutive_plateaus=r["consecutive_plateaus"],
                target_reached=bool(r["target_reached"]),
                domain_scores=json.loads(r["domain_scores"]),
                dataset_path=r["dataset_path"],
                adapter_path=r["adapter_path"],
                gguf_path=r["gguf_path"],
                qftl_training_id=r["qftl_training_id"],
                qftl_eval_id=r["qftl_eval_id"],
                qftl_convert_id=r["qftl_convert_id"],
                started_at=r["started_at"],
                completed_at=r["completed_at"],
            ))
        return records

    def close(self):
        self._conn.close()

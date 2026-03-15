"""Closed-loop training state persistence -- tracks cycle history in SQLite."""
from __future__ import annotations

import datetime
import json
import sqlite3
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class Stage(str, Enum):
    BASELINE = "baseline"
    TALLYING = "tallying"
    RETRIEVING = "retrieving"
    CURATING = "curating"
    TRAINING = "training"
    MERGING = "merging"
    EVALUATING = "evaluating"
    GATING = "gating"


class StopReason(str, Enum):
    TARGET_REACHED = "target_reached"
    FAIL_CAP = "fail_cap"
    MAX_CYCLES = "max_cycles"
    MANUAL_STOP = "manual_stop"
    ABORTED = "aborted"


@dataclass
class CycleRecord:
    cycle: int
    benchmark_scores: dict[str, Any]
    gate_passed: bool | None
    gate_delta: float
    consecutive_gate_failures: int
    merged_model_path: str | None
    tally_metadata: dict[str, Any]
    dataset_path: str | None
    dataset_size: int
    adapter_path: str | None
    training_loss: float | None
    started_at: str | None
    completed_at: str | None


@dataclass
class LoopState:
    loop_id: str
    status: str = "running"
    current_cycle: int = 0
    current_stage: Stage = Stage.BASELINE
    stop_reason: StopReason | None = None
    stop_requested: bool = False
    config_snapshot: dict[str, Any] = field(default_factory=dict)
    created_at: str = ""
    updated_at: str = ""
    cycles: list[CycleRecord] = field(default_factory=list)


_SCHEMA = """
CREATE TABLE IF NOT EXISTS loop_runs (
    loop_id TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'running',
    current_cycle INTEGER NOT NULL DEFAULT 0,
    current_stage TEXT NOT NULL DEFAULT 'baseline',
    stop_reason TEXT,
    stop_requested INTEGER NOT NULL DEFAULT 0,
    config_snapshot TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cycle_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    loop_id TEXT NOT NULL REFERENCES loop_runs(loop_id),
    cycle INTEGER NOT NULL,
    benchmark_scores TEXT NOT NULL DEFAULT '{}',
    gate_passed INTEGER,
    gate_delta REAL NOT NULL DEFAULT 0.0,
    consecutive_gate_failures INTEGER NOT NULL DEFAULT 0,
    merged_model_path TEXT,
    tally_metadata TEXT NOT NULL DEFAULT '{}',
    dataset_path TEXT,
    dataset_size INTEGER NOT NULL DEFAULT 0,
    adapter_path TEXT,
    training_loss REAL,
    started_at TEXT,
    completed_at TEXT,
    UNIQUE(loop_id, cycle)
);
"""


def _now() -> str:
    return datetime.datetime.utcnow().isoformat()


def _gate_passed_to_int(value: bool | None) -> int | None:
    if value is None:
        return None
    return 1 if value else 0


def _int_to_gate_passed(value: int | None) -> bool | None:
    if value is None:
        return None
    return bool(value)


class LoopStateStore:
    """SQLite-backed state store for the closed-loop training mechanism."""

    def __init__(self, db_path: Path | str | None = None):
        if db_path is None:
            db_path = Path(__file__).resolve().parent.parent.parent / "loop_state_v2.db"
        self._db_path = str(db_path)
        self._conn = sqlite3.connect(self._db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._create_tables()

    def _create_tables(self):
        self._conn.executescript(_SCHEMA)
        self._conn.commit()

    def create_loop(self, loop_id: str, config_snapshot: dict) -> LoopState:
        now = _now()
        self._conn.execute(
            "INSERT INTO loop_runs (loop_id, config_snapshot, created_at, updated_at) "
            "VALUES (?, ?, ?, ?)",
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
        row = self._conn.execute(
            "SELECT * FROM loop_runs WHERE loop_id = ?", (loop_id,)
        ).fetchone()
        if not row:
            return None
        cycles = self._get_cycles(loop_id)
        stop_reason = row["stop_reason"]
        if stop_reason is not None:
            stop_reason = StopReason(stop_reason)
        return LoopState(
            loop_id=row["loop_id"],
            status=row["status"],
            current_cycle=row["current_cycle"],
            current_stage=Stage(row["current_stage"]),
            stop_reason=stop_reason,
            stop_requested=bool(row["stop_requested"]),
            config_snapshot=json.loads(row["config_snapshot"]),
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            cycles=cycles,
        )

    def update_stage(self, loop_id: str, cycle: int, stage: Stage):
        now = _now()
        self._conn.execute(
            "UPDATE loop_runs SET current_cycle = ?, current_stage = ?, updated_at = ? "
            "WHERE loop_id = ?",
            (cycle, stage.value, now, loop_id),
        )
        self._conn.commit()

    def save_cycle(self, loop_id: str, record: CycleRecord):
        self._conn.execute(
            """INSERT OR REPLACE INTO cycle_records
               (loop_id, cycle, benchmark_scores, gate_passed, gate_delta,
                consecutive_gate_failures, merged_model_path, tally_metadata,
                dataset_path, dataset_size, adapter_path, training_loss,
                started_at, completed_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                loop_id,
                record.cycle,
                json.dumps(record.benchmark_scores),
                _gate_passed_to_int(record.gate_passed),
                record.gate_delta,
                record.consecutive_gate_failures,
                record.merged_model_path,
                json.dumps(record.tally_metadata),
                record.dataset_path,
                record.dataset_size,
                record.adapter_path,
                record.training_loss,
                record.started_at,
                record.completed_at,
            ),
        )
        self._conn.commit()

    def finish_loop(self, loop_id: str, stop_reason: StopReason):
        now = _now()
        self._conn.execute(
            "UPDATE loop_runs SET status = 'stopped', stop_reason = ?, updated_at = ? "
            "WHERE loop_id = ?",
            (stop_reason.value, now, loop_id),
        )
        self._conn.commit()

    def request_stop(self, loop_id: str):
        now = _now()
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

    def get_active_loop(self) -> LoopState | None:
        row = self._conn.execute(
            "SELECT loop_id FROM loop_runs WHERE status = 'running' "
            "ORDER BY created_at DESC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        return self.get_loop(row["loop_id"])

    def close(self):
        self._conn.close()

    def _get_cycles(self, loop_id: str) -> list[CycleRecord]:
        rows = self._conn.execute(
            "SELECT * FROM cycle_records WHERE loop_id = ? ORDER BY cycle",
            (loop_id,),
        ).fetchall()
        records = []
        for r in rows:
            records.append(CycleRecord(
                cycle=r["cycle"],
                benchmark_scores=json.loads(r["benchmark_scores"]),
                gate_passed=_int_to_gate_passed(r["gate_passed"]),
                gate_delta=r["gate_delta"],
                consecutive_gate_failures=r["consecutive_gate_failures"],
                merged_model_path=r["merged_model_path"],
                tally_metadata=json.loads(r["tally_metadata"]),
                dataset_path=r["dataset_path"],
                dataset_size=r["dataset_size"],
                adapter_path=r["adapter_path"],
                training_loss=r["training_loss"],
                started_at=r["started_at"],
                completed_at=r["completed_at"],
            ))
        return records

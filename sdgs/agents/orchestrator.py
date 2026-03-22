"""Watcher agent -- SSE consumer that dispatches events to Fixer and Auditor.

Connects to the closed-loop SSE stream, routes events, and manages
the restart/resume lifecycle for the 2-cycle agent run.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING

import httpx

if TYPE_CHECKING:
    from sdgs.agents.auditor import Auditor
    from sdgs.agents.fixer import Fixer

logger = logging.getLogger(__name__)

BASE_URL = "http://localhost:8000"
API = f"{BASE_URL}/api/closed-loop"


@dataclass
class WatcherState:
    """Minimal state tracked by the Watcher during a run."""

    loop_id: str | None = None
    current_stage: str | None = None
    current_cycle: int = 0
    retry_count: int = 0
    max_retries: int = 3
    failed_configs: set = field(default_factory=set)
    target_cycles: int = 2
    completed_cycles: int = 0


# VRAM-related keywords to detect in log lines
_VRAM_PATTERNS = re.compile(
    r"(unload_all_models|unload_model|ensure_model_loaded|"
    r"cleanup_gpu|loaded in vram|restarting ollama)",
    re.IGNORECASE,
)

# Tally failure indicators
_TALLY_FAIL_PATTERNS = re.compile(
    r"(fallback_analysis|fallback clusters|json.*fail|"
    r"parse_tally_output.*error|valueerror.*tally)",
    re.IGNORECASE,
)


class Watcher:
    """SSE consumer that monitors the evolution loop and dispatches to agents."""

    def __init__(
        self,
        fixer: Fixer,
        auditor: Auditor,
        state: WatcherState | None = None,
        config_path: str = "configs/closed_loop.yaml",
    ):
        self._fixer = fixer
        self._auditor = auditor
        self._state = state or WatcherState()
        self._config_path = config_path

    @property
    def state(self) -> WatcherState:
        return self._state

    # ------------------------------------------------------------------
    # Server management
    # ------------------------------------------------------------------

    @staticmethod
    def is_server_running() -> bool:
        """Check if the SDGS server is responding on port 8000."""
        try:
            resp = httpx.get(f"{API}/status", timeout=3)
            return resp.status_code == 200
        except (httpx.ConnectError, httpx.TimeoutException):
            return False

    @staticmethod
    def boot_server() -> subprocess.Popen:
        """Start `sdgs serve` as a managed subprocess."""
        logger.info("Starting sdgs serve...")
        proc = subprocess.Popen(
            [sys.executable, "-m", "sdgs", "serve"],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
        )
        # Wait for server to become healthy
        for _ in range(30):
            time.sleep(2)
            if Watcher.is_server_running():
                logger.info("Server is ready on port 8000")
                return proc
        raise RuntimeError("Server did not become ready within 60 seconds")

    # ------------------------------------------------------------------
    # Loop control via REST API
    # ------------------------------------------------------------------

    def start_loop(
        self,
        resume_from: str | None = None,
        resume_loop_id: str | None = None,
        overrides: dict | None = None,
    ) -> str:
        """POST /start and return the loop_id."""
        body: dict = {"config_path": self._config_path}
        if overrides:
            body["overrides"] = overrides
        if resume_from:
            body["resume_from"] = resume_from
        if resume_loop_id:
            body["resume_loop_id"] = resume_loop_id

        resp = httpx.post(f"{API}/start", json=body, timeout=10)
        resp.raise_for_status()
        data = resp.json()
        loop_id = data["loop_id"]
        self._state.loop_id = loop_id
        logger.info("Loop started: %s", loop_id)
        return loop_id

    def stop_loop(self) -> None:
        """POST /stop for graceful shutdown."""
        resp = httpx.post(f"{API}/stop", timeout=10)
        if resp.status_code == 200:
            logger.info("Stop requested")
        else:
            logger.warning("Stop request returned %d", resp.status_code)

    def get_status(self) -> dict:
        """GET /status."""
        resp = httpx.get(f"{API}/status", timeout=5)
        resp.raise_for_status()
        return resp.json()

    def get_history(self, loop_id: str | None = None) -> dict:
        """GET /history."""
        params = {}
        if loop_id:
            params["loop_id"] = loop_id
        resp = httpx.get(f"{API}/history", params=params, timeout=10)
        resp.raise_for_status()
        return resp.json()

    # ------------------------------------------------------------------
    # SSE event loop
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Main event loop: subscribe to SSE and dispatch events."""
        loop_id = self._state.loop_id
        if not loop_id:
            raise RuntimeError("No loop_id set -- call start_loop() first")

        self._auditor.bootstrap(loop_id)

        last_id = -1
        while True:
            try:
                last_id = await self._consume_sse(last_id)
            except httpx.ConnectError:
                logger.warning("SSE connection lost, reconnecting in 3s...")
                await asyncio.sleep(3)
                continue
            except _StreamRestarted:
                # Fixer triggered a restart -- reset event counter for new stream
                last_id = -1
                continue
            except _StreamEnded:
                break

        # Stream ended -- check final status
        status = self.get_status()
        final = status.get("status", "unknown")
        logger.info("Loop finished with status: %s", final)
        self._auditor.finalize(status=final)

    async def _consume_sse(self, last_id: int) -> int:
        """Connect to SSE stream and process events. Returns last processed event ID."""
        url = f"{API}/events?last_id={last_id}"
        async with httpx.AsyncClient(timeout=None) as client:
            async with client.stream("GET", url) as response:
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        raw = line[6:]
                        try:
                            event = json.loads(raw)
                        except json.JSONDecodeError:
                            continue

                        event_id = event.get("id", last_id)
                        if event_id > last_id:
                            last_id = event_id

                        action = await self._handle_event(event)
                        if action == "stop":
                            raise _StreamEnded()

                    elif line.startswith("id: "):
                        try:
                            last_id = int(line[4:])
                        except ValueError:
                            pass

        return last_id

    async def _handle_event(self, event: dict) -> str | None:
        """Dispatch a single SSE event. Returns 'stop' to end the loop."""
        etype = event.get("type", "")
        data = event.get("data", "")

        if etype == "stage":
            self._on_stage(data)

        elif etype == "log":
            self._on_log(data)

        elif etype == "error":
            return await self._on_error(data)

        elif etype == "status":
            return await self._on_status(data)

        elif etype == "done":
            return "stop"

        return None

    # ------------------------------------------------------------------
    # Event handlers
    # ------------------------------------------------------------------

    def _on_stage(self, stage_name: str) -> None:
        """Handle a stage transition event."""
        prev_stage = self._state.current_stage
        self._state.current_stage = stage_name

        # Reset retry count on every stage advance (I1 fix)
        self._state.retry_count = 0

        # Detect cycle advance: when we go back to TALLYING, it's a new cycle
        if stage_name == "tallying" and prev_stage not in (None, "baseline"):
            self._state.current_cycle += 1
        elif stage_name == "tallying" and prev_stage == "baseline":
            self._state.current_cycle = 1

        cycle = self._state.current_cycle
        logger.info("Stage: %s (cycle %d)", stage_name, cycle)
        self._auditor.on_stage(stage_name, cycle)

        # Capture VRAM snapshot at stage boundaries for headroom tracking
        if stage_name in ("training", "merging", "evaluating", "tallying", "curating"):
            self._auditor.capture_vram_snapshot(f"{stage_name} (cycle {cycle})")

        # When gating stage completes (signaled by next stage or status event),
        # pull the gate result. Detect completion by seeing a non-gating stage
        # after gating was the previous stage.
        if prev_stage == "gating" and self._state.loop_id:
            self._auditor.on_gate_result(self._state.loop_id)
            if self.check_gate_and_cycles():
                return  # Target cycles reached, stop sent

    def _on_log(self, line: str) -> None:
        """Scan log lines for patterns the Fixer and Auditor care about."""
        # VRAM events
        if _VRAM_PATTERNS.search(line):
            self._auditor.on_vram_event(line)

        # Tally failures
        if self._state.current_stage == "tallying" and _TALLY_FAIL_PATTERNS.search(line):
            logger.warning("Tally failure detected: %s", line[:200])
            self._fixer.on_tally_failure_detected(line)

        # Training logs
        if self._state.current_stage == "training":
            self._auditor.on_training_log(line)

    async def _on_error(self, error_text: str) -> str | None:
        """Handle an error event. Dispatches to Fixer for recovery."""
        stage = self._state.current_stage or "unknown"
        loop_id = self._state.loop_id or ""
        logger.error("Error in stage %s: %s", stage, error_text[:300])

        result = self._fixer.handle_error(
            loop_id=loop_id,
            error_text=error_text,
            current_stage=stage,
            retry_count=self._state.retry_count,
            max_retries=self._state.max_retries,
            failed_configs=self._state.failed_configs,
        )

        if result.get("action") == "restart":
            self._state.retry_count += 1
            if result.get("config_key"):
                self._state.failed_configs.add(result["config_key"])
            # The actual restart happens after the status=failed event
            return None

        if result.get("action") == "stop":
            self._auditor.on_fixer_intervention("hard_stop", {
                "reason": result.get("reason", "unrecoverable error"),
                "error": error_text[:500],
            })
            return None

        return None

    async def _on_status(self, status: str) -> str | None:
        """Handle a status change event."""
        logger.info("Status: %s", status)

        if status == "completed":
            # Pull final gate result before finishing
            if self._state.loop_id:
                self._auditor.on_gate_result(self._state.loop_id)
            return "stop"

        if status == "failed":
            return await self._handle_failure()

        return None

    async def _handle_failure(self) -> str | None:
        """Attempt recovery after a loop failure."""
        loop_id = self._state.loop_id or ""
        stage = self._state.current_stage or "unknown"

        # Check for pending tally fix first (S2: apply end-to-end)
        tally_fix = self._fixer.get_tally_fix()
        if tally_fix and stage == "tallying":
            cycle = self._state.current_cycle
            logger.info("Applying tally fix to DB (cycle %d)", cycle)
            self._fixer.apply_tally_fix_to_db(loop_id, cycle, tally_fix)
            self._auditor.on_fixer_intervention("tally_sanitized", {
                "strategy": "sanitizer",
                "cycle": cycle,
            })

            await asyncio.sleep(5)
            try:
                self.start_loop(
                    resume_from="retrieving",
                    resume_loop_id=loop_id,
                )
                raise _StreamRestarted()
            except httpx.HTTPStatusError as exc:
                logger.error("Tally fix restart failed: %s", exc)
                return "stop"

        # Check if Fixer has a pending restart action (training/merge errors)
        recovery = self._fixer.get_recovery_action(
            loop_id=loop_id,
            current_stage=stage,
            retry_count=self._state.retry_count,
            max_retries=self._state.max_retries,
        )

        if recovery and recovery.get("action") == "restart":
            resume_from = recovery.get("resume_from", stage)
            logger.info(
                "Fixer recovery: restarting from %s (attempt %d/%d)",
                resume_from, self._state.retry_count + 1, self._state.max_retries,
            )

            # Log the intervention
            self._auditor.on_fixer_intervention(
                "config_adjustment", recovery.get("details", {})
            )

            # Brief pause for GPU cleanup
            await asyncio.sleep(5)

            # Restart with resume
            try:
                self.start_loop(
                    resume_from=resume_from,
                    resume_loop_id=loop_id,
                    overrides=recovery.get("overrides"),
                )
                raise _StreamRestarted()
            except httpx.HTTPStatusError as exc:
                logger.error("Restart failed: %s", exc)
                return "stop"

        # No recovery possible
        logger.info("No recovery available -- stopping")
        return "stop"

    # ------------------------------------------------------------------
    # Gate tracking
    # ------------------------------------------------------------------

    def check_gate_and_cycles(self) -> bool:
        """Check if we've hit our target cycle count. Called after gate events."""
        if self._state.loop_id:
            self._auditor.on_gate_result(self._state.loop_id)

        history = self.get_history(self._state.loop_id)
        cycles = history.get("cycles", [])
        passed = sum(1 for c in cycles if c.get("gate_passed") is True)
        self._state.completed_cycles = passed

        if passed >= self._state.target_cycles:
            logger.info(
                "Target reached: %d/%d cycles passed gate",
                passed, self._state.target_cycles,
            )
            self.stop_loop()
            return True
        return False


class _StreamEnded(Exception):
    """Raised to signal the SSE stream has ended."""


class _StreamRestarted(Exception):
    """Raised when the Fixer triggers a restart -- resets SSE event counter."""

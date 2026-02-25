"""HTTP bridge client for the QFTL REST API."""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import requests

from .config import QFTLConfig

log = logging.getLogger(__name__)


class BridgeError(Exception):
    """Raised when the QFTL API returns an error."""
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status


@dataclass
class TrainingStatus:
    id: int
    run_name: str
    status: str
    current_step: int = 0
    total_steps: int = 0
    current_loss: float | None = None
    adapter_path: str | None = None
    error_message: str | None = None


@dataclass
class ConversionStatus:
    status: str
    output_path: str | None = None


@dataclass
class EvaluationStatus:
    id: int
    status: str
    factual_accuracy: float | None = None
    completeness: float | None = None
    technical_precision: float | None = None
    overall_accuracy: float | None = None
    samples_scored: int = 0
    error_message: str | None = None


@dataclass
class EvaluationResults:
    id: int
    status: str
    overall_scores: dict[str, float | None]
    detailed_results: list[dict[str, Any]]


class QFTLBridge:
    """Synchronous HTTP client wrapping the QFTL REST API."""

    def __init__(self, config: QFTLConfig):
        self._base = config.base_url.rstrip("/")
        self._timeout = config.request_timeout_seconds
        self._poll_interval = config.poll_interval_seconds
        self._username = config.username
        self._password = config.password
        self._session = requests.Session()

        if self._username and self._password:
            self._login()

    # ------------------------------------------------------------------
    # Auth
    # ------------------------------------------------------------------

    def _login(self):
        """Authenticate with the QFTL API and store the JWT token."""
        data = self._post("/api/auth/login", {
            "username": self._username,
            "password": self._password,
        }, auth_required=False)
        token = data.get("access_token")
        if not token:
            raise BridgeError("Login failed: no access_token in response")
        self._session.headers["Authorization"] = f"Bearer {token}"
        log.info("Authenticated with QFTL as %s", self._username)

    # ------------------------------------------------------------------
    # Health
    # ------------------------------------------------------------------

    def health_check(self) -> bool:
        try:
            r = self._get("/api/health")
            return r.get("status") == "ok"
        except Exception:
            return False

    # ------------------------------------------------------------------
    # Training
    # ------------------------------------------------------------------

    def start_training(
        self,
        model_config_name: str,
        dataset_config_name: str,
        training_config_name: str,
        dataset_path: str | None = None,
        parameter_overrides: dict | None = None,
    ) -> TrainingStatus:
        body: dict[str, Any] = {
            "model_config_name": model_config_name,
            "dataset_config_name": dataset_config_name,
            "training_config_name": training_config_name,
        }
        if dataset_path:
            body["dataset_path"] = dataset_path
        if parameter_overrides:
            body.update(parameter_overrides)
        t0 = time.monotonic()
        data = self._post("/api/training/start", body)
        log.info("[perf] start_training API call %.2fs", time.monotonic() - t0)
        return self._parse_training_status(data)

    def get_training_status(self, run_id: int) -> TrainingStatus:
        data = self._get(f"/api/training/{run_id}")
        return self._parse_training_status(data)

    def poll_training(self, run_id: int, check_stop: callable = None) -> TrainingStatus:
        """Poll until training completes, fails, or is cancelled."""
        t0 = time.monotonic()
        polls = 0
        while True:
            status = self.get_training_status(run_id)
            polls += 1
            log.info("Training %d: %s  step %d/%d  loss=%s",
                      run_id, status.status, status.current_step, status.total_steps, status.current_loss)
            if status.status in ("completed", "failed", "cancelled"):
                log.info("[perf] poll_training run=%d  %d polls  %.1fs total", run_id, polls, time.monotonic() - t0)
                return status
            if check_stop and check_stop():
                log.info("[perf] poll_training run=%d  stopped after %d polls  %.1fs", run_id, polls, time.monotonic() - t0)
                return status
            time.sleep(self._poll_interval)

    # ------------------------------------------------------------------
    # Model conversion (synchronous)
    # ------------------------------------------------------------------

    def start_conversion(
        self,
        adapter_path: str,
        quant_method: str = "q4_k_m",
        output_name: str | None = None,
    ) -> ConversionStatus:
        """Merge LoRA adapter and convert to GGUF. This is synchronous."""
        body: dict[str, Any] = {
            "adapter_path": adapter_path,
            "quant_method": quant_method,
        }
        if output_name:
            body["output_name"] = output_name
        t0 = time.monotonic()
        data = self._post("/api/training/convert", body)
        log.info("[perf] start_conversion API call %.2fs", time.monotonic() - t0)
        return ConversionStatus(
            status=data.get("status", "completed"),
            output_path=data.get("gguf_path"),
        )

    # ------------------------------------------------------------------
    # Evaluation
    # ------------------------------------------------------------------

    def start_evaluation(
        self,
        model_path: str,
        test_dataset_path: str,
        max_samples: int = 50,
        judge_model: str = "nemotron-3-nano:latest",
        training_run_id: int | None = None,
    ) -> EvaluationStatus:
        body: dict[str, Any] = {
            "model_path": model_path,
            "test_dataset_path": test_dataset_path,
            "max_samples": max_samples,
            "judge_model": judge_model,
        }
        if training_run_id is not None:
            body["training_run_id"] = training_run_id
        t0 = time.monotonic()
        data = self._post("/api/training/evaluate", body)
        log.info("[perf] start_evaluation API call %.2fs", time.monotonic() - t0)
        return self._parse_eval_status(data)

    def get_evaluation_status(self, eval_id: int) -> EvaluationStatus:
        data = self._get(f"/api/training/evaluations/{eval_id}")
        return self._parse_eval_status(data)

    def get_evaluation_detail(self, eval_id: int) -> EvaluationResults:
        """Get full evaluation detail including per-sample results."""
        data = self._get(f"/api/training/evaluations/{eval_id}")
        return EvaluationResults(
            id=data["id"],
            status=data.get("status", ""),
            overall_scores={
                "factual_accuracy": data.get("factual_accuracy"),
                "completeness": data.get("completeness"),
                "technical_precision": data.get("technical_precision"),
                "overall_accuracy": data.get("overall_accuracy"),
            },
            detailed_results=data.get("per_sample_results") or [],
        )

    def poll_evaluation(self, eval_id: int, check_stop: callable = None) -> EvaluationStatus:
        t0 = time.monotonic()
        polls = 0
        while True:
            status = self.get_evaluation_status(eval_id)
            polls += 1
            log.info("Evaluation %d: %s  scored=%d  overall=%s",
                      eval_id, status.status, status.samples_scored, status.overall_accuracy)
            if status.status in ("completed", "failed", "cancelled"):
                log.info("[perf] poll_evaluation eval=%d  %d polls  %.1fs total", eval_id, polls, time.monotonic() - t0)
                return status
            if check_stop and check_stop():
                log.info("[perf] poll_evaluation eval=%d  stopped after %d polls  %.1fs", eval_id, polls, time.monotonic() - t0)
                return status
            time.sleep(self._poll_interval)

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _get(self, path: str) -> Any:
        t0 = time.monotonic()
        r = self._session.get(f"{self._base}{path}", timeout=self._timeout)
        elapsed = time.monotonic() - t0
        if elapsed > 1.0:
            log.debug("[perf] GET %s  %.2fs", path, elapsed)
        self._raise_for_status(r)
        return r.json()

    def _post(self, path: str, body: dict, auth_required: bool = True) -> Any:
        t0 = time.monotonic()
        r = self._session.post(f"{self._base}{path}", json=body, timeout=self._timeout)
        elapsed = time.monotonic() - t0
        if elapsed > 1.0:
            log.debug("[perf] POST %s  %.2fs", path, elapsed)
        self._raise_for_status(r)
        return r.json()

    @staticmethod
    def _raise_for_status(r: requests.Response):
        if not r.ok:
            try:
                detail = r.json().get("detail", r.text)
            except Exception:
                detail = r.text
            raise BridgeError(f"QFTL API error ({r.status_code}): {detail}", status=r.status_code)

    @staticmethod
    def _parse_training_status(data: dict) -> TrainingStatus:
        return TrainingStatus(
            id=data["id"],
            run_name=data.get("run_name", ""),
            status=data.get("status", "unknown"),
            current_step=data.get("current_step", 0),
            total_steps=data.get("total_steps") or 0,
            current_loss=data.get("final_loss"),
            adapter_path=data.get("adapter_path"),
            error_message=data.get("error_message"),
        )

    @staticmethod
    def _parse_eval_status(data: dict) -> EvaluationStatus:
        return EvaluationStatus(
            id=data["id"],
            status=data.get("status", "unknown"),
            factual_accuracy=data.get("factual_accuracy"),
            completeness=data.get("completeness"),
            technical_precision=data.get("technical_precision"),
            overall_accuracy=data.get("overall_accuracy"),
            samples_scored=data.get("samples_scored", 0),
            error_message=data.get("error_message"),
        )

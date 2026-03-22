"""Ollama model load/unload helpers for VRAM management."""
import logging
import requests

logger = logging.getLogger(__name__)
OLLAMA_BASE = "http://localhost:11434"

def unload_model(model_name: str):
    """Unload a model from Ollama VRAM via keep_alive: 0."""
    try:
        requests.post(f"{OLLAMA_BASE}/api/generate",
                      json={"model": model_name, "keep_alive": 0}, timeout=30)
        logger.info(f"Unloaded model {model_name} from VRAM")
    except Exception as e:
        logger.warning(f"Failed to unload {model_name}: {e}")


def unload_all_models():
    """Unload ALL models currently loaded in Ollama to free VRAM."""
    try:
        resp = requests.get(f"{OLLAMA_BASE}/api/ps", timeout=5)
        resp.raise_for_status()
        models = resp.json().get("models", [])
        for m in models:
            name = m.get("name", "")
            if name:
                unload_model(name)
        if models:
            logger.info("Unloaded %d Ollama model(s) from VRAM", len(models))
    except Exception as e:
        logger.debug("Ollama not reachable or no models loaded: %s", e)

def restart_ollama_service():
    """Restart the Ollama systemd service so it re-detects GPUs.

    Ollama can lose GPU access if it was started while GPUs were busy.
    Restarting forces a fresh CUDA device scan.
    """
    import subprocess
    import time

    try:
        subprocess.run(["systemctl", "restart", "ollama"], check=True, timeout=30)
        logger.info("Restarted Ollama service")
        # Wait for Ollama to be ready
        for _ in range(15):
            time.sleep(2)
            try:
                resp = requests.get(f"{OLLAMA_BASE}/api/version", timeout=3)
                if resp.ok:
                    logger.info("Ollama service is ready")
                    return
            except Exception:
                pass
        logger.warning("Ollama service did not become ready in time")
    except Exception as e:
        logger.warning(f"Failed to restart Ollama service: {e}")


def cleanup_gpu():
    """Full GPU cleanup -- unload all Ollama models and free PyTorch CUDA memory.

    Call this on loop failure/exit to ensure no VRAM is left allocated.
    """
    # 1. Unload all Ollama models
    unload_all_models()

    # 2. Free any PyTorch CUDA memory in this process
    try:
        import gc
        import torch
        if torch.cuda.is_available():
            torch.cuda.empty_cache()
            gc.collect()
            torch.cuda.empty_cache()
            allocated = torch.cuda.memory_allocated() / 1e9
            reserved = torch.cuda.memory_reserved() / 1e9
            logger.info(
                "PyTorch CUDA cleanup: allocated=%.2f GB, reserved=%.2f GB",
                allocated, reserved,
            )
    except ImportError:
        pass
    except Exception as e:
        logger.warning(f"PyTorch CUDA cleanup failed: {e}")

    # 3. Kill any orphaned GPU processes spawned by this loop
    try:
        import subprocess
        result = subprocess.run(
            ["nvidia-smi", "--query-compute-apps=pid", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=10,
        )
        import os
        my_pid = os.getpid()
        for line in result.stdout.strip().split("\n"):
            line = line.strip()
            if not line:
                continue
            try:
                pid = int(line)
                # Check if this process is a child of us
                ppid_result = subprocess.run(
                    ["ps", "-o", "ppid=", "-p", str(pid)],
                    capture_output=True, text=True, timeout=5,
                )
                ppid = int(ppid_result.stdout.strip())
                if ppid == my_pid:
                    os.kill(pid, 9)
                    logger.info("Killed orphaned GPU child process PID=%d", pid)
            except (ValueError, ProcessLookupError, OSError):
                pass
    except Exception as e:
        logger.debug("Orphan GPU process check failed: %s", e)

    logger.info("GPU cleanup complete")


def ensure_model_loaded(model_name: str):
    """Ensure a model is loaded in Ollama GPU.

    First checks if Ollama has GPU access. If not, restarts the service.
    Then loads the model with num_gpu=99 to force all layers onto GPU.
    """
    # Check if Ollama has GPU access
    try:
        resp = requests.post(f"{OLLAMA_BASE}/api/generate",
                             json={"model": model_name, "prompt": "", "keep_alive": "10m",
                                   "options": {"num_gpu": 99}}, timeout=180)
        resp.raise_for_status()

        # Verify it actually went on GPU
        ps_resp = requests.get(f"{OLLAMA_BASE}/api/ps", timeout=5)
        ps_resp.raise_for_status()
        models = ps_resp.json().get("models", [])
        for m in models:
            if m.get("name") == model_name and m.get("size_vram", 0) == 0:
                logger.warning(f"{model_name} loaded on CPU -- restarting Ollama to re-detect GPUs")
                # Unload first
                unload_model(model_name)
                restart_ollama_service()
                # Retry load
                requests.post(f"{OLLAMA_BASE}/api/generate",
                              json={"model": model_name, "prompt": "", "keep_alive": "10m",
                                    "options": {"num_gpu": 99}}, timeout=180)
                logger.info(f"Retried loading {model_name} after Ollama restart")
                return

        logger.info(f"Model {model_name} loaded in VRAM")
    except Exception as e:
        logger.error(f"Failed to load {model_name}: {e}")
        raise

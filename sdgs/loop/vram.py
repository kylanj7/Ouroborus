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

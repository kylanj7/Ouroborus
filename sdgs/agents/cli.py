"""CLI entry point for the Agentic Management Team.

Usage:
    python -m sdgs.agents [--cycles 2] [--config configs/closed_loop.yaml] [--no-serve]
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import sys

logger = logging.getLogger("sdgs.agents")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Agentic Management Team for the Evolution Loop",
    )
    parser.add_argument(
        "--cycles",
        type=int,
        default=2,
        help="Number of GATE-passed cycles before stopping (default: 2)",
    )
    parser.add_argument(
        "--config",
        default="configs/closed_loop.yaml",
        help="Path to loop config YAML (default: configs/closed_loop.yaml)",
    )
    parser.add_argument(
        "--no-serve",
        action="store_true",
        help="Skip booting `sdgs serve` (assume server already running)",
    )
    args = parser.parse_args()

    # Configure logging
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-8s [%(name)s] %(message)s",
        datefmt="%H:%M:%S",
    )

    # Import after logging is configured
    from sdgs.agents.auditor import Auditor
    from sdgs.agents.fixer import Fixer
    from sdgs.agents.orchestrator import Watcher, WatcherState
    from sdgs.loop.state_v2 import LoopStateStore

    # Boot server if needed
    server_proc = None
    if not args.no_serve:
        if Watcher.is_server_running():
            logger.info("Server already running on port 8000")
        else:
            try:
                server_proc = Watcher.boot_server()
            except RuntimeError as exc:
                logger.error("Failed to start server: %s", exc)
                sys.exit(1)

    # Initialize agents
    state_store = LoopStateStore()
    fixer = Fixer(config_path=args.config)
    auditor = Auditor(state_store=state_store)
    watcher_state = WatcherState(target_cycles=args.cycles)
    watcher = Watcher(
        fixer=fixer,
        auditor=auditor,
        state=watcher_state,
        config_path=args.config,
    )

    # Start the loop
    try:
        loop_id = watcher.start_loop()
        logger.info("Evolution loop started: %s", loop_id)
        logger.info("Target: %d GATE-passed cycles", args.cycles)

        # Run the async event loop
        asyncio.run(watcher.run())

    except KeyboardInterrupt:
        logger.info("Interrupted -- requesting graceful stop")
        try:
            watcher.stop_loop()
        except Exception:
            pass
        auditor.finalize(status="interrupted")

    except Exception as exc:
        logger.error("Fatal error: %s", exc, exc_info=True)
        auditor.finalize(status="error")
        sys.exit(1)

    finally:
        output = auditor.record
        logger.info("Evolution progress: %s", auditor._output)
        logger.info(
            "Completed %d cycles, %d fixer interventions",
            len(output.cycles),
            output.total_fixer_interventions,
        )


if __name__ == "__main__":
    main()

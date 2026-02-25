"""CLI entry point for the Synthetic Dataset Generation Suite."""
import json
from pathlib import Path

import click
import yaml

CONFIGS_DIR = Path(__file__).parent.parent / "configs"
TASKS_DIR = CONFIGS_DIR / "tasks"


def _load_task_config(task_name: str) -> dict:
    """Load a task YAML config by name."""
    config_path = TASKS_DIR / f"{task_name}.yaml"
    if not config_path.exists():
        available = ", ".join(sorted(p.stem for p in TASKS_DIR.glob("*.yaml")))
        raise click.ClickException(
            f"Unknown task: '{task_name}'. Available: {available}"
        )
    with open(config_path) as f:
        return yaml.safe_load(f)


@click.group()
@click.version_option(package_name="synthetic-dataset-generation-suite")
def cli():
    """Synthetic Dataset Generation Suite — multi-provider reasoning dataset pipeline."""


@cli.command()
@click.option("--task", required=True, help="Task config name (e.g. quantum_reasoning)")
@click.option("--output", "-o", required=True, help="Output JSON file path")
@click.option("--sample", "-n", type=int, default=None, help="Only extract first N examples")
def extract(task, output, sample):
    """Extract Q&A data from the configured source."""
    from .extract import extract_data

    task_config = _load_task_config(task)
    count = extract_data(task_config, output, sample_size=sample)
    click.echo(f"Done. {count} examples written to {output}")


@cli.command()
@click.option("--task", required=True, help="Task config name")
@click.option("--provider", required=True, help="Provider name (e.g. ollama, openai, anthropic)")
@click.option("--model", default=None, help="Override default model for the provider")
@click.option("--api-key", default=None, help="API key (overrides env var)")
@click.option("--input", "-i", "input_file", required=True, help="Input JSON file (from extract)")
@click.option("--output", "-o", default=None, help="Output JSONL file (default: data/<task>_output.jsonl)")
@click.option("--test", type=int, default=None, help="Test mode: generate N samples with detailed validation")
@click.option("--no-resume", is_flag=True, help="Start fresh, don't resume from existing output")
def generate(task, provider, model, api_key, input_file, output, test, no_resume):
    """Generate reasoning dataset using any LLM provider."""
    from .generate import run_generation, run_test
    from .providers import get_client

    task_config = _load_task_config(task)
    client, model_name, extra_params = get_client(provider, model=model, api_key=api_key)

    click.echo(f"Provider: {provider} | Model: {model_name}")

    with open(input_file) as f:
        input_data = json.load(f)

    if test is not None:
        run_test(client, model_name, extra_params, task_config, input_data, num_samples=test)
    else:
        if output is None:
            output = f"data/{task}_output.jsonl"
        run_generation(
            client, model_name, extra_params, task_config,
            input_data, output, resume=not no_resume,
        )


@cli.command("filter")
@click.argument("input_file")
@click.option("--output", "-o", default=None, help="Output JSONL file")
@click.option("--lenient", is_flag=True, help="Only reject critical failures (missing answer tags)")
@click.option("--no-heal", is_flag=True, help="Disable healing of broken samples")
@click.option("--task", default=None, help="Task config name (for domain-specific validation rules)")
def filter_cmd(input_file, output, lenient, no_heal, task):
    """Filter and validate a generated JSONL dataset."""
    from .filter import filter_dataset

    validation_rules = None
    if task:
        task_config = _load_task_config(task)
        validation_rules = task_config.get("validation", {})

    filter_dataset(
        input_file,
        output_file=output,
        strict=not lenient,
        heal=not no_heal,
        validation_rules=validation_rules,
    )


@cli.command()
@click.argument("dataset")
@click.option("--samples", "-n", type=int, default=5, help="Number of samples to show")
@click.option("--random", "-r", "use_random", is_flag=True, help="Random sampling")
@click.option("--stats", "-s", "stats_only", is_flag=True, help="Show statistics only")
@click.option("--offset", type=int, default=0, help="Start from this sample index")
@click.option("--task", default=None, help="Task config name (for topic keywords)")
def qa(dataset, samples, use_random, stats_only, offset, task):
    """Inspect and analyze a reasoning dataset."""
    from .qa import run_qa

    topics = None
    if task:
        task_config = _load_task_config(task)
        topics = task_config.get("validation", {}).get("topics", [])

    run_qa(
        dataset,
        num_samples=samples,
        use_random=use_random,
        stats_only=stats_only,
        offset=offset,
        topics=topics,
    )


@cli.command()
@click.option("--topic", required=True, help="Research topic to search for")
@click.option("--provider", default=None, help="LLM provider for Q&A generation")
@click.option("--model", default=None, help="Override default model")
@click.option("--api-key", default=None, help="API key (overrides env var)")
@click.option("--task", default="paper_qa", help="Task config for generation prompts")
@click.option("--max-papers", default=20, help="Max papers to search for")
@click.option("--top-n", default=5, help="Fetch full text for top N papers (rest use abstracts)")
@click.option("--output", "-o", required=True, help="Output JSONL path")
@click.option("--collect-only", is_flag=True, help="Only collect paper metadata, skip generation")
def scrape(topic, provider, model, api_key, task, max_papers, top_n, output, collect_only):
    """Search scholarly papers, extract content, and generate Q&A datasets."""
    from .scrape import run_scrape

    if not collect_only and not provider:
        raise click.ClickException("--provider is required unless using --collect-only")

    run_scrape(
        topic=topic,
        provider=provider,
        model=model,
        api_key=api_key,
        task_name=task,
        max_papers=max_papers,
        top_n=top_n,
        output_path=output,
        collect_only=collect_only,
    )


@cli.command()
def providers():
    """List available LLM providers."""
    from .providers import list_providers, load_provider_config

    for name in list_providers():
        config = load_provider_config(name)
        key_info = config.get("api_key_env", "none (local)")
        click.echo(f"  {name:15s}  model={config['default_model']:30s}  key={key_info}")


@cli.command()
def tasks():
    """List available task configs."""
    for p in sorted(TASKS_DIR.glob("*.yaml")):
        with open(p) as f:
            config = yaml.safe_load(f)
        click.echo(f"  {p.stem:25s}  {config.get('name', '')}")


@cli.group()
def loop():
    """Evolution loop — autonomous generate → train → evaluate → feedback cycle."""


@loop.command("start")
@click.option("--config", "config_path", default=None, help="Path to loop config YAML (default: configs/loop.yaml)")
def loop_start(config_path):
    """Start a new evolution loop."""
    import logging
    from .loop.config import load_loop_config
    from .loop.orchestrator import Orchestrator

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")
    cfg = load_loop_config(config_path)
    orch = Orchestrator(config=cfg)

    click.echo(f"Starting evolution loop (max {cfg.evolution.max_evolutions} evolutions, target {cfg.evolution.target_accuracy}%)")
    click.echo(f"  QFTL: {cfg.qftl.base_url}")
    click.echo(f"  Domains: {', '.join(cfg.generation.domains)}")
    click.echo(f"  Model: {cfg.training.model_config}")
    click.echo()

    loop_id = orch.run()
    state = orch.store.get_loop(loop_id)
    click.echo()
    click.echo(f"Loop {loop_id} finished — {state.status}")
    if state.stop_reason:
        click.echo(f"  Reason: {state.stop_reason}")
    if state.evolutions:
        last = state.evolutions[-1]
        click.echo(f"  Final score: {last.overall_score:.1f}%")
        click.echo(f"  Best score:  {last.best_score_so_far:.1f}%")
        click.echo(f"  Evolutions:  {len(state.evolutions)}")


@loop.command("status")
def loop_status():
    """Show the status of the most recent evolution loop."""
    from .loop.state import StateStore

    store = StateStore()
    state = store.get_latest_loop()
    if not state:
        click.echo("No loop runs found.")
        return

    click.echo(f"Loop: {state.loop_id}")
    click.echo(f"  Status:    {state.status}")
    click.echo(f"  Evolution: {state.current_evolution}")
    click.echo(f"  Stage:     {state.current_stage}")
    if state.stop_reason:
        click.echo(f"  Reason:    {state.stop_reason}")
    click.echo(f"  Started:   {state.created_at}")
    click.echo(f"  Updated:   {state.updated_at}")

    if state.evolutions:
        click.echo()
        click.echo("  Evolution History:")
        click.echo(f"  {'Evo':>4}  {'Score':>7}  {'Best':>7}  {'Delta':>7}  {'Regr':>5}  {'Plat':>5}")
        click.echo(f"  {'---':>4}  {'-----':>7}  {'----':>7}  {'-----':>7}  {'----':>5}  {'----':>5}")
        for r in state.evolutions:
            click.echo(
                f"  {r.evolution:4d}  {r.overall_score:7.1f}  {r.best_score_so_far:7.1f}  "
                f"{r.delta_from_previous:+7.1f}  {r.consecutive_regressions:5d}  {r.consecutive_plateaus:5d}"
            )


@loop.command("stop")
def loop_stop():
    """Request a graceful stop of the currently running loop."""
    from .loop.state import StateStore

    store = StateStore()
    state = store.get_active_loop()
    if not state:
        click.echo("No active loop to stop.")
        return

    store.request_stop(state.loop_id)
    click.echo(f"Stop requested for loop {state.loop_id}")
    click.echo("The loop will halt after the current stage completes.")


@loop.command("history")
@click.option("--limit", default=10, help="Number of loops to show")
def loop_history(limit):
    """Show history of all loop runs."""
    from .loop.state import StateStore

    store = StateStore()
    loops = store.list_loops(limit=limit)
    if not loops:
        click.echo("No loop runs found.")
        return

    click.echo(f"{'Loop ID':>20}  {'Status':>10}  {'Evo':>4}  {'Stage':>12}  {'Reason':>20}  {'Created':>20}")
    click.echo(f"{'-------':>20}  {'------':>10}  {'---':>4}  {'-----':>12}  {'------':>20}  {'-------':>20}")
    for row in loops:
        click.echo(
            f"  {row['loop_id']:18s}  {row['status']:>10}  {row['current_evolution']:4d}  "
            f"{row['current_stage']:>12}  {(row['stop_reason'] or ''):>20}  {row['created_at'][:19]:>20}"
        )


@cli.command()
@click.option("--host", default="0.0.0.0", help="Host to bind to")
@click.option("--port", default=8000, type=int, help="Port to bind to")
@click.option("--reload", "use_reload", is_flag=True, help="Enable auto-reload for development")
def serve(host, port, use_reload):
    """Launch the SDGS web interface."""
    try:
        import uvicorn
    except ImportError:
        raise click.ClickException(
            "Web dependencies not installed. Run: pip install -e '.[web]'"
        )
    click.echo(f"Starting SDGS Web on http://{host}:{port}")
    uvicorn.run(
        "sdgs.web.app:app",
        host=host,
        port=port,
        reload=use_reload,
    )

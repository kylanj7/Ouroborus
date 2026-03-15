# Ouroborus
![0b5de2bd-29f1-4bab-ab10-0b41232591a5](https://github.com/user-attachments/assets/7a25d8dc-db1a-4a31-8240-b54113216ad7)

Full-stack platform for synthetic dataset generation, model fine-tuning, evaluation, and autonomous self-improvement loops. Generate reasoning datasets from scholarly papers, fine-tune models with LoRA, evaluate with RAG-grounded judges, and let the evolution loop close the cycle automatically.

## Features

- **Multi-provider dataset generation** -- plug in any OpenAI-compatible LLM (Ollama, OpenAI, Anthropic, Gemini, Perplexity)
- **Paper-based pipelines** -- search Semantic Scholar, arXiv, OpenAlex, and CORE; fetch full text, generate Q&A pairs
- **Knowledge base** -- ChromaDB-backed semantic search and RAG chat over indexed PDFs with persistent background indexing
- **Web UI** -- glassmorphism dashboard, dataset management, training controls, evaluation viewer, 3D knowledge galaxy
- **3D Galaxy visualizer** -- GPU-instanced rendering of papers, datasets, and Q&A pairs with force-directed layout
- **Config-driven fine-tuning** -- LoRA training with YAML configs for models, datasets, and hyperparameters
- **Live training controls** -- adjust learning rate mid-run, cancel jobs, stream metrics via SSE/WebSocket
- **RAG-grounded evaluation** -- judge models score responses against paper sources
- **Correction agent** -- Claude identifies and rewrites failing samples back into the training set
- **Merge and quantize** -- LoRA merge + GGUF conversion in one step
- **HuggingFace integration** -- import datasets, push models and datasets to the Hub
- **Evolution loop** -- autonomous generate -> train -> evaluate -> analyze cycle that improves models iteratively

## Supported Providers

| Provider | Model Examples | Key Required |
|----------|---------------|--------------|
| **Ollama** (local) | `qwen3:32b`, `gpt-oss:120b`, `llama3` | No |
| **OpenAI** | `gpt-4o`, `o1-mini` | `OPENAI_API_KEY` |
| **Anthropic** | `claude-sonnet-4-20250514`, `claude-opus-4-20250514` | `ANTHROPIC_API_KEY` |
| **Google Gemini** | `gemini-2.0-flash`, `gemini-2.5-pro` | `GEMINI_API_KEY` |
| **Perplexity** | `sonar-pro`, `sonar-deep-research` | `PERPLEXITY_API_KEY` |

## Installation

```bash
pip install -e .

# With web UI and training engine
pip install -e ".[web]"

# With GPU power tracking
pip install -e ".[gpu]"

# Development
pip install -e ".[dev]"
```

## Quick Start: CLI Pipeline

### Paper-based generation

```bash
# Search papers, fetch content, generate Q&A -- all in one step
sdgs scrape --topic "reinforcement learning" --provider openai --model gpt-4o \
  --max-papers 20 --top-n 5 -o data/rl_dataset.jsonl

# Collect paper metadata only (no generation)
sdgs scrape --topic "protein folding" --max-papers 50 --collect-only -o data/papers.json

# Use local Ollama
sdgs scrape --topic "transformer attention" --provider ollama --model qwen3:32b \
  --max-papers 10 --top-n 3 -o data/attention.jsonl
```

### Extract-based generation

```bash
# Extract from HuggingFace or local files
sdgs extract --task quantum_reasoning --output data/quantum.json

# Test with a few samples
sdgs generate --task quantum_reasoning --provider anthropic -i data/quantum.json --test 3

# Full generation
sdgs generate --task quantum_reasoning --provider anthropic -i data/quantum.json -o data/output.jsonl

# Filter and inspect
sdgs filter data/output.jsonl --task quantum_reasoning
sdgs qa data/output_filtered.jsonl --stats
```

### Evolution loop

```bash
# Start the web server first
sdgs serve

# Run the autonomous loop
sdgs loop start --config configs/loop_quick_test.yaml

# Monitor progress
sdgs loop status

# Graceful stop
sdgs loop stop

# View history
sdgs loop history
```

## Quick Start: Web UI

```bash
# Install web dependencies
pip install -e ".[web]"

# Build the frontend (requires Node.js)
cd sdgs/web/frontend && npm install && npm run build && cd -

# Start the server
sdgs serve
```

Open `http://localhost:8000` in your browser. Register an account, then:

1. **Create a dataset** -- pick a topic and provider, watch Q&A pairs stream in
2. **Browse papers** -- search, filter by topic, scrape new papers from multiple academic sources
3. **Index knowledge base** -- embed PDFs into ChromaDB for semantic search and RAG chat (progress persists across pages)
4. **Explore the Galaxy** -- 3D force-directed visualization of papers, datasets, and Q&A relationships
5. **Start training** -- select a model config (e.g. `qwen2.5-7b-instruct`) and training config
6. **Evaluate** -- run a judge model against test samples with RAG grounding
7. **Correct** -- trigger the Claude correction agent on failing samples
8. **Convert** -- merge LoRA adapter and quantize to GGUF
9. **Push** -- upload your model or dataset to HuggingFace

## Architecture

```
CLI Pipeline:
  scrape/extract -> generate -> filter -> qa

Web Pipeline:
  create dataset -> fine-tune -> evaluate -> correct -> merge/convert -> push to HF

Knowledge Base:
  PDFs -> chunk (RecursiveCharacterTextSplitter) -> embed (MiniLM-L6-v2) -> ChromaDB
       -> semantic search / RAG chat (Ollama)

Evolution Loop:
  generate -> format -> install config -> train -> convert -> evaluate -> analyze
     ^                                                                      |
     '---------- feedback (weak domains, sample budgets, error patterns) ---'
```

## CLI Reference

| Command | Purpose |
|---------|---------|
| `sdgs scrape` | Search papers, fetch content, generate Q&A |
| `sdgs extract` | Pull data from HuggingFace or local files |
| `sdgs generate` | Generate reasoning datasets with any provider |
| `sdgs filter` | Heal broken outputs and validate quality |
| `sdgs qa` | Inspect samples and view statistics |
| `sdgs providers` | List available LLM providers |
| `sdgs tasks` | List available task configs |
| `sdgs serve` | Launch the web interface |
| `sdgs loop start` | Start an evolution loop |
| `sdgs loop status` | Show current loop status |
| `sdgs loop stop` | Gracefully stop the running loop |
| `sdgs loop history` | View past loop runs |

## Web API

The web server exposes a REST API under `/api/`:

| Area | Endpoints |
|------|-----------|
| **Auth** | `POST /api/auth/register`, `/login`, `/refresh` |
| **Datasets** | CRUD, batch create, create from papers, import from HF, push to HF |
| **Papers** | List, search, filter by topic, bulk delete, stream scrape from multiple sources |
| **Knowledge** | `POST /api/knowledge/index`, `GET /api/knowledge/index/events` (SSE), search, RAG chat, reset |
| **Training** | Start, list, detail, cancel, knobs (live LR adjustment) |
| **Evaluation** | Start, list, detail with per-sample results, correction agent |
| **Convert** | `POST /api/training/convert` -- LoRA merge + GGUF (synchronous) |
| **Push** | `POST /api/training/push` -- upload GGUF or merged model to HF |
| **Configs** | `GET /api/training/configs/{type}` -- list YAML configs |
| **Artifacts** | `GET /api/training/artifacts` -- list adapters, GGUFs, checkpoints |
| **Galaxy** | `GET /api/galaxy/data` -- 3D knowledge graph data |
| **Settings** | Encrypted API key storage for all providers |
| **Loop** | Start, stop, status, list evolution loops |
| **SSE** | `/api/events/datasets/{id}`, `/api/events/training/{id}`, `/api/knowledge/index/events` |
| **WebSocket** | `/ws/pulse/{run_type}/{run_id}` -- real-time training metrics |

## Configuration

### Providers

YAML files in `configs/providers/`. Any OpenAI-compatible endpoint works:

```yaml
name: my_provider
base_url: "https://api.myprovider.com/v1/"
api_key_env: "MY_PROVIDER_API_KEY"
default_model: "my-model-name"
```

### Task configs

YAML files in `configs/tasks/`. Define source, generation prompts, and validation rules.
See `configs/tasks/example_task.yaml` for the full template.

### Training configs

YAML files in `sdgs/web/engine/configs/`:

- `models/` -- base model, LoRA rank/alpha, target modules
- `datasets/` -- dataset path, field mapping, prompt template, splits
- `training/` -- learning rate, epochs, batch size, gradient accumulation

### Loop configs

YAML files in `configs/`:

- `loop.yaml` -- default loop config (all domains, full training)
- `loop_quick_test.yaml` -- minimal single-evolution test config

```yaml
qftl:
  base_url: "http://localhost:8000"
  username: ""
  password: ""
  poll_interval_seconds: 30

evolution:
  max_evolutions: 10
  target_accuracy: 70.0

generation:
  provider: "ollama"
  domains: [quantum, physics, chemistry, biology, math]

training:
  model_config: "qwen2.5-14b-instruct"
  training_config: "default"

evaluation:
  sample_count: 50
  judge_model: "nemotron-3-nano:latest"
```

## Project Structure

```
sdgs/
  cli.py              # Click CLI entry point
  classify.py          # Paper topic classification
  providers.py         # Provider registry and client factory
  generate.py          # Core generation logic with token tracking
  scrape.py            # Scholarly paper search and full-text extraction
  extract.py           # Data extraction (HuggingFace, JSON, JSONL)
  filter.py            # Post-processing filter and healer
  qa.py                # Dataset inspection and statistics
  validate.py          # Shared validation and healing utilities
  tracker.py           # Token usage and GPU power tracking

  loop/                # Evolution loop (autonomous self-improvement)
    orchestrator.py    # State machine: generate -> train -> evaluate -> analyze
    bridge.py          # HTTP client for the web API
    formatter.py       # SDGS output -> training format converter
    analyzer.py        # Evaluation analysis and feedback signal generation
    config.py          # Loop configuration loader
    state.py           # SQLite-backed loop state persistence

  web/                 # Web application
    app.py             # FastAPI application
    auth.py            # JWT authentication and encryption
    schemas.py         # Pydantic request/response models
    db/                # SQLAlchemy models and database setup
    routers/           # API endpoints (auth, datasets, training, galaxy, knowledge, etc.)
    services/          # Background job runner, broadcasting, dataset/galaxy/knowledge services
    engine/            # Training engine
      trainer.py       # SFT training with LoRA and live metrics
      evaluator.py     # RAG-grounded judge evaluation
      correction_agent.py  # Claude-powered sample correction
      merge_convert.py # LoRA merge + GGUF quantization
      push_hf.py       # HuggingFace Hub upload
      training_service.py  # Metrics streaming and knob adjustment
      configs/         # YAML configs for models, datasets, training
    frontend/          # React + TypeScript SPA
      src/pages/       # Dashboard, Datasets, Training, Evaluations, Galaxy, KnowledgeBase, Loop, Settings
      src/components/  # Galaxy 3D canvas, IndexingBanner, dataset cards, layout
      src/store/       # Zustand stores (auth, datasets, training, loop, galaxy, knowledge, toast)

configs/
  providers/           # One YAML per LLM provider
  tasks/               # One YAML per domain/task
  loop.yaml            # Default evolution loop config
  loop_quick_test.yaml # Minimal test config
```

## License

MIT

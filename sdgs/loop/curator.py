"""Chain-of-thought reasoning dataset curator with 3-layer verification."""
from __future__ import annotations

import json
import logging
import re
import textwrap
from pathlib import Path

log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Prompt template
# ---------------------------------------------------------------------------

COT_GENERATION_PROMPT = """\
You are an expert scientific reasoning assistant. You will receive excerpts from \
research papers and must generate high-quality instruction/response pairs that \
demonstrate rigorous chain-of-thought reasoning.

REQUIREMENTS:
1. Generate exactly {num_pairs} instruction/response pairs grounded in the provided paper content.
2. Each response MUST include inline citations using the format: [Paper: "Title of Paper"]
3. Responses MUST be step-by-step reasoning chains, labeled as:
   Step 1: <reasoning>
   Step 2: <reasoning>
   ...
4. Every factual claim must be traceable to a specific excerpt from the papers.
5. Do NOT introduce facts not present in the provided paper content.

PAPER CONTENT:
{paper_content}

OUTPUT FORMAT (JSON array, no markdown):
[
  {{
    "instruction": "<question or task>",
    "response": "<step-by-step chain-of-thought with inline citations>",
    "citations": ["<Paper Title 1>", ...]
  }},
  ...
]
"""

# ---------------------------------------------------------------------------
# chunk_paper
# ---------------------------------------------------------------------------


def chunk_paper(text: str, min_chunk_len: int = 50, max_chunk_len: int = 2000) -> list[str]:
    """Split paper text into chunks at paragraph boundaries.

    Paragraphs shorter than min_chunk_len are merged with the next paragraph.
    Paragraphs longer than max_chunk_len are hard-split by character count.

    Args:
        text: Full paper text.
        min_chunk_len: Minimum character length for a standalone chunk.
        max_chunk_len: Maximum character length before hard-splitting.

    Returns:
        List of text chunks.
    """
    if not text or not text.strip():
        return []

    raw_paragraphs = [p.strip() for p in re.split(r"\n\n+", text) if p.strip()]

    # Merge short paragraphs into the next one.
    # A paragraph is "short" if it is below min_chunk_len on its own.
    # Carry it forward (as pending) and prepend it to the next paragraph.
    merged: list[str] = []
    pending = ""
    for i, para in enumerate(raw_paragraphs):
        candidate = (pending + " " + para).strip() if pending else para

        is_last = i == len(raw_paragraphs) - 1

        if len(para) < min_chunk_len and not is_last:
            # This paragraph is short -- carry it forward to merge with next
            pending = candidate
        else:
            merged.append(candidate)
            pending = ""

    if pending:
        if merged:
            merged[-1] = merged[-1] + " " + pending
        else:
            merged.append(pending)

    # Split chunks that exceed max_chunk_len
    result: list[str] = []
    for chunk in merged:
        if len(chunk) <= max_chunk_len:
            result.append(chunk)
        else:
            sub_chunks = textwrap.wrap(chunk, width=max_chunk_len, break_long_words=True)
            result.extend(sub_chunks)

    return result


# ---------------------------------------------------------------------------
# split_reasoning_steps
# ---------------------------------------------------------------------------


def split_reasoning_steps(response: str) -> list[str]:
    """Split a chain-of-thought response into individual reasoning steps.

    Tries "Step N:" pattern first. Falls back to paragraph splitting.
    Filters out steps shorter than 10 characters.

    Args:
        response: Full chain-of-thought response text.

    Returns:
        List of step strings.
    """
    # Try "Step N:" or "Step N." pattern (case-insensitive)
    step_pattern = re.compile(r"Step\s+\d+\s*[:.]", re.IGNORECASE)
    if step_pattern.search(response):
        # Split at each step marker; keep the content after the marker
        parts = step_pattern.split(response)
        # parts[0] is any text before the first step -- discard if empty
        steps = [p.strip() for p in parts if p.strip()]
        return [s for s in steps if len(s) >= 10]

    # Fallback: split by double newlines (paragraph boundaries)
    paragraphs = [p.strip() for p in re.split(r"\n\n+", response) if p.strip()]
    return [p for p in paragraphs if len(p) >= 10]


# ---------------------------------------------------------------------------
# check_citations
# ---------------------------------------------------------------------------


def check_citations(
    response: str,
    paper_titles: list[str],
    paper_texts: list[str],
) -> dict:
    """Verify that all inline citations in the response match known paper titles.

    Citation format: [Paper: "Title"]

    Args:
        response: Generated response text.
        paper_titles: List of available paper titles.
        paper_texts: Corresponding paper texts (unused but kept for API symmetry).

    Returns:
        Dict with "passed" (bool) and "reason" (str).
    """
    citation_pattern = re.compile(r'\[Paper:\s*"([^"]+)"\]', re.IGNORECASE)
    found_citations = citation_pattern.findall(response)

    if not found_citations:
        return {"passed": True, "reason": "No citations found -- nothing to verify."}

    lower_titles = [t.lower() for t in paper_titles]
    unmatched: list[str] = []

    for cited in found_citations:
        cited_lower = cited.lower()
        # Case-insensitive substring match
        matched = any(cited_lower in title or title in cited_lower for title in lower_titles)
        if not matched:
            unmatched.append(cited)

    if unmatched:
        return {
            "passed": False,
            "reason": f"Citations not matched to any paper: {unmatched}",
        }

    return {"passed": True, "reason": "All citations matched."}


# ---------------------------------------------------------------------------
# check_entailment
# ---------------------------------------------------------------------------


def check_entailment(
    steps: list[str],
    paper_chunks: list[str],
    model_name: str = "facebook/bart-large-mnli",
    min_entailment_ratio: float = 0.5,
    nli_pipeline=None,
) -> dict:
    """Verify reasoning steps are entailed by paper chunks using NLI.

    Uses transformers zero-shot-classification pipeline. For each step,
    finds the best-matching chunk and classifies entailment vs contradiction.

    Args:
        steps: List of reasoning step strings.
        paper_chunks: List of paper text chunks.
        model_name: HuggingFace model for zero-shot NLI.
        min_entailment_ratio: Minimum fraction of steps that must be entailed.
        nli_pipeline: Pre-loaded transformers pipeline. If None, a new one is created.

    Returns:
        Dict with "passed" (bool) and "reason" (str).
    """
    if not steps or not paper_chunks:
        return {"passed": True, "reason": "No steps or chunks to verify."}

    if nli_pipeline is None:
        try:
            from transformers import pipeline
        except ImportError as exc:
            raise ImportError(
                "transformers is required for entailment checking. "
                "Install with: pip install transformers"
            ) from exc
        nli_pipeline = pipeline("zero-shot-classification", model=model_name)

    classifier = nli_pipeline

    entailed_count = 0
    contradiction_steps: list[str] = []

    for step in steps:
        # Use chunks as candidate labels for zero-shot classification
        # We limit to first 5 chunks to keep latency reasonable
        candidate_chunks = paper_chunks[:5]
        result = classifier(step, candidate_chunks, multi_label=False)

        # The highest-scoring label is the best-matching chunk
        best_chunk = result["labels"][0]
        best_score = result["scores"][0]

        # Re-classify: is the step entailed or contradicted by the best chunk?
        entailment_result = classifier(
            step,
            candidate_labels=["entailment", "contradiction", "neutral"],
            hypothesis_template="This text {}s the following: " + best_chunk[:200],
        )
        top_label = entailment_result["labels"][0]

        if top_label == "contradiction":
            contradiction_steps.append(step[:80])
        elif top_label == "entailment":
            entailed_count += 1

    if contradiction_steps:
        return {
            "passed": False,
            "reason": f"Contradictions found in steps: {contradiction_steps[:3]}",
        }

    ratio = entailed_count / len(steps) if steps else 1.0
    if ratio < min_entailment_ratio:
        return {
            "passed": False,
            "reason": (
                f"Entailment ratio {ratio:.2f} below threshold {min_entailment_ratio}. "
                f"Only {entailed_count}/{len(steps)} steps entailed."
            ),
        }

    return {"passed": True, "reason": f"Entailment ratio {ratio:.2f} passes threshold."}


# ---------------------------------------------------------------------------
# check_chunk_tracing
# ---------------------------------------------------------------------------


def check_chunk_tracing(
    steps: list[str],
    chunk_embeddings: list,
    chunks: list[str],
    embedding_model,
    threshold: float = 0.3,
) -> dict:
    """Verify each reasoning step can be traced to a source chunk via embeddings.

    Computes cosine similarity between step embeddings and all chunk embeddings.
    Fails if any step has max similarity below threshold.

    Args:
        steps: List of reasoning step strings.
        chunk_embeddings: Pre-computed embeddings for all chunks (numpy arrays or lists).
        chunks: Corresponding chunk texts (for error reporting).
        embedding_model: Model with an .encode(texts) method (e.g. SentenceTransformer).
        threshold: Minimum cosine similarity to consider a step traceable.

    Returns:
        Dict with "passed" (bool) and "reason" (str).
    """
    if not steps:
        return {"passed": True, "reason": "No steps to trace."}
    if not chunk_embeddings:
        return {"passed": False, "reason": "No chunk embeddings provided for tracing."}

    import numpy as np

    step_embeddings = embedding_model.encode(steps)

    # Normalize for cosine similarity
    def _norm(v):
        n = np.linalg.norm(v, axis=-1, keepdims=True)
        return v / np.maximum(n, 1e-9)

    step_embs = _norm(np.array(step_embeddings))
    chunk_embs = _norm(np.array(chunk_embeddings))

    # similarity matrix: (num_steps, num_chunks)
    similarities = step_embs @ chunk_embs.T

    untraced: list[str] = []
    for i, step in enumerate(steps):
        max_sim = float(similarities[i].max())
        if max_sim < threshold:
            untraced.append(f"step[{i}] max_sim={max_sim:.3f}: {step[:60]}")

    if untraced:
        return {
            "passed": False,
            "reason": f"Steps with no traceable source chunk: {untraced}",
        }

    return {"passed": True, "reason": "All steps traced to source chunks."}


# ---------------------------------------------------------------------------
# build_verification_feedback
# ---------------------------------------------------------------------------


def build_verification_feedback(
    check_results: list[dict],
    paper_titles: list[str],
) -> str:
    """Build specific feedback from verification failures for regeneration.

    Args:
        check_results: List of dicts with "check" (str), "passed" (bool), "reason" (str).
        paper_titles: Available paper titles for citation feedback.

    Returns:
        Combined feedback string.
    """
    feedback_parts = []
    for result in check_results:
        if result["passed"]:
            continue
        check = result["check"]
        reason = result["reason"]
        if check == "citation":
            available = ", ".join(f'"{t}"' for t in paper_titles[:10])
            feedback_parts.append(
                f"CITATION ERROR: {reason}\n"
                f"Available papers: {available}\n"
                f"Use exact titles from the list above."
            )
        elif check == "entailment":
            feedback_parts.append(
                f"FACTUAL ERROR: {reason}\n"
                f"Correct the claims to match the source paper content."
            )
        elif check == "chunk_tracing":
            feedback_parts.append(
                f"UNGROUNDED CONTENT: {reason}\n"
                f"Remove or replace steps that are not grounded in the source paper."
            )
    return "\n\n".join(feedback_parts)


# ---------------------------------------------------------------------------
# generate_pairs
# ---------------------------------------------------------------------------


def generate_pairs(
    papers: list[dict],
    tally_metadata: dict,
    model: str = "gpt-oss:120b",
    min_pairs: int = 1000,
    verification_config: dict | None = None,
) -> tuple[list[dict], list[dict]]:
    """Generate chain-of-thought instruction/response pairs from papers.

    Runs 3-layer verification on each generated batch:
      1. Citation matching
      2. NLI entailment
      3. Chunk tracing

    Args:
        papers: List of dicts with at least "title" and "text" keys.
        tally_metadata: Metadata from the tally agent (search queries, guidance).
        model: Ollama model name.
        min_pairs: Target number of accepted pairs.
        verification_config: Optional overrides for verification thresholds.

    Returns:
        Tuple of (accepted_pairs, rejected_pairs).
    """
    from langchain_core.messages import HumanMessage, SystemMessage
    from langchain_ollama import ChatOllama

    cfg = verification_config or {}
    entailment_threshold = cfg.get("min_entailment_ratio", 0.5)
    tracing_threshold = cfg.get("chunk_tracing_threshold", 0.3)
    use_entailment = cfg.get("use_entailment", True)
    use_chunk_tracing = cfg.get("use_chunk_tracing", True)
    max_retries_per_pair = cfg.get("max_retries_per_pair", 3)

    llm = ChatOllama(model=model)
    accepted: list[dict] = []
    rejected: list[dict] = []

    # Pre-compute chunk embeddings if chunk tracing is enabled
    chunk_embeddings = []
    all_chunks: list[str] = []
    embedding_model = None

    if use_chunk_tracing:
        try:
            from sentence_transformers import SentenceTransformer
            embedding_model = SentenceTransformer("all-MiniLM-L6-v2", device="cpu")
            for paper in papers:
                paper_chunks_for_embed = chunk_paper(paper.get("text", ""))
                all_chunks.extend(paper_chunks_for_embed)
            if all_chunks:
                chunk_embeddings = embedding_model.encode(all_chunks).tolist()
        except ImportError:
            log.warning("sentence-transformers not available -- skipping chunk tracing")
            use_chunk_tracing = False

    paper_titles = [p.get("title", "") for p in papers]
    paper_texts = [p.get("text", "") for p in papers]

    # Pre-compute paper_chunks once for entailment (not per-pair)
    entailment_paper_chunks: list[str] = []
    if use_entailment:
        entailment_paper_chunks = chunk_paper(" ".join(paper_texts[:3]))

    # Load NLI pipeline once if entailment is enabled
    nli_pipeline = None
    if use_entailment:
        try:
            from transformers import pipeline as hf_pipeline
            nli_pipeline = hf_pipeline(
                "zero-shot-classification",
                model=cfg.get("entailment_model", "facebook/bart-large-mnli"),
                device="cpu",  # GPU is used by the curation LLM (Ollama)
            )
        except ImportError:
            log.warning("transformers not available -- skipping entailment checks")
            use_entailment = False

    # Build a condensed paper summary for the prompt (avoid token overflow)
    paper_content_parts: list[str] = []
    for paper in papers:
        title = paper.get("title", "Unknown")
        excerpt = paper.get("text", "")[:1500]
        paper_content_parts.append(f'[Paper: "{title}"]\n{excerpt}')
    paper_content = "\n\n---\n\n".join(paper_content_parts)

    batch_size = 10
    max_iterations = (min_pairs // batch_size) * 3 + 10  # generous upper bound

    for iteration in range(max_iterations):
        if len(accepted) >= min_pairs:
            break

        remaining = min_pairs - len(accepted)
        num_pairs = min(batch_size, remaining + batch_size)

        prompt_text = COT_GENERATION_PROMPT.format(
            num_pairs=num_pairs,
            paper_content=paper_content,
        )

        try:
            response = llm.invoke([HumanMessage(content=prompt_text)])
            raw = response.content if hasattr(response, "content") else str(response)
        except Exception as exc:
            log.warning("Generation iteration %d failed: %s", iteration, exc)
            continue

        # Parse generated pairs
        try:
            # Strip markdown fences if present
            fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
            json_str = fence_match.group(1).strip() if fence_match else raw.strip()
            batch = json.loads(json_str)
            if not isinstance(batch, list):
                batch = [batch]
        except (json.JSONDecodeError, AttributeError) as exc:
            log.warning("Failed to parse JSON from iteration %d: %s", iteration, exc)
            continue

        for pair in batch:
            if not isinstance(pair, dict):
                continue

            instruction = pair.get("instruction", "").strip()
            response_text = pair.get("response", "").strip()
            if not instruction or not response_text:
                continue

            original_prompt = COT_GENERATION_PROMPT.format(
                num_pairs=1,
                paper_content=paper_content,
            )
            current_pair = pair
            pair_accepted = False

            for attempt in range(max_retries_per_pair + 1):
                current_response_text = current_pair.get("response", "").strip()
                check_results: list[dict] = []

                # Layer 1: Citation matching
                citation_result = check_citations(current_response_text, paper_titles, paper_texts)
                check_results.append({
                    "check": "citation",
                    "passed": citation_result["passed"],
                    "reason": citation_result["reason"],
                })

                # Layer 2: NLI entailment
                if use_entailment:
                    steps = split_reasoning_steps(current_response_text)
                    entailment_result = check_entailment(
                        steps,
                        entailment_paper_chunks,
                        min_entailment_ratio=entailment_threshold,
                        nli_pipeline=nli_pipeline,
                    )
                    check_results.append({
                        "check": "entailment",
                        "passed": entailment_result["passed"],
                        "reason": entailment_result["reason"],
                    })

                # Layer 3: Chunk tracing
                if use_chunk_tracing and embedding_model and chunk_embeddings:
                    steps = split_reasoning_steps(current_response_text)
                    tracing_result = check_chunk_tracing(
                        steps,
                        chunk_embeddings,
                        all_chunks,
                        embedding_model,
                        threshold=tracing_threshold,
                    )
                    check_results.append({
                        "check": "chunk_tracing",
                        "passed": tracing_result["passed"],
                        "reason": tracing_result["reason"],
                    })

                failed = [r for r in check_results if not r["passed"]]
                if not failed:
                    pair_accepted = True
                    accepted.append(current_pair)
                    break

                # Failures remain -- attempt self-correction if retries left
                if attempt < max_retries_per_pair:
                    feedback = build_verification_feedback(check_results, paper_titles)
                    regen_prompt = f"""{original_prompt}

PREVIOUS ATTEMPT (rejected):
{json.dumps(current_pair)}

ERRORS FOUND:
{feedback}

Generate a corrected version. Fix ALL errors listed above. Respond with JSON:
{{"instruction": "...", "response": "..."}}"""
                    try:
                        regen_response = llm.invoke([HumanMessage(content=regen_prompt)])
                        regen_raw = (
                            regen_response.content
                            if hasattr(regen_response, "content")
                            else str(regen_response)
                        )
                        fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)```", regen_raw)
                        regen_str = fence_match.group(1).strip() if fence_match else regen_raw.strip()
                        regen_parsed = json.loads(regen_str)
                        if isinstance(regen_parsed, list):
                            regen_parsed = regen_parsed[0]
                        if isinstance(regen_parsed, dict):
                            current_pair = regen_parsed
                    except Exception as exc:
                        log.warning("Self-correction attempt %d failed: %s", attempt + 1, exc)
                        break

            if not pair_accepted:
                reject_reasons = [
                    f"{r['check']}: {r['reason']}"
                    for r in check_results
                    if not r["passed"]
                ]
                current_pair["reject_reasons"] = reject_reasons
                rejected.append(current_pair)

        log.info(
            "Iteration %d: accepted=%d rejected=%d (target=%d)",
            iteration,
            len(accepted),
            len(rejected),
            min_pairs,
        )

    return accepted, rejected


# ---------------------------------------------------------------------------
# save_dataset
# ---------------------------------------------------------------------------


def save_dataset(
    pairs: list[dict],
    output_path: str | Path,
    rejects: list[dict] | None = None,
    rejects_path: str | Path | None = None,
) -> Path:
    """Save accepted pairs to a JSONL file.

    Optionally saves rejected pairs to a separate JSONL file.

    Args:
        pairs: List of accepted instruction/response dicts.
        output_path: Path for the accepted pairs JSONL.
        rejects: Optional list of rejected pairs.
        rejects_path: Optional path for the rejected pairs JSONL.

    Returns:
        Path to the saved accepted pairs file.
    """
    output_path = Path(output_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)

    with open(output_path, "w", encoding="utf-8") as f:
        for pair in pairs:
            f.write(json.dumps(pair, ensure_ascii=False) + "\n")

    log.info("Saved %d pairs to %s", len(pairs), output_path)

    if rejects is not None and rejects_path is not None:
        rejects_path = Path(rejects_path)
        rejects_path.parent.mkdir(parents=True, exist_ok=True)
        with open(rejects_path, "w", encoding="utf-8") as f:
            for pair in rejects:
                f.write(json.dumps(pair, ensure_ascii=False) + "\n")
        log.info("Saved %d rejected pairs to %s", len(rejects), rejects_path)

    return output_path

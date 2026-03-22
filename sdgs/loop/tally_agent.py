"""LangChain-based tally agent for diagnosing model benchmark failures."""
from __future__ import annotations

import json
import logging
import re
import signal
from collections import Counter

from langgraph.prebuilt import create_react_agent

log = logging.getLogger(__name__)

TALLY_SYSTEM_PROMPT = """\
You are an expert AI benchmark diagnostician. You will receive a list of questions \
that a model answered incorrectly, along with the model's answers and the correct answers.

Your job is to:
1. Analyze the failed questions carefully.
2. Cluster them by the underlying knowledge gap they reveal.
3. Diagnose the root cause for each cluster.
4. Prioritize clusters by their impact on overall model performance.
5. Generate targeted search queries that could retrieve training material to address each gap.
6. Provide generation guidance that describes what kinds of new training examples would help most.

You MUST respond with valid JSON in exactly this format (no markdown, no preamble):
{
  "clusters": [
    {
      "gap_description": "<short label for the knowledge gap>",
      "root_cause": "<explanation of why the model fails here>",
      "affected_questions": ["<question text or id>", ...],
      "priority_score": <float 0.0-1.0>
    }
  ],
  "search_queries": ["<query 1>", "<query 2>", ...],
  "generation_guidance": "<instructions for generating targeted training examples>"
}
"""


def build_tally_prompt(
    failed_questions: list[dict],
    history: list[dict],
    max_questions: int = 100,
) -> str:
    """Build a prompt from failed questions and cycle history.

    Args:
        failed_questions: Each dict has task, question, model_answer,
            correct_answer, passed.
        history: Prior cycle records (e.g. [{"cycle": 1, "score": 60.0}]).
        max_questions: Maximum number of failed questions to include.

    Returns:
        Prompt string ready to send to the LLM.
    """
    truncated = failed_questions[:max_questions]

    lines: list[str] = []

    if history:
        lines.append("=== Cycle History ===")
        for entry in history:
            lines.append(json.dumps(entry))
        lines.append("")

    lines.append(f"=== Failed Questions ({len(truncated)} of {len(failed_questions)}) ===")
    for i, q in enumerate(truncated, start=1):
        lines.append(f"[{i}] task={q.get('task', 'unknown')}")
        lines.append(f"    question: {q.get('question', '')}")
        lines.append(f"    model_answer: {q.get('model_answer', '')}")
        lines.append(f"    correct_answer: {q.get('correct_answer', '')}")

    lines.append("")
    lines.append(
        "Please cluster these failures by knowledge gap, diagnose root causes, "
        "prioritize by impact, and generate search queries and generation guidance."
    )

    return "\n".join(lines)


def parse_tally_output(raw: str) -> dict:
    """Parse JSON from LLM output.

    Handles markdown code fences (```json...```). Validates that the parsed
    object contains the required keys: clusters, search_queries,
    generation_guidance.

    Args:
        raw: Raw string output from the LLM.

    Returns:
        Parsed dict with the required structure.

    Raises:
        ValueError: If no JSON is found or required keys are missing.
    """
    # Strip markdown code fences if present
    fence_match = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    if fence_match:
        json_str = fence_match.group(1).strip()
    else:
        # Try to find a bare JSON object in the text
        obj_match = re.search(r"\{[\s\S]*\}", raw)
        if not obj_match:
            raise ValueError("No JSON found in tally agent output.")
        json_str = obj_match.group(0)

    try:
        data = json.loads(json_str)
    except json.JSONDecodeError as exc:
        raise ValueError(f"Failed to parse JSON from tally agent output: {exc}") from exc

    required_keys = {"clusters", "search_queries", "generation_guidance"}
    missing = required_keys - set(data.keys())
    if missing:
        raise ValueError(
            f"Tally agent output missing required keys: {', '.join(sorted(missing))}"
        )

    return data


def fallback_analysis(failed_questions: list[dict]) -> dict:
    """Simple fallback when the LLM fails.

    Groups questions by task, extracts top words via Counter, and builds
    crude clusters and search queries.

    Args:
        failed_questions: Each dict has task, question, model_answer,
            correct_answer, passed.

    Returns:
        Dict with clusters, search_queries, and generation_guidance.
    """
    if not failed_questions:
        return {
            "clusters": [],
            "search_queries": [],
            "generation_guidance": "No failed questions to analyze.",
        }

    # Group by task
    task_groups: dict[str, list[dict]] = {}
    for q in failed_questions:
        task = q.get("task", "unknown")
        task_groups.setdefault(task, []).append(q)

    clusters: list[dict] = []
    search_queries: list[str] = []

    for task, questions in task_groups.items():
        # Collect all words from question text for this task
        all_words: list[str] = []
        affected: list[str] = []
        for q in questions:
            text = q.get("question", "")
            affected.append(text[:80] if text else "(no question)")
            words = re.findall(r"[a-zA-Z]{4,}", text.lower())
            all_words.extend(words)

        top_words = [w for w, _ in Counter(all_words).most_common(5)]
        priority = min(1.0, len(questions) / max(len(failed_questions), 1))

        clusters.append(
            {
                "gap_description": task,
                "root_cause": (
                    f"Model struggles with {task} questions "
                    f"(top terms: {', '.join(top_words) or 'n/a'})"
                ),
                "affected_questions": affected,
                "priority_score": round(priority, 3),
            }
        )

        query_terms = " ".join(top_words[:3]) if top_words else task
        search_queries.append(f"{task} {query_terms}".strip())

    guidance = (
        "Generate training examples targeting these task areas: "
        + ", ".join(task_groups.keys())
        + ". Focus on correcting systematic errors identified in each cluster."
    )

    return {
        "clusters": clusters,
        "search_queries": search_queries,
        "generation_guidance": guidance,
    }


def run_tally(
    failed_questions: list[dict],
    history: list[dict],
    model: str = "gpt-oss:120b",
    provider: str = "ollama",
    max_retries: int = 3,
    max_tool_calls: int = 20,
    timeout_seconds: int = 600,
    log_dir: str = "logs/loop/",
    history_window: int = 5,
) -> dict:
    """Run the tally agent to diagnose benchmark failures.

    Uses a LangGraph ReAct agent with tools for Semantic Scholar search,
    training history lookup, and analysis submission. Falls back to
    fallback_analysis on any unrecoverable failure.

    Args:
        failed_questions: Each dict has task, question, model_answer,
            correct_answer, passed.
        history: Prior cycle records.
        model: Ollama model name.
        provider: Currently only "ollama" is supported.
        max_retries: Number of agent invocation attempts before using fallback.
        max_tool_calls: Maximum number of tool calls; recursion_limit is set
            to max_tool_calls * 2.
        timeout_seconds: Wall-clock timeout for the agent invocation (Unix only).
        log_dir: Directory where CycleLogger writes its JSONL log.
        history_window: Number of most recent cycles to pass to the history tool.

    Returns:
        Dict with clusters, search_queries, and generation_guidance.
    """
    from langchain_core.messages import HumanMessage, SystemMessage
    from langchain_ollama import ChatOllama

    from sdgs.loop.tally_tools import (
        get_submitted_analysis,
        make_training_history_tool,
        search_semantic_scholar,
        submit_analysis,
    )

    prompt_text = build_tally_prompt(failed_questions, history)
    system_content = (
        TALLY_SYSTEM_PROMPT
        + "\n\nIMPORTANT: You MUST call the submit_analysis tool when your investigation is complete."
    )

    training_history_tool = make_training_history_tool(log_dir, history_window)
    tools = [search_semantic_scholar, training_history_tool, submit_analysis]

    input_messages = {
        "messages": [
            SystemMessage(content=system_content),
            HumanMessage(content=prompt_text),
        ]
    }
    config = {"recursion_limit": max_tool_calls * 2}

    last_exc: Exception | None = None

    def _timeout_handler(signum, frame):  # noqa: ANN001
        raise TimeoutError(f"Tally agent timed out after {timeout_seconds}s")

    for attempt in range(1, max_retries + 1):
        try:
            log.info(
                "Tally ReAct agent attempt %d/%d (model=%s)", attempt, max_retries, model
            )

            llm = ChatOllama(model=model)
            agent = create_react_agent(llm, tools)

            old_handler = signal.signal(signal.SIGALRM, _timeout_handler)
            signal.alarm(timeout_seconds)
            try:
                result_state = agent.invoke(input_messages, config=config)
            finally:
                signal.alarm(0)
                signal.signal(signal.SIGALRM, old_handler)

            # Prefer result from submit_analysis tool
            submitted = get_submitted_analysis()
            if submitted is not None:
                log.info("Tally agent succeeded via submit_analysis on attempt %d", attempt)
                return submitted

            # Fall back to parsing the last message content
            messages_out = result_state.get("messages", [])
            if messages_out:
                last_content = messages_out[-1].content
                raw = last_content if isinstance(last_content, str) else str(last_content)
                log.debug("Tally agent raw output (attempt %d): %s", attempt, raw[:2000])
                parsed = parse_tally_output(raw)
                log.info(
                    "Tally agent succeeded via parse_tally_output on attempt %d", attempt
                )
                return parsed

            raise ValueError("Agent produced no messages and no submitted analysis.")

        except Exception as exc:  # noqa: BLE001
            log.warning("Tally ReAct agent attempt %d failed: %s", attempt, exc)
            try:
                if raw:
                    log.warning("Raw LLM output was: %.1500s", raw)
            except NameError:
                pass
            last_exc = exc

    log.error(
        "Tally agent exhausted %d retries (last error: %s). Using fallback.",
        max_retries,
        last_exc,
    )
    return fallback_analysis(failed_questions)

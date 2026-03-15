"""Email reporter for fail-cap escalation in the closed-loop system."""
from __future__ import annotations

import logging
import smtplib
from email.message import EmailMessage
from typing import Any

logger = logging.getLogger(__name__)

_TOP_CLUSTERS = 5


def build_report_body(
    project_id: str,
    cycle: int,
    consecutive_failures: int,
    scores: dict[str, float],
    tally_summary: list[dict[str, Any]],
) -> str:
    """Build a plain-text email body for a fail-cap escalation report.

    Args:
        project_id: Identifier of the training project.
        cycle: Current cycle number.
        consecutive_failures: Number of consecutive gate failures.
        scores: Mapping of benchmark name to score value.
        tally_summary: List of cluster dicts with at least ``cluster`` and
            ``count`` keys, ordered by descending count.  Only the top 5 are
            included in the report.

    Returns:
        A plain-text string suitable for use as an email body.
    """
    lines: list[str] = [
        "Ouroborus Closed-Loop Fail-Cap Escalation",
        "=" * 42,
        "",
        f"Project ID          : {project_id}",
        f"Cycle               : {cycle}",
        f"Consecutive failures: {consecutive_failures}",
        "",
        "Benchmark Scores",
        "-" * 16,
    ]

    for benchmark, score in scores.items():
        lines.append(f"  {benchmark}: {score}")

    lines += [
        "",
        f"Top Tally Clusters (up to {_TOP_CLUSTERS})",
        "-" * 30,
    ]

    top = tally_summary[:_TOP_CLUSTERS]
    for entry in top:
        cluster = entry.get("cluster", "unknown")
        count = entry.get("count", 0)
        lines.append(f"  {cluster}: {count}")

    lines += ["", "-- Ouroborus automated report"]

    return "\n".join(lines)


def send_fail_cap_email(
    to_email: str,
    subject: str,
    body: str,
    smtp_host: str = "smtp.gmail.com",
    smtp_port: int = 587,
    smtp_user: str = "",
    smtp_password: str = "",
) -> None:
    """Send a plain-text email via SMTP with STARTTLS.

    Login is performed only when both ``smtp_user`` and ``smtp_password`` are
    non-empty strings.  Success and failure are logged at INFO and ERROR level
    respectively.

    Args:
        to_email: Recipient address.
        subject: Email subject line.
        body: Plain-text email body.
        smtp_host: SMTP server hostname.
        smtp_port: SMTP server port (default 587 for STARTTLS).
        smtp_user: SMTP account username.  Leave empty to skip login.
        smtp_password: SMTP account password.  Leave empty to skip login.
    """
    msg = EmailMessage()
    msg["To"] = to_email
    msg["From"] = smtp_user or "ouroborus@localhost"
    msg["Subject"] = subject
    msg.set_content(body)

    try:
        with smtplib.SMTP(smtp_host, smtp_port) as smtp:
            smtp.starttls()
            if smtp_user and smtp_password:
                smtp.login(smtp_user, smtp_password)
            smtp.send_message(msg)
        logger.info("Fail-cap email sent to %s (subject: %r)", to_email, subject)
    except Exception as exc:  # noqa: BLE001
        logger.error(
            "Failed to send fail-cap email to %s: %s",
            to_email,
            exc,
        )

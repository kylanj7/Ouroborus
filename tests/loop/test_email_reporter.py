"""Tests for sdgs.loop.email_reporter."""
from __future__ import annotations

from unittest.mock import MagicMock, patch

from sdgs.loop.email_reporter import build_report_body, send_fail_cap_email


# ---------------------------------------------------------------------------
# test_build_report_email
# ---------------------------------------------------------------------------

def test_build_report_email():
    """build_report_body includes project_id, cycle, and failure count."""
    scores = {"hellaswag": 72.5, "arc_easy": 68.0}
    tally_summary = [
        {"cluster": "physics", "count": 12},
        {"cluster": "math", "count": 9},
        {"cluster": "code", "count": 7},
        {"cluster": "history", "count": 4},
        {"cluster": "biology", "count": 3},
        {"cluster": "chemistry", "count": 2},  # 6th -- should be excluded
    ]

    body = build_report_body(
        project_id="physics-v1",
        cycle=5,
        consecutive_failures=3,
        scores=scores,
        tally_summary=tally_summary,
    )

    assert "physics-v1" in body
    assert "5" in body
    assert "3" in body
    # Top 5 clusters present, 6th absent
    assert "physics" in body
    assert "math" in body
    assert "code" in body
    assert "history" in body
    assert "biology" in body
    assert "chemistry" not in body
    # Scores present
    assert "hellaswag" in body
    assert "72.5" in body


# ---------------------------------------------------------------------------
# test_send_email_calls_smtp
# ---------------------------------------------------------------------------

def test_send_email_calls_smtp():
    """send_fail_cap_email constructs an SMTP connection and calls send_message."""
    mock_smtp_instance = MagicMock()
    mock_smtp_ctx = MagicMock()
    mock_smtp_ctx.__enter__ = MagicMock(return_value=mock_smtp_instance)
    mock_smtp_ctx.__exit__ = MagicMock(return_value=False)

    with patch("sdgs.loop.email_reporter.smtplib.SMTP", return_value=mock_smtp_ctx) as mock_smtp_cls:
        send_fail_cap_email(
            to_email="recipient@example.com",
            subject="Fail cap reached",
            body="Test body content",
            smtp_host="smtp.example.com",
            smtp_port=587,
            smtp_user="user@example.com",
            smtp_password="secret",
        )

    mock_smtp_cls.assert_called_once_with("smtp.example.com", 587)
    mock_smtp_instance.starttls.assert_called_once()
    mock_smtp_instance.login.assert_called_once_with("user@example.com", "secret")
    mock_smtp_instance.send_message.assert_called_once()


def test_send_email_skips_login_when_no_credentials():
    """send_fail_cap_email skips login when smtp_user and smtp_password are empty."""
    mock_smtp_instance = MagicMock()
    mock_smtp_ctx = MagicMock()
    mock_smtp_ctx.__enter__ = MagicMock(return_value=mock_smtp_instance)
    mock_smtp_ctx.__exit__ = MagicMock(return_value=False)

    with patch("sdgs.loop.email_reporter.smtplib.SMTP", return_value=mock_smtp_ctx):
        send_fail_cap_email(
            to_email="recipient@example.com",
            subject="Fail cap reached",
            body="Test body content",
        )

    mock_smtp_instance.login.assert_not_called()
    mock_smtp_instance.send_message.assert_called_once()

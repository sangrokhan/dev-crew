from __future__ import annotations

import re


class PolicyViolationError(RuntimeError):
    pass


SECRET_PATTERNS = [
    re.compile(r"\bsk-[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bBearer\s+[A-Za-z0-9._\-]{20,}\b", re.IGNORECASE),
]

PII_PATTERNS = [
    re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    re.compile(r"\b\d{3}-\d{3,4}-\d{4}\b"),
]

BLOCKED_COMMAND_PATTERNS = [
    re.compile(r"\bgit\s+reset\s+--hard\b"),
    re.compile(r"\bgit\s+clean\s+-fd\b"),
    re.compile(r"\brm\s+-rf\b"),
    re.compile(r"\bgit\s+push\b.*\s--force\b"),
]


def mask_sensitive_text(text: str) -> str:
    masked = text
    for pattern in SECRET_PATTERNS + PII_PATTERNS:
        masked = pattern.sub("[REDACTED]", masked)
    return masked


def enforce_prompt_policy(prompt: str) -> None:
    for pattern in BLOCKED_COMMAND_PATTERNS:
        if pattern.search(prompt):
            raise PolicyViolationError(f"Blocked policy pattern detected: {pattern.pattern}")

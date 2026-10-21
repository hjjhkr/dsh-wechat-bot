"""Safe, fixed send diagnostic values shared across the worker pipeline."""

from __future__ import annotations

SEND_REASON_CODES = frozenset({
    "desktop_unavailable",
    "monitor_start",
    "foreground_guard",
    "gate_preflight",
    "uia_draft",
    "targeted_return",
    "gate_restore",
    "db_verify",
    "send_unknown",
})


def safe_reason_code(value: object) -> str:
    return value if isinstance(value, str) and value in SEND_REASON_CODES else "send_unknown"


def safe_send_attempted(value: object) -> bool | None:
    return value if value is True or value is False else None


def safe_focus_diagnostic(value):
    import re
    if not isinstance(value, dict):
        return None
    counts = ("samples", "zeroForegrounds", "unknownOwners", "botForegrounds", "botFocusEvents")
    flags = ("safe", "monitorFailed", "defaultDesktop")
    if any(type(value.get(k)) is not bool for k in flags) or any(
            type(value.get(k)) is not int or value[k] < 0 for k in counts):
        return None
    for field in ("errors", "failureReasons"):
        errors = value.get(field)
        if not isinstance(errors, list) or len(errors) > 8 or any(
                not isinstance(e, str) or not re.fullmatch(r"[A-Za-z_]{1,64}", e) for e in errors):
            return None
    return {k: value[k] for k in (*flags, *counts, "errors", "failureReasons")}

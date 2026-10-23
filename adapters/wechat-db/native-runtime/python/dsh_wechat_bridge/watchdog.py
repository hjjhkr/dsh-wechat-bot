"""Detached recovery process entry point for the one-byte gate lease."""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dsh_wechat_bridge.gate import watchdog_main  # noqa: E402


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(2)
    raise SystemExit(watchdog_main(sys.argv[1]))

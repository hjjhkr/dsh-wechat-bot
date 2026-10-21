"""Executable JSONL entry point; no WeChat modules load before probe."""

from __future__ import annotations

import sys

from dsh_wechat_bridge.worker import main as _main, serve_jsonl


def main() -> int:
    return _main()


if __name__ == "__main__":
    raise SystemExit(main())

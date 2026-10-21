"""WeChat database adapter (protocol v1 over stdio).

  python -u main.py                                   # newest account under ~/Documents/xwechat_files
  python -u main.py --account wxid_xxx_c53e           # a specific account directory
  python -u main.py --plain path/to/db_storage --self wxid_bot   # unencrypted databases (tests)

Options: --data-root DIR, --keys FILE, --outbox FILE, --poll-ms N, --names names.json
(names.json maps chat ids to display names that should override WeChat's).
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from wechat_db.adapter import Adapter  # noqa: E402
from wechat_db.rpc import Server  # noqa: E402
from wechat_db.source import EncryptedSource, PlainSource  # noqa: E402

ACCOUNT_SUFFIX = re.compile(r"_[0-9a-f]{4}$")


def newest_account(root: Path) -> str:
    """The account directory whose message database changed most recently."""
    candidates = []
    for account in root.glob("wxid_*"):
        wal = account / "db_storage" / "message" / "message_0.db-wal"
        db = account / "db_storage" / "message" / "message_0.db"
        stamp = max((p.stat().st_mtime for p in (wal, db) if p.exists()), default=0)
        if stamp:
            candidates.append((stamp, account.name))
    if not candidates:
        raise SystemExit(f"no WeChat account under {root}")
    return max(candidates)[1]


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data-root", default=str(Path.home() / "Documents" / "xwechat_files"))
    parser.add_argument("--account", help="account directory name, e.g. wxid_xxx_c53e")
    parser.add_argument("--self", dest="self_id", help="the account's wxid (derived from --account when omitted)")
    parser.add_argument("--keys", help="key cache file (default: <dataDir>/wechat-db/<account>.keys.json)")
    parser.add_argument("--plain", help="directory of unencrypted databases laid out like db_storage/")
    parser.add_argument("--outbox", help="where outgoing message JSON lines go (default: <dataDir>/wechat-outbox.jsonl)")
    parser.add_argument("--poll-ms", type=int, default=1000)
    parser.add_argument("--names", help="JSON file mapping chat ids to display names")
    args = parser.parse_args(argv)

    if args.plain:
        if not args.self_id:
            parser.error("--plain needs --self")
        self_id = args.self_id
        open_source = lambda _data_dir: PlainSource(args.plain)  # noqa: E731
    else:
        root = Path(args.data_root)
        account = args.account or newest_account(root)
        self_id = args.self_id or ACCOUNT_SUFFIX.sub("", account)

        def open_source(data_dir: Path):
            base = data_dir / "wechat-db"
            keys = args.keys or base / f"{account}.keys.json"
            return EncryptedSource(root, account, keys, base / "cache" / account)

    chat_names = json.loads(Path(args.names).read_text(encoding="utf-8")) if args.names else {}
    server = Server()
    Adapter(server, open_source, self_id, poll_ms=args.poll_ms, outbox_path=args.outbox, chat_names=chat_names)
    server.serve()


if __name__ == "__main__":
    main()

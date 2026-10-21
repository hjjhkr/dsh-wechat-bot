"""Where the SQLite databases come from.

Both sources expose the same small surface used by the reader:
  contact()  -> connection to contact.db
  shards()   -> [(label, open)] for every message/message_N.db
Connections use sqlite3.Row and are opened fresh per read (the caller closes them).
"""
from __future__ import annotations

import importlib.util
import logging
import re
import sqlite3
import sys
import types
from pathlib import Path

VENDOR_DB = Path(__file__).resolve().parents[1] / "vendor" / "db.py"
SHARD = re.compile(r"message_\d+\.db$")


def _connect(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{path.as_posix()}?mode=ro", uri=True, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


class PlainSource:
    """Unencrypted databases laid out like db_storage/ (contact/contact.db, message/message_N.db).

    Used by the tests, and for databases that were decrypted by another tool.
    """

    def __init__(self, root: str | Path):
        self.root = Path(root)
        if not (self.root / "contact" / "contact.db").is_file():
            raise FileNotFoundError(f"no contact/contact.db under {self.root}")

    def contact(self) -> sqlite3.Connection:
        return _connect(self.root / "contact" / "contact.db")

    def shards(self):
        files = sorted(p for p in (self.root / "message").glob("message_*.db") if SHARD.search(p.name))
        return [(p.name, lambda p=p: _connect(p)) for p in files]


def _load_vendored_db():
    """Import vendor/db.py (from the wechatauto project) without its package."""
    name = "wechat_db._vendored_db"
    if name in sys.modules:
        return sys.modules[name]
    shim = types.ModuleType("wechatauto")
    shim.__path__ = []
    logger = types.ModuleType("wechatauto.logger")
    logger.wxlog = logging.getLogger("wechat_db.vendor")
    sys.modules.setdefault("wechatauto", shim)
    sys.modules.setdefault("wechatauto.logger", logger)
    spec = importlib.util.spec_from_file_location(name, VENDOR_DB)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


class EncryptedSource:
    """The live, SQLCipher-encrypted databases of one WeChat 4.x account.

    Decryption (and reading the per-database keys from the running, logged-in
    Weixin process, cached in `keys_file` afterwards) is delegated to the
    vendored db.py; decrypted copies are kept in `workdir` and refreshed from
    the WAL on every open, so new messages show up within one poll.
    """

    def __init__(self, data_root: str | Path, account_dir: str, keys_file: str | Path, workdir: str | Path):
        module = _load_vendored_db()
        Path(workdir).mkdir(parents=True, exist_ok=True)
        self.db = module.WeChatDB(db_dir=str(data_root), account=account_dir,
                                  keys_file=str(keys_file), workdir=str(workdir))

    def contact(self) -> sqlite3.Connection:
        conn = self.db._contact_conn()
        if conn is None:
            raise RuntimeError("contact.db could not be opened")
        conn.row_factory = sqlite3.Row
        return conn

    def shards(self):
        self.db._refresh_db_files()

        def opener(rel):
            def open_shard():
                conn = self.db._open(rel)
                conn.row_factory = sqlite3.Row
                return conn
            return open_shard

        return [(rel, opener(rel)) for rel in self.db._message_dbs()]

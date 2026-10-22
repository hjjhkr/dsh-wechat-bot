"""Where the SQLite databases come from.

Both sources expose the same small surface used by the reader:
  contact()  -> connection to contact.db
  shards()   -> [(label, open)] for every message/message_N.db
Connections use sqlite3.Row and are opened fresh per read (the caller closes them).
"""
from __future__ import annotations

import importlib.util
import json
import logging
import os
import re
import sqlite3
import sys
import types
from pathlib import Path

VENDOR_DB = Path(__file__).resolve().parents[1] / "vendor" / "db.py"
SHARD = re.compile(r"message_\d+\.db$")


class DatabaseScopeError(RuntimeError):
    """The configured account, database set, or explicit key cache is invalid."""


def _load_explicit_key_cache(path: Path, required: list[str]) -> dict[str, bytes]:
    """Read only the configured cache and require one valid key per current DB."""
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise DatabaseScopeError("configured account key cache is unreadable") from exc
    if not isinstance(document, dict) or not required:
        raise DatabaseScopeError("configured account key cache has an invalid shape")

    keys = {}
    for rel in required:
        value = document.get(rel)
        if not isinstance(value, str):
            raise DatabaseScopeError("configured account key cache is missing a required database")
        try:
            key = bytes.fromhex(value)
        except ValueError as exc:
            raise DatabaseScopeError("configured account key cache contains an invalid key") from exc
        if len(key) not in (32, 48):
            raise DatabaseScopeError("configured account key cache contains an invalid key length")
        keys[rel] = key
    return keys


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

    Decryption is delegated to vendored db.py, while keys come only from the
    explicit `keys_file`. Account discovery, process scanning, key extraction,
    cache writes, and cross-account fallback are disabled. Decrypted copies
    are kept in `workdir` and refreshed from the WAL on every open.
    """

    def __init__(self, data_root: str | Path, account_dir: str, keys_file: str | Path, workdir: str | Path):
        module = _load_vendored_db()
        root = Path(data_root).resolve(strict=True)
        if not root.is_dir():
            raise DatabaseScopeError("configured account data root is not a directory")

        account_name = str(account_dir)
        account_component = Path(account_name)
        if (not account_name or account_name in (".", "..") or account_component.is_absolute()
                or account_component.drive or account_component.name != account_name
                or "/" in account_name or "\\" in account_name):
            raise DatabaseScopeError("configured account must be one directory name")
        account_path = root / account_name
        try:
            pinned_account = account_path.resolve(strict=True)
        except OSError as exc:
            raise DatabaseScopeError("configured account directory is missing") from exc
        if pinned_account != account_path or not pinned_account.is_dir():
            raise DatabaseScopeError("configured account directory is not a direct account directory")

        if keys_file is None or not str(keys_file).strip():
            raise DatabaseScopeError("an explicit account key cache is required")
        try:
            key_cache = Path(keys_file).resolve(strict=True)
        except OSError as exc:
            raise DatabaseScopeError("configured account key cache is missing") from exc
        if not key_cache.is_file():
            raise DatabaseScopeError("configured account key cache is not a file")

        work_path = Path(workdir)
        work_path.mkdir(parents=True, exist_ok=True)
        pinned_workdir = work_path.resolve(strict=True)
        if not pinned_workdir.is_dir():
            raise DatabaseScopeError("configured database work directory is not a directory")

        class ScopedWeChatDB(module.WeChatDB):
            """Vendored reader constrained to one account and one explicit cache."""

            def _assert_scope(self):
                try:
                    actual_root = Path(self.db_dir).resolve(strict=True)
                    actual_account = Path(self.account_dir).resolve(strict=True)
                    actual_cache = Path(self.keys_file).resolve(strict=True)
                    actual_workdir = Path(self.workdir).resolve(strict=True)
                except OSError as exc:
                    raise DatabaseScopeError("configured database scope changed") from exc
                if (self.account != account_name or actual_root != root
                        or actual_account != pinned_account or actual_cache != key_cache
                        or actual_workdir != pinned_workdir):
                    raise DatabaseScopeError("configured database scope changed")

            def _collect_db_files(self):
                self._assert_scope()
                base = pinned_account / "db_storage"
                try:
                    resolved_base = base.resolve(strict=True)
                except OSError as exc:
                    raise DatabaseScopeError("configured account database directory is missing") from exc
                if resolved_base != base or not base.is_dir():
                    raise DatabaseScopeError("configured account database directory is outside its account")

                candidates = [base / "contact" / "contact.db"]
                message_dir = base / "message"
                if message_dir.exists():
                    try:
                        resolved_message_dir = message_dir.resolve(strict=True)
                    except OSError as exc:
                        raise DatabaseScopeError("configured account message directory is invalid") from exc
                    if resolved_message_dir != message_dir or not message_dir.is_dir():
                        raise DatabaseScopeError("configured account message directory is outside its account")
                    candidates.extend(p for p in message_dir.glob("message_*.db") if SHARD.fullmatch(p.name))

                files = []
                for candidate in candidates:
                    if not candidate.is_file():
                        continue
                    try:
                        resolved = candidate.resolve(strict=True)
                    except OSError as exc:
                        raise DatabaseScopeError("configured account database file is invalid") from exc
                    if resolved != candidate or not resolved.is_relative_to(base):
                        raise DatabaseScopeError("configured account database file escapes its database directory")
                    rel = candidate.relative_to(base).as_posix().replace("/", os.sep)
                    files.append((rel, str(candidate), candidate.stat().st_size))

                files.sort(key=lambda row: row[0].casefold())
                if not any(rel == os.path.join("contact", "contact.db") for rel, _, _ in files):
                    raise DatabaseScopeError("configured account contact database is missing")
                if not any(rel.startswith("message" + os.sep) for rel, _, _ in files):
                    raise DatabaseScopeError("configured account message databases are missing")
                return files

            def _load_or_extract_keys(self, master_key=None):
                self._assert_scope()
                if master_key is not None:
                    raise DatabaseScopeError("external master keys are not accepted")
                self.master_key = None
                self.cfg_dword = None
                required = [rel for rel, _, _ in self._db_files]
                keys = _load_explicit_key_cache(key_cache, required)
                self._keys = keys
                invalid = [rel for rel in required if not self._key_works(rel)]
                if invalid:
                    self._keys = {}
                    raise DatabaseScopeError(
                        "configured account key cache does not verify all current account databases"
                    )
                self.unkeyed = []

            def _refresh_db_files(self):
                current = self._collect_db_files()
                if current == self._db_files:
                    return
                previous_files, previous_keys = self._db_files, self._keys
                self._db_files = current
                try:
                    self._load_or_extract_keys()
                except Exception:
                    self._db_files, self._keys = previous_files, previous_keys
                    raise

            def _find_weixin_pids(self):
                raise DatabaseScopeError("account database reader cannot search for alternate processes")

            def extract_keys(self):
                raise DatabaseScopeError("account database reader does not extract keys from process memory")

            def extract_master_key(self):
                raise DatabaseScopeError("account database reader does not extract master keys")

            def _try_other_accounts(self):
                raise DatabaseScopeError("cross-account database fallback is disabled")

            def _select_account_by_keys(self, *_args, **_kwargs):
                raise DatabaseScopeError("automatic account switching is disabled")

            def _all_key_candidates(self):
                raise DatabaseScopeError("cross-account key candidate scanning is disabled")

            def _save_keys(self):
                raise DatabaseScopeError("account key cache writes are disabled")

            def _auto_diagnose_key_failure(self, _rel):
                raise DatabaseScopeError("configured account key cache has no verified key for the database")

            def _contact_conn(self):
                return self._open(os.path.join("contact", "contact.db"))

        self.db = ScopedWeChatDB(db_dir=str(root), account=account_name,
                                 keys_file=str(key_cache), workdir=str(pinned_workdir))

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

"""Read-only account-scoped database access using one explicit bot key cache."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from .process import ProcessBindingError, account_candidates
from .vendor import load_db_module


class DbScopeError(RuntimeError):
    pass


def load_bot_key_cache(path: str | Path, required_db_files: list[str]) -> dict[str, bytes]:
    """Load only one configured cache and fail if any required DB key is absent/bad."""
    try:
        cache_path = Path(path).resolve(strict=True)
        raw = json.loads(cache_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise DbScopeError("configured bot key cache is unreadable") from exc
    if not isinstance(raw, dict) or not required_db_files:
        raise DbScopeError("configured bot key cache has an invalid shape")
    keys: dict[str, bytes] = {}
    for rel in required_db_files:
        value = raw.get(rel)
        if not isinstance(value, str):
            raise DbScopeError("configured bot key cache is missing a required database")
        try:
            decoded = bytes.fromhex(value)
        except ValueError as exc:
            raise DbScopeError("configured bot key cache contains an invalid key") from exc
        if len(decoded) not in (32, 48):
            raise DbScopeError("configured bot key cache contains an invalid key length")
        keys[rel] = decoded
    return keys


def verify_target_contact(db: Any, target_wxid: str, target_name: str) -> None:
    """Require the configured wxid and exact current display name to identify one row."""
    conn = db._contact_conn()
    if conn is None:
        raise DbScopeError("contact database could not be opened")
    try:
        rows = conn.execute(
            "SELECT username, nick_name, remark FROM contact WHERE username=? LIMIT 2",
            (target_wxid,),
        ).fetchall()
    except Exception as exc:
        raise DbScopeError("configured target contact could not be verified") from exc
    finally:
        conn.close()
    exact = [
        row for row in rows
        if (row[2] or row[1] or "") == target_name
    ]
    if len(rows) != 1 or len(exact) != 1 or rows[0][0] != target_wxid:
        raise DbScopeError("configured target wxid and exact display name do not match")


def create_scoped_database(config: dict[str, Any], account_name: str | None = None) -> Any:
    """Build a vendored WeChatDB subclass with no key extraction or cache fallback."""
    root = Path(config["dbRoot"]).resolve(strict=True)
    state_root = Path(config["stateRoot"]).resolve()
    key_cache = Path(config["keyCacheFile"]).resolve(strict=True)
    if not key_cache.is_relative_to(state_root):
        raise DbScopeError("bot key cache is outside the configured worker state root")
    try:
        accounts = account_candidates(root, config["botWxid"])
    except ProcessBindingError as exc:
        raise DbScopeError("configured bot account directory could not be located") from exc
    if len(accounts) != 1:
        raise DbScopeError("configured bot account directory is not unique")
    account = accounts[0]
    if account_name is not None and account.name != account_name:
        raise DbScopeError("configured bot account changed after process binding")
    workdir = (state_root / "db-cache" / account.name).resolve()
    if not workdir.is_relative_to(state_root):
        raise DbScopeError("database cache path escaped the configured state root")
    workdir.mkdir(parents=True, exist_ok=True)
    db_module = load_db_module()

    class BotOnlyDB(db_module.WeChatDB):
        def _collect_db_files(self):
            base = Path(self.account_dir) / "db_storage"
            if not base.is_dir():
                raise DbScopeError("configured bot database directory is missing")
            files = []
            for candidate in base.rglob("*.db"):
                rel = os.path.relpath(candidate, base)
                if rel.replace("/", "\\") == "contact\\contact.db" or re.fullmatch(
                    r"message[\\/]message_\d+\.db", rel
                ):
                    files.append((rel, str(candidate), candidate.stat().st_size))
            files.sort(key=lambda row: row[0].casefold())
            if not any(rel.replace("/", "\\") == "contact\\contact.db" for rel, _, _ in files):
                raise DbScopeError("configured bot contact database is missing")
            if not any(re.fullmatch(r"message[\\/]message_\d+\.db", rel) for rel, _, _ in files):
                raise DbScopeError("configured bot message databases are missing")
            return files

        def _load_or_extract_keys(self, master_key=None):
            if master_key is not None:
                raise DbScopeError("external master keys are not accepted")
            self.master_key = None
            self.cfg_dword = None
            keys = load_bot_key_cache(key_cache, [row[0] for row in self._db_files])
            self._keys = keys
            invalid = [rel for rel, _, _ in self._db_files if not self._key_works(rel)]
            if invalid:
                self._keys = {}
                raise DbScopeError("configured bot key cache does not verify all current bot databases")

        def _find_weixin_pids(self):
            raise DbScopeError("database reader cannot search for or attach to alternate processes")

        def extract_keys(self):
            raise DbScopeError("database reader does not extract keys from process memory")

        def extract_master_key(self):
            raise DbScopeError("database reader does not extract master keys")

        def _try_other_accounts(self):
            raise DbScopeError("cross-account fallback is disabled")

        def _select_account_by_keys(self, *_args, **_kwargs):
            raise DbScopeError("automatic account switching is disabled")

        def _all_key_candidates(self):
            raise DbScopeError("cross-account key candidate scanning is disabled")

        def _save_keys(self):
            raise DbScopeError("key cache writes are disabled")

    return BotOnlyDB(
        db_dir=str(root),
        account=account.name,
        workdir=str(workdir),
        keys_file=str(key_cache),
    )


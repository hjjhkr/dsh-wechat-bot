"""Regression tests for the account-scoped encrypted database source."""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wechat_db import source  # noqa: E402


BOT_ACCOUNT = "wxid_bot_a123"
OTHER_ACCOUNT = "wxid_work_b456"
BOT_KEY = bytes.fromhex("11" * 32)
OTHER_KEY = bytes.fromhex("22" * 32)


def _account(root: Path, name: str) -> Path:
    base = root / name / "db_storage"
    for relative in (
        Path("contact/contact.db"),
        Path("message/message_0.db"),
        Path("message/message_1.db"),
        Path("message/not_a_shard.db"),
        Path("contact/contact-extra.db"),
        Path("media/attachment.db"),
    ):
        target = base / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(b"synthetic encrypted database")
    return base


def _cache(path: Path, account: Path, key: bytes, *, omit: str | None = None) -> None:
    base = account / "db_storage"
    files = [Path("contact/contact.db"), Path("message/message_0.db"), Path("message/message_1.db")]
    value = {os.path.join(*relative.parts): key.hex() for relative in files
             if os.path.join(*relative.parts) != omit}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def _tripwire_vendor_side_effects(monkeypatch, source_module):
    """Replace only vendor memory/process/cache-writing seams with safe counters."""
    vendor = source_module._load_vendored_db()
    calls = []

    def extract_keys(db):
        calls.append(("extract_keys", db.account))
        return {rel: BOT_KEY if db.account == BOT_ACCOUNT else OTHER_KEY
                for rel, _, _ in db._db_files}

    def extract_master_key(db):
        calls.append(("extract_master_key", db.account))
        return None

    def try_other_accounts(db):
        calls.append(("_try_other_accounts", db.account))
        return False

    def select_account(db, *_args, **_kwargs):
        calls.append(("_select_account_by_keys", db.account))
        return False

    def save_keys(db):
        calls.append(("_save_keys", db.account))

    def find_processes(db):
        calls.append(("_find_weixin_pids", db.account))
        return []

    def candidates(db):
        calls.append(("_all_key_candidates", db.account))
        return set()

    def diagnose(db, rel):
        calls.append(("_auto_diagnose_key_failure", db.account))

    for name, replacement in {
        "extract_keys": extract_keys,
        "extract_master_key": extract_master_key,
        "_try_other_accounts": try_other_accounts,
        "_select_account_by_keys": select_account,
        "_save_keys": save_keys,
        "_find_weixin_pids": find_processes,
        "_all_key_candidates": candidates,
        "_auto_diagnose_key_failure": diagnose,
    }.items():
        monkeypatch.setattr(vendor.WeChatDB, name, replacement)

    def key_works(db, relative):
        expected = BOT_KEY if db.account == BOT_ACCOUNT else OTHER_KEY
        return db._keys.get(relative) == expected

    monkeypatch.setattr(vendor.WeChatDB, "_key_works", key_works)
    monkeypatch.setattr(source_module, "_load_vendored_db", lambda: vendor)
    return calls


def test_encrypted_source_is_limited_to_the_explicit_account_and_database_allowlist(tmp_path, monkeypatch):
    root = tmp_path / "xwechat_files"
    bot_db = _account(root, BOT_ACCOUNT)
    _account(root, OTHER_ACCOUNT)
    cache = tmp_path / "state" / "bot.keys.json"
    _cache(cache, bot_db, BOT_KEY)
    calls = _tripwire_vendor_side_effects(monkeypatch, source)

    encrypted = source.EncryptedSource(root, BOT_ACCOUNT, cache, tmp_path / "state" / "bot-cache")

    assert encrypted.db.account == BOT_ACCOUNT
    assert [label for label, _ in encrypted.shards()] == [
        os.path.join("message", "message_0.db"),
        os.path.join("message", "message_1.db"),
    ]
    assert calls == []


@pytest.mark.parametrize("broken_cache", ["missing-entry", "malformed-hex", "wrong-key"])
def test_bad_explicit_key_cache_fails_without_extracting_or_falling_back(tmp_path, monkeypatch, broken_cache):
    root = tmp_path / "xwechat_files"
    bot_db = _account(root, BOT_ACCOUNT)
    _account(root, OTHER_ACCOUNT)
    cache = tmp_path / "state" / "bot.keys.json"
    _cache(cache, bot_db, BOT_KEY, omit=os.path.join("message", "message_1.db") if broken_cache == "missing-entry" else None)
    if broken_cache in ("malformed-hex", "wrong-key"):
        document = json.loads(cache.read_text(encoding="utf-8"))
        entry = os.path.join("message", "message_1.db")
        document[entry] = "not-hex" if broken_cache == "malformed-hex" else OTHER_KEY.hex()
        cache.write_text(json.dumps(document), encoding="utf-8")
    calls = _tripwire_vendor_side_effects(monkeypatch, source)

    with pytest.raises(RuntimeError, match="cache"):
        source.EncryptedSource(root, BOT_ACCOUNT, cache, tmp_path / "state" / "bot-cache")

    assert calls == []


def test_new_message_shard_requires_its_own_explicit_key_without_fallback(tmp_path, monkeypatch):
    root = tmp_path / "xwechat_files"
    bot_db = _account(root, BOT_ACCOUNT)
    cache = tmp_path / "state" / "bot.keys.json"
    _cache(cache, bot_db, BOT_KEY)
    calls = _tripwire_vendor_side_effects(monkeypatch, source)
    encrypted = source.EncryptedSource(root, BOT_ACCOUNT, cache, tmp_path / "state" / "bot-cache")

    shard = bot_db / "message" / "message_2.db"
    shard.write_bytes(b"synthetic new shard")
    with pytest.raises(RuntimeError, match="cache"):
        encrypted.shards()

    assert calls == []

"""Adapter + durable delivery + legacy JSONL worker integration tests.

All worker processes here are the fake child in test_legacy_sender.py. No
WeChat process, database, desktop, or network endpoint is contacted.
"""
from __future__ import annotations

import io
import json
import subprocess
import sys
from pathlib import Path

import pytest

TEST_DIR = Path(__file__).resolve().parent
ADAPTER_DIR = TEST_DIR.parent
sys.path.insert(0, str(TEST_DIR))
sys.path.insert(0, str(ADAPTER_DIR))

from fixtures import Account, BOT, GROUP  # noqa: E402
from test_legacy_sender import _read_trace, _sender_file  # noqa: E402
from wechat_db.adapter import Adapter  # noqa: E402
from wechat_db.delivery import Delivery  # noqa: E402
from wechat_db.legacy_sender import LegacySender  # noqa: E402
from wechat_db.rpc import ProtocolError, Server  # noqa: E402
from wechat_db.source import PlainSource  # noqa: E402


CONTENT = {"kind": "text", "text": "adapter transport integration"}


def _bind_worker_to_fixture_ids(config_path: Path, mode: str | None = None) -> None:
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["worker"]["botWxid"] = BOT
    config["worker"]["targetWxid"] = GROUP
    if mode is not None:
        config["args"][2] = mode
    config_path.write_text(json.dumps(config), encoding="utf-8")


def _new_adapter(tmp_path: Path, account: Account, config_path: Path) -> Adapter:
    sender = LegacySender.from_file(config_path, BOT)
    adapter = Adapter(
        Server(stdout=io.BytesIO()),
        lambda _data_dir: PlainSource(account.root),
        BOT,
        sender=sender,
        poll_ms=10,
    )
    info = adapter.on_initialize({"protocolVersion": 1, "dataDir": str(tmp_path)})
    assert info["capabilities"]["send"] == ["text"]
    return adapter


def _request(client_id: str) -> dict:
    return {"chatId": GROUP, "clientId": client_id, "content": CONTENT}


def _account(tmp_path: Path) -> Account:
    account = Account(tmp_path / "db_storage")
    account.add(GROUP, BOT, "existing row")
    return account


def test_confirmed_client_id_survives_adapter_restart_without_another_worker(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as legacy_sender_module

    monkeypatch.setattr(legacy_sender_module, "_desktop_available", lambda: True)
    account = _account(tmp_path)
    config_path, trace_path = _sender_file(tmp_path)
    _bind_worker_to_fixture_ids(config_path)

    first = _new_adapter(tmp_path, account, config_path)
    try:
        assert first.on_message_send(_request("confirmed-id")) == {"messageId": "9001"}
    finally:
        first.on_shutdown({})

    before_restart = _read_trace(trace_path)
    assert [frame["method"] for frame in before_restart] == ["probe", "send", "close"]

    restarted = _new_adapter(tmp_path, account, config_path)
    try:
        assert restarted.on_message_send(_request("confirmed-id")) == {"messageId": "9001"}
    finally:
        restarted.on_shutdown({})

    assert _read_trace(trace_path) == before_restart


def test_uncertain_client_id_is_not_retried_after_restart_but_new_id_can_send(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as legacy_sender_module

    monkeypatch.setattr(legacy_sender_module, "_desktop_available", lambda: True)
    account = _account(tmp_path)
    config_path, trace_path = _sender_file(tmp_path, "worker_error")
    _bind_worker_to_fixture_ids(config_path)

    first = _new_adapter(tmp_path, account, config_path)
    try:
        with pytest.raises(ProtocolError) as error:
            first.on_message_send(_request("uncertain-id"))
        assert error.value.code == "send_uncertain"
    finally:
        first.on_shutdown({})

    first_attempt = _read_trace(trace_path)
    assert [frame["method"] for frame in first_attempt] == ["probe", "send", "close"]
    assert first_attempt[1]["params"]["attemptId"] == "uncertain-id"

    # Model a later safe worker configuration while keeping the durable journal.
    _bind_worker_to_fixture_ids(config_path, "confirmed")
    restarted = _new_adapter(tmp_path, account, config_path)
    try:
        with pytest.raises(ProtocolError) as error:
            restarted.on_message_send(_request("uncertain-id"))
        assert error.value.code == "send_uncertain"
        assert _read_trace(trace_path) == first_attempt

        assert restarted.on_message_send(_request("new-id")) == {"messageId": "9001"}
    finally:
        restarted.on_shutdown({})

    attempts = _read_trace(trace_path)
    assert [frame["method"] for frame in attempts] == [
        "probe", "send", "close", "probe", "send", "close",
    ]
    assert attempts[4]["params"]["attemptId"] == "new-id"


def _run_close_failure_child(config_path: Path, account_root: Path, data_dir: Path) -> int:
    """Run one adapter lifetime so process exit releases its still-held lease."""
    import wechat_db.legacy_sender as legacy_sender_module

    legacy_sender_module._desktop_available = lambda: True
    sender = LegacySender.from_file(config_path, BOT)
    adapter = Adapter(
        Server(stdout=io.BytesIO()),
        lambda _data_dir: PlainSource(account_root),
        BOT,
        sender=sender,
        poll_ms=10,
    )
    adapter.on_initialize({"protocolVersion": 1, "dataDir": str(data_dir)})
    assert adapter.on_message_send(_request("confirmed-before-close-failure")) == {"messageId": "9001"}

    with pytest.raises(ProtocolError) as error:
        adapter.on_shutdown({})
    assert error.value.code == "unavailable"

    journal = data_dir / "wechat-db" / "delivery.jsonl"
    entry = json.loads(journal.read_text(encoding="utf-8").splitlines()[-1])
    assert entry["state"] == "confirmed"
    assert entry["messageId"] == "9001"
    assert entry["recoveryRequired"] is True
    return 0


def test_close_failure_is_durable_and_restart_blocks_new_client_ids(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as legacy_sender_module

    monkeypatch.setattr(legacy_sender_module, "_desktop_available", lambda: True)
    account = _account(tmp_path)
    config_path, trace_path = _sender_file(tmp_path, "close_fail_exit")
    _bind_worker_to_fixture_ids(config_path)
    data_dir = tmp_path / "adapter-data"

    child = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve()),
            "--close-failure-child",
            str(config_path),
            str(account.root),
            str(data_dir),
        ],
        cwd=ADAPTER_DIR.parents[1],
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert child.returncode == 0, child.stdout + child.stderr
    assert [frame["method"] for frame in _read_trace(trace_path)] == ["probe", "send", "close"]

    restarted = _new_adapter(data_dir, account, config_path)
    try:
        with pytest.raises(ProtocolError) as error:
            restarted.on_message_send(_request("new-after-recovery-required"))
        assert error.value.code == "unavailable"
        assert [frame["method"] for frame in _read_trace(trace_path)] == ["probe", "send", "close"]
    finally:
        restarted.on_shutdown({})


def test_main_closes_delivery_lease_after_normal_stdin_eof(tmp_path):
    account = _account(tmp_path)
    config_path, trace_path = _sender_file(tmp_path)
    _bind_worker_to_fixture_ids(config_path)
    data_dir = tmp_path / "adapter-data"
    init = {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
        "protocolVersion": 1, "dataDir": str(data_dir),
    }}
    launcher = (
        "import sys; "
        f"sys.path.insert(0, {str(ADAPTER_DIR)!r}); "
        "import wechat_db.legacy_sender as sender_module; "
        "sender_module._desktop_available = lambda: True; "
        "from main import main; main()"
    )

    result = subprocess.run(
        [
            sys.executable,
            "-c", launcher,
            "--plain", str(account.root),
            "--self", BOT,
            "--sender-config", str(config_path),
            "--poll-ms", "10",
        ],
        input=json.dumps(init) + "\n",
        cwd=ADAPTER_DIR,
        capture_output=True,
        text=True,
        timeout=10,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    frames = [json.loads(line) for line in result.stdout.splitlines()]
    assert any(frame.get("id") == 1 and frame.get("result", {}).get("protocolVersion") == 1 for frame in frames)
    assert _read_trace(trace_path) == []

    # A fresh owner can acquire the journal lock only if main's EOF cleanup closed it.
    delivery = Delivery(
        data_dir / "wechat-db" / "delivery.jsonl",
        LegacySender.from_file(config_path, BOT),
        scope=BOT,
    )
    delivery.close()


if __name__ == "__main__" and "--close-failure-child" in sys.argv:
    index = sys.argv.index("--close-failure-child")
    raise SystemExit(_run_close_failure_child(Path(sys.argv[index + 1]), Path(sys.argv[index + 2]), Path(sys.argv[index + 3])))

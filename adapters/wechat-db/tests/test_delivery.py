"""Delivery must never repeat an attempted send after a crash or lost reply."""
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wechat_db.delivery import Delivery
from wechat_db.rpc import ProtocolError

CONTENT = {"kind": "text", "text": "测试回复"}


class Sender:
    def __init__(self):
        self.calls = []
        self.error = None
        self.ready = True

    def available(self):
        return self.ready

    def send(self, chat_id, content, client_id):
        self.calls.append((chat_id, content, client_id))
        if self.error:
            raise self.error
        return "9912345678901234567"

    def close(self):
        pass


def test_success_is_replayed_after_restart_without_touching_sender(tmp_path):
    path, sender = tmp_path / "delivery.jsonl", Sender()
    lane = Delivery(path, sender, scope="wxid_bot")
    assert lane.send("group", CONTENT, "a") == "9912345678901234567"
    lane.close()
    sender.ready = False
    again = Delivery(path, sender, scope="wxid_bot")
    try:
        assert again.send("group", CONTENT, "a") == "9912345678901234567"
        assert len(sender.calls) == 1
    finally:
        again.close()


@pytest.mark.parametrize("error", [ProtocolError("send_uncertain"), RuntimeError("lost worker")])
def test_unknown_outcome_never_retries_even_after_restart(tmp_path, error):
    path, sender = tmp_path / "delivery.jsonl", Sender()
    sender.error = error
    lane = Delivery(path, sender, scope="wxid_bot")
    with pytest.raises(ProtocolError, match="send_uncertain"):
        lane.send("group", CONTENT, "a")
    lane.close()
    sender.error = None
    lane = Delivery(path, sender, scope="wxid_bot")
    try:
        with pytest.raises(ProtocolError, match="send_uncertain"):
            lane.send("group", CONTENT, "a")
        assert lane.send("group", CONTENT, "b") == "9912345678901234567"
        assert [call[2] for call in sender.calls] == ["a", "b"]
    finally:
        lane.close()


@pytest.mark.parametrize("code", ["send_failed", "unavailable", "unsupported", "invalid_params"])
def test_proven_no_send_can_be_retried_with_same_id(tmp_path, code):
    sender = Sender()
    sender.error = ProtocolError(code)
    lane = Delivery(tmp_path / "delivery.jsonl", sender, scope="wxid_bot")
    try:
        with pytest.raises(ProtocolError) as error:
            lane.send("group", CONTENT, "a")
        assert error.value.code == code
        sender.error = None
        assert lane.send("group", CONTENT, "a") == "9912345678901234567"
    finally:
        lane.close()


def test_attempt_is_durable_before_sender_and_pending_is_uncertain(tmp_path):
    path, sender = tmp_path / "delivery.jsonl", Sender()
    lane = Delivery(path, sender, scope="wxid_bot")
    original = sender.send

    def crash(chat, content, client_id):
        entry = json.loads(path.read_text(encoding="utf-8").splitlines()[-1])
        assert entry["state"] == "pending"
        sender.calls.append((chat, content, client_id))  # side effect already happened
        raise KeyboardInterrupt("crash after send, before outcome persistence")

    sender.send = crash
    with pytest.raises(KeyboardInterrupt):
        lane.send("group", CONTENT, "a")
    lane.close()
    sender.send = original
    lane = Delivery(path, sender, scope="wxid_bot")
    try:
        with pytest.raises(ProtocolError) as error:
            lane.send("group", CONTENT, "a")
        assert error.value.code == "send_uncertain"
        assert len(sender.calls) == 1
    finally:
        lane.close()


@pytest.mark.parametrize("change", ["content", "chat", "scope"])
def test_same_id_with_changed_request_is_rejected(tmp_path, change):
    path, sender = tmp_path / "delivery.jsonl", Sender()
    lane = Delivery(path, sender, scope="wxid_bot")
    lane.send("group", CONTENT, "a")
    lane.close()
    lane = Delivery(path, sender, scope="other" if change == "scope" else "wxid_bot")
    try:
        with pytest.raises(ProtocolError) as error:
            lane.send("other" if change == "chat" else "group",
                      {"kind": "text", "text": "changed"} if change == "content" else CONTENT, "a")
        assert error.value.code == "invalid_params"
        assert len(sender.calls) == 1
    finally:
        lane.close()


def test_fsync_failure_prevents_any_side_effect(tmp_path, monkeypatch):
    sender = Sender()
    lane = Delivery(tmp_path / "delivery.jsonl", sender, scope="wxid_bot")
    try:
        def broken(_fd):
            raise OSError("disk full")
        monkeypatch.setattr("wechat_db.delivery.os.fsync", broken)
        with pytest.raises(OSError, match="disk full"):
            lane.send("group", CONTENT, "a")
        assert sender.calls == []
    finally:
        lane.close()


def test_concurrent_duplicates_are_serialized(tmp_path):
    sender = Sender()
    lane = Delivery(tmp_path / "delivery.jsonl", sender, scope="wxid_bot")
    try:
        with ThreadPoolExecutor(4) as pool:
            results = list(pool.map(lambda _: lane.send("group", CONTENT, "a"), range(8)))
        assert results == ["9912345678901234567"] * 8
        assert len(sender.calls) == 1
    finally:
        lane.close()


def test_second_owner_cannot_open_live_journal(tmp_path):
    path = tmp_path / "delivery.jsonl"
    lane = Delivery(path, Sender(), scope="wxid_bot")
    try:
        with pytest.raises((OSError, RuntimeError)):
            Delivery(path, Sender(), scope="wxid_bot")
    finally:
        lane.close()
    lane = Delivery(path, Sender(), scope="wxid_bot")
    lane.close()


def test_corrupt_journal_fails_closed_instead_of_forgetting_attempts(tmp_path):
    path = tmp_path / "delivery.jsonl"
    path.write_text('{"clientId":"a","state":"pend', encoding="utf-8")
    with pytest.raises(ValueError, match="journal"):
        Delivery(path, Sender(), scope="wxid_bot")


def test_complete_last_record_without_newline_does_not_glue_next_entry(tmp_path):
    path, sender = tmp_path / "delivery.jsonl", Sender()
    lane = Delivery(path, sender, scope="wxid_bot")
    lane.send("group", CONTENT, "a")
    lane.close()
    path.write_bytes(path.read_bytes().rstrip(b"\n"))
    lane = Delivery(path, sender, scope="wxid_bot")
    lane.send("group", CONTENT, "b")
    lane.close()
    lane = Delivery(path, sender, scope="wxid_bot")
    try:
        assert lane.send("group", CONTENT, "a") == "9912345678901234567"
        assert lane.send("group", CONTENT, "b") == "9912345678901234567"
        assert len(sender.calls) == 2
    finally:
        lane.close()


def test_exclusive_journal_lock_is_enforced_across_processes(tmp_path):
    path = tmp_path / "delivery.jsonl"
    code = """
import sys
sys.path.insert(0, sys.argv[1])
from wechat_db.delivery import Delivery
class Sender:
    def close(self): pass
try:
    lane = Delivery(sys.argv[2], Sender(), scope='wxid_bot')
except OSError:
    sys.exit(23)
lane.close()
"""
    command = [sys.executable, "-c", code, str(Path(__file__).resolve().parents[1]), str(path)]
    lane = Delivery(path, Sender(), scope="wxid_bot")
    try:
        assert subprocess.run(command, timeout=5).returncode == 23
    finally:
        lane.close()
    assert subprocess.run(command, timeout=5).returncode == 0


def test_failed_sender_cleanup_keeps_ownership_until_safely_closed(tmp_path):
    path, sender = tmp_path / "delivery.jsonl", Sender()
    lane = Delivery(path, sender, scope="wxid_bot")
    def unsafe_close():
        raise RuntimeError("gate restoration unknown")
    sender.close = unsafe_close
    with pytest.raises(RuntimeError, match="gate restoration"):
        lane.close()
    with pytest.raises(OSError):
        Delivery(path, Sender(), scope="wxid_bot")
    sender.close = lambda: None
    lane.close()
    Delivery(path, Sender(), scope="wxid_bot").close()


def test_unsafe_worker_cleanup_blocks_new_ids_even_after_adapter_restart(tmp_path):
    path, sender = tmp_path / "delivery.jsonl", Sender()
    sender.recovery_required = True
    lane = Delivery(path, sender, scope="wxid_bot")
    # The receipt itself is certain; the cleanup problem applies to future sends.
    assert lane.send("group", CONTENT, "a") == "9912345678901234567"
    lane.close()
    fresh_sender = Sender()
    lane = Delivery(path, fresh_sender, scope="wxid_bot")
    try:
        assert lane.available() is False
        assert lane.send("group", CONTENT, "a") == "9912345678901234567"
        with pytest.raises(ProtocolError) as error:
            lane.send("group", CONTENT, "b")
        assert error.value.code == "unavailable"
        assert fresh_sender.calls == []
    finally:
        lane.close()


def test_crash_with_pending_attempt_requires_recovery_before_any_new_send(tmp_path):
    path, sender = tmp_path / "delivery.jsonl", Sender()
    lane = Delivery(path, sender, scope="wxid_bot")
    def crash(*_):
        raise KeyboardInterrupt("adapter died with worker outcome unknown")
    sender.send = crash
    with pytest.raises(KeyboardInterrupt):
        lane.send("group", CONTENT, "a")
    lane.close()
    lane = Delivery(path, Sender(), scope="wxid_bot")
    try:
        assert lane.available() is False
        with pytest.raises(ProtocolError) as error:
            lane.send("group", CONTENT, "b")
        assert error.value.code == "unavailable"
    finally:
        lane.close()

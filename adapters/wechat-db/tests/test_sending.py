"""Optional live delivery obeys the adapter protocol without touching WeChat."""
import io
import json
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fixtures import Account, BOT, GROUP
from wechat_db.adapter import Adapter
from wechat_db.rpc import ProtocolError, Server
from wechat_db.source import PlainSource


class Sender:
    target_id = GROUP

    def __init__(self):
        self.ready = True
        self.closed = False
        self.calls = []
        self.error = None
        self.selections = []

    def available(self):
        return self.ready

    def send(self, chat_id, content, client_id):
        self.calls.append((chat_id, content, client_id))
        if self.error:
            raise self.error
        return "9912345678901234567"

    def close(self):
        self.closed = True


class PreparingSender(Sender):
    detached_window = True

    def __init__(self):
        super().__init__()
        self.preparing = False
        self.preparations = []
        self.invalidations = 0
        self.state_callback = None
        self.preparation_error = None
        self.lifecycle_repreparations = []
        self.reprepare_error = None

    def available(self):
        return self.ready and not self.preparing

    def set_state_callback(self, callback):
        self.state_callback = callback

    @property
    def preparation_status(self):
        state = "preparing" if self.preparing else "failed" if self.preparation_error else "ready"
        return {"state": state, "recoveryRequired": False, "error": self.preparation_error}

    def select_target(self, chat):
        self.selections.append(dict(chat))
        self.target_id = chat["id"]
        self.preparing = False
        self.preparation_error = None

    def prepare_target(self, chat_id):
        self.preparations.append(chat_id)
        self.preparing = True

    def invalidate_target(self):
        self.invalidations += 1
        self.preparing = False
        self.preparation_error = None

    def reprepare_target(self, chat_id):
        self.lifecycle_repreparations.append(chat_id)
        if self.reprepare_error is not None:
            raise self.reprepare_error
        self.invalidate_target()
        self.prepare_target(chat_id)
        return "started"

    def finish_preparation(self, *, failed=False):
        self.preparing = False
        self.preparation_error = "独立窗口准备失败；发送继续沿用主窗配置。" if failed else None
        if self.state_callback:
            self.state_callback("warn" if failed else None, self.preparation_error)


class DynamicPreparingSender(PreparingSender):
    pass


def setup_adapter(tmp_path, sender, *, extra_chats=()):
    account = Account(tmp_path / "db_storage")
    account.add(GROUP, BOT, "existing")
    for chat_id in extra_chats:
        account.add(chat_id, chat_id, "existing direct")
    stream = io.BytesIO()
    server = Server(stdout=stream)
    adapter = Adapter(server, lambda _: PlainSource(account.root), BOT, sender=sender, poll_ms=20)
    info = adapter.on_initialize({"protocolVersion": 1, "dataDir": str(tmp_path)})
    return adapter, info, stream


class LifecycleDesktop:
    def __init__(self, pid=100, started_at=1.0):
        self.identity = {"pid": pid, "startedAt": started_at}
        self.visible = False
        self.locked = False
        self.identity_error = None
        self.lifecycle_error = None

    def process_identity(self):
        if self.identity_error is not None:
            raise self.identity_error
        return dict(self.identity) if self.identity else None

    def state(self):
        return {"visible": self.visible, "running": self.identity is not None}

    def lifecycle_state(self):
        if self.lifecycle_error is not None:
            raise self.lifecycle_error
        return {**self.state(), "returned": not self.visible and not self.locked}

    def set_visible(self, visible):
        self.visible = visible
        return self.state()


def test_live_backend_confirms_actual_message_id_and_never_queues_in_outbox(tmp_path):
    sender = Sender()
    adapter, info, _ = setup_adapter(tmp_path, sender)
    try:
        assert info["capabilities"]["send"] == ["text"]
        assert "window" not in info["capabilities"]
        params = {"chatId": GROUP, "clientId": "turn:0", "content": {"kind": "text", "text": "你好"}}
        assert adapter.on_message_send(params) == {"messageId": "9912345678901234567"}
        assert adapter.on_message_send(params) == {"messageId": "9912345678901234567"}
        assert len(sender.calls) == 1
        assert not (tmp_path / "wechat-outbox.jsonl").exists()
    finally:
        adapter.on_shutdown({})
    assert sender.closed


def test_target_scope_is_enforced_before_watching_or_sending(tmp_path):
    sender = Sender()
    adapter, _, _ = setup_adapter(tmp_path, sender)
    try:
        assert [chat["id"] for chat in adapter.on_chats_list({})["chats"]] == [GROUP]
        with pytest.raises(ProtocolError) as error:
            adapter.on_watch_set({"chatIds": ["wxid_friend"]})
        assert error.value.code == "invalid_params"
        with pytest.raises(ProtocolError):
            adapter.on_message_send({"chatId": "wxid_friend", "clientId": "x", "content": {"kind": "text", "text": "oops"}})
        for read in (adapter.on_chats_members, adapter.on_chats_history):
            with pytest.raises(ProtocolError) as error:
                read({"chatId": "wxid_friend", "limit": 10})
            assert error.value.code == "invalid_params"
        assert sender.calls == []
    finally:
        adapter.on_shutdown({})


def test_detached_mode_lists_chats_and_switches_one_safe_active_send_target(tmp_path):
    friend = "wxid_friend"
    sender = DynamicPreparingSender()
    adapter, _, _ = setup_adapter(tmp_path, sender, extra_chats=[friend])
    try:
        chats = adapter.on_chats_list({})["chats"]
        by_id = {chat["id"]: chat for chat in chats}
        assert set(by_id) == {GROUP, friend}
        assert by_id[friend]["kind"] == "direct"
        assert adapter.on_chats_members({"chatId": friend})["members"]
        assert adapter.on_chats_history({"chatId": friend, "limit": 10})["messages"]
        with pytest.raises(ProtocolError) as error:
            adapter.on_chats_history({"chatId": "not-a-known-chat", "limit": 10})
        assert error.value.code == "not_found"
        with pytest.raises(ProtocolError) as error:
            adapter.on_watch_set({"chatIds": ["not-a-known-chat"]})
        assert error.value.code == "not_found"
        assert sender.selections == []

        assert adapter.on_watch_set({"chatIds": [friend]}) == {"watching": [friend]}
        assert sender.selections == [by_id[friend]]
        assert sender.target_id == friend
        assert sender.preparations == [friend]
        with pytest.raises(ProtocolError) as error:
            adapter.on_message_send({"chatId": GROUP, "clientId": "wrong-active-target",
                                     "content": {"kind": "text", "text": "不要发到旧群"}})
        assert error.value.code == "invalid_params"
        assert sender.calls == []

        sender.finish_preparation()
        assert adapter.on_message_send({"chatId": friend, "clientId": "friend-send",
                                        "content": {"kind": "text", "text": "发到当前私聊"}}) == {
            "messageId": "9912345678901234567",
        }

        assert adapter.on_watch_set({"chatIds": [GROUP]}) == {"watching": [GROUP]}
        assert sender.target_id == GROUP
        assert sender.selections[-1] == by_id[GROUP]
        sender.finish_preparation()
        assert adapter.on_message_send({"chatId": GROUP, "clientId": "group-send",
                                        "content": {"kind": "text", "text": "切回当前群"}}) == {
            "messageId": "9912345678901234567",
        }
        assert [call[0] for call in sender.calls] == [friend, GROUP]
    finally:
        adapter.on_shutdown({})


def test_detached_watch_rejects_multiple_targets_before_selection(tmp_path):
    friend = "wxid_friend"
    sender = DynamicPreparingSender()
    adapter, _, _ = setup_adapter(tmp_path, sender, extra_chats=[friend])
    try:
        with pytest.raises(ProtocolError) as error:
            adapter.on_watch_set({"chatIds": [GROUP, friend]})
        assert error.value.code == "invalid_params"
        assert sender.selections == []
        assert sender.preparations == []
    finally:
        adapter.on_shutdown({})


def test_unlock_reports_can_send_even_when_no_new_database_message_arrives(tmp_path):
    sender = Sender()
    sender.ready = False
    adapter, _, stream = setup_adapter(tmp_path, sender)
    try:
        adapter.on_watch_set({"chatIds": [GROUP]})
        params = {"chatId": GROUP, "clientId": "a", "content": {"kind": "text", "text": "等待"}}
        with pytest.raises(ProtocolError) as error:
            adapter.on_message_send(params)
        assert error.value.code == "unavailable" and sender.calls == []
        sender.ready = True
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            statuses = [f["params"] for f in map(json.loads, stream.getvalue().splitlines())
                        if f.get("method") == "event/status"]
            if statuses and statuses[-1]["canSend"]:
                break
            time.sleep(.01)
        assert [s["canSend"] for s in statuses] == [False, True]
        assert adapter.on_message_send(params)["messageId"] == "9912345678901234567"
    finally:
        adapter.on_shutdown({})


def test_database_recovery_does_not_override_locked_sender_status(tmp_path):
    sender = Sender()
    sender.ready = False
    adapter, _, stream = setup_adapter(tmp_path, sender)
    try:
        adapter.healthy = False
        adapter.on_watch_set({"chatIds": [GROUP]})
        deadline = time.monotonic() + 2
        while not adapter.healthy and time.monotonic() < deadline:
            time.sleep(.01)
        statuses = [f["params"] for f in map(json.loads, stream.getvalue().splitlines())
                    if f.get("method") == "event/status"]
        assert statuses and all(s["canSend"] is False for s in statuses)
    finally:
        adapter.on_shutdown({})


@pytest.mark.parametrize("stage,recovery,reason", [
    ("preparing", False, "sender_preparing"),
    ("failed", False, "sender_prepare_failed"),
    ("failed", True, "sender_recovery_required"),
])
def test_preparation_stage_and_error_are_visible_without_enabling_send(tmp_path, stage, recovery, reason):
    sender = Sender()
    sender.ready = False
    sender.preparation_status = {
        "state": stage, "recoveryRequired": recovery,
        "error": "独立窗口准备失败；原因码：target_not_found。" if stage == "failed" else None,
    }
    adapter, _, stream = setup_adapter(tmp_path, sender)
    try:
        adapter._publish_status()
        statuses = [frame["params"] for frame in map(json.loads, stream.getvalue().splitlines())
                    if frame.get("method") == "event/status"]
        assert statuses[-1]["reason"] == reason
        assert statuses[-1]["canSend"] is False
        assert statuses[-1]["detail"]
        if stage == "failed":
            assert "target_not_found" in statuses[-1]["detail"]
        sender.ready = True
        sender.preparation_status = {"state": "ready", "recoveryRequired": False, "error": None}
        adapter._publish_status()
        assert adapter.last_status == {"connection": "connected", "canSend": True}
    finally:
        adapter.on_shutdown({})


def test_detached_watch_prepares_asynchronously_and_unwatch_invalidates_before_delivery(tmp_path):
    sender = PreparingSender()
    adapter, _, stream = setup_adapter(tmp_path, sender)
    journal = tmp_path / "wechat-db" / "delivery.jsonl"
    try:
        assert adapter.on_watch_set({"chatIds": [GROUP]}) == {"watching": [GROUP]}
        assert sender.preparations == [GROUP]
        with pytest.raises(ProtocolError) as error:
            adapter.on_message_send({"chatId": GROUP, "clientId": "before-ready", "content": {"kind": "text", "text": "不可发送"}})
        assert error.value.code == "unavailable"
        assert not journal.exists(), "preparation state must block before a pending attempt is journaled"

        sender.finish_preparation()
        adapter._publish_status()
        assert json.loads(stream.getvalue().splitlines()[-1])["params"]["canSend"] is True

        assert adapter.on_watch_set({"chatIds": []}) == {"watching": []}
        assert sender.invalidations == 1
        assert adapter.on_message_send({"chatId": GROUP, "clientId": "after-unwatch", "content": {"kind": "text", "text": "沿旧sender发送"}}) == {
            "messageId": "9912345678901234567",
        }
        assert len(sender.calls) == 1
        assert journal.exists()
    finally:
        adapter.on_shutdown({})
    assert sender.closed


def test_bot_process_change_reprepares_only_after_returning_from_bot_desktop(tmp_path):
    sender = PreparingSender()
    desktop = LifecycleDesktop()
    sender.desktop_control = desktop
    adapter, _, stream = setup_adapter(tmp_path, sender)
    adapter.poll_s = 0.02
    try:
        adapter.on_watch_set({"chatIds": [GROUP]})
        sender.finish_preparation()

        # Showing an already-running bot process is not a lifecycle restart.
        adapter.on_window_set({"visible": True})
        adapter.on_window_set({"visible": False})
        time.sleep(0.08)
        assert sender.lifecycle_repreparations == []

        # A new process identity while the bot desktop is visible arms one
        # reprepare, but it must wait for the user to return to Default.
        desktop.identity = {"pid": 101, "startedAt": 2.0}
        adapter.on_window_set({"visible": True})
        time.sleep(0.05)
        assert sender.lifecycle_repreparations == []
        adapter._publish_status()
        assert adapter.last_status["canSend"] is False
        with pytest.raises(ProtocolError) as error:
            adapter.on_message_send({
                "chatId": GROUP, "clientId": "must-wait-for-window-reprepare",
                "content": {"kind": "text", "text": "不可发送"},
            })
        assert error.value.code == "unavailable"
        assert sender.calls == []
        assert not (tmp_path / "wechat-db" / "delivery.jsonl").exists()
        desktop.visible = False  # toolbar returns directly to Default, outside the adapter RPC
        deadline = time.monotonic() + 1
        while not sender.lifecycle_repreparations and time.monotonic() < deadline:
            time.sleep(0.01)
        assert sender.lifecycle_repreparations == [GROUP]
        assert sender.preparations == [GROUP, GROUP]
        sender.finish_preparation()
        assert adapter.last_status["canSend"] is True
    finally:
        adapter.on_shutdown({})


def test_login_action_reprepares_same_target_after_toolbar_return(tmp_path):
    sender = PreparingSender()
    desktop = LifecycleDesktop()
    sender.desktop_control = desktop
    adapter, _, _ = setup_adapter(tmp_path, sender)
    adapter.poll_s = 0.02
    try:
        adapter.on_watch_set({"chatIds": [GROUP]})
        sender.finish_preparation()
        login = adapter.on_account_login({})
        assert desktop.visible is True
        assert sender.lifecycle_repreparations == []
        assert "自动重新打开当前监听会话的独立窗口" in login["instructions"]

        desktop.visible = False  # the return toolbar does not call adapter code
        deadline = time.monotonic() + 1
        while not sender.lifecycle_repreparations and time.monotonic() < deadline:
            time.sleep(0.01)
        assert sender.lifecycle_repreparations == [GROUP]
        assert sender.preparations == [GROUP, GROUP]
    finally:
        adapter.on_shutdown({})


def test_login_instructions_require_a_target_only_when_none_is_watched(tmp_path):
    sender = PreparingSender()
    desktop = LifecycleDesktop()
    sender.desktop_control = desktop
    adapter, _, _ = setup_adapter(tmp_path, sender)
    try:
        result = adapter.on_account_login({})
        assert "选择要监听的服务会话" in result["instructions"]
    finally:
        adapter.on_shutdown({})


def test_generic_sender_unavailable_does_not_trigger_window_reprepare(tmp_path):
    sender = PreparingSender()
    sender.ready = False
    desktop = LifecycleDesktop()
    sender.desktop_control = desktop
    adapter, _, _ = setup_adapter(tmp_path, sender)
    adapter.poll_s = 0.02
    try:
        adapter.on_watch_set({"chatIds": [GROUP]})
        desktop.visible = True
        desktop.visible = False
        time.sleep(0.08)
        assert sender.lifecycle_repreparations == []
        assert sender.preparations == [GROUP]
    finally:
        adapter.on_shutdown({})


def test_locked_desktop_is_not_mistaken_for_returning_to_default(tmp_path):
    sender = PreparingSender()
    desktop = LifecycleDesktop()
    sender.desktop_control = desktop
    adapter, _, _ = setup_adapter(tmp_path, sender)
    adapter.poll_s = 0.02
    try:
        adapter.on_watch_set({"chatIds": [GROUP]})
        sender.finish_preparation()
        desktop.visible = True
        adapter._observe_desktop_lifecycle()

        desktop.identity = {"pid": 101, "startedAt": 2.0}
        adapter._observe_desktop_lifecycle()
        desktop.visible = False
        desktop.locked = True
        adapter._observe_desktop_lifecycle()
        assert sender.lifecycle_repreparations == []

        desktop.locked = False
        adapter._observe_desktop_lifecycle()
        assert sender.lifecycle_repreparations == [GROUP]
    finally:
        adapter.on_shutdown({})


def test_lifecycle_prepare_failure_is_not_retried_on_each_status_poll(tmp_path):
    sender = PreparingSender()
    desktop = LifecycleDesktop()
    sender.desktop_control = desktop
    adapter, _, _ = setup_adapter(tmp_path, sender)
    adapter.poll_s = 0.02
    try:
        adapter.on_watch_set({"chatIds": [GROUP]})
        sender.finish_preparation()
        desktop.visible = True
        desktop.identity = {"pid": 101, "startedAt": 2.0}
        adapter._observe_desktop_lifecycle()
        desktop.visible = False
        adapter._observe_desktop_lifecycle()
        assert sender.lifecycle_repreparations == [GROUP]

        sender.finish_preparation(failed=True)
        # Keep this fake unavailable after the reprepare attempt; production
        # preparation failure must not be mistaken for a ready binding.
        sender.ready = False
        time.sleep(0.08)
        assert sender.lifecycle_repreparations == [GROUP]
        assert adapter.last_status["canSend"] is False
        assert adapter.last_status["reason"] == "sender_prepare_failed"
        assert "独立窗口准备失败" in adapter.last_status["detail"]
    finally:
        adapter.on_shutdown({})


@pytest.mark.parametrize("failure_field", ["identity_error", "lifecycle_error"])
def test_lifecycle_read_failure_is_logged_and_blocks_sending_until_reads_recover(tmp_path, failure_field):
    sender = PreparingSender()
    desktop = LifecycleDesktop()
    sender.desktop_control = desktop
    adapter, _, stream = setup_adapter(tmp_path, sender)
    try:
        adapter.on_watch_set({"chatIds": [GROUP]})
        sender.finish_preparation()
        setattr(desktop, failure_field, RuntimeError("synthetic lifecycle read failure"))
        with pytest.raises(RuntimeError, match="synthetic lifecycle read failure"):
            adapter._observe_desktop_lifecycle()
        adapter._publish_status()
        assert adapter.last_status["canSend"] is False
        assert adapter.last_status["reason"] == "sender_recovery_required"
        with pytest.raises(ProtocolError) as error:
            adapter.on_message_send({
                "chatId": GROUP, "clientId": "lifecycle-read-failed",
                "content": {"kind": "text", "text": "不可发送"},
            })
        assert error.value.code == "unavailable"
        assert sender.calls == []
        assert not (tmp_path / "wechat-db" / "delivery.jsonl").exists()

        setattr(desktop, failure_field, None)
        adapter._observe_desktop_lifecycle()
        adapter._publish_status()
        assert adapter.last_status["canSend"] is True
        logs = [frame["params"] for frame in map(json.loads, stream.getvalue().splitlines())
                if frame.get("method") == "event/log"]
        assert any("synthetic lifecycle read failure" in item["message"] for item in logs)
    finally:
        adapter.on_shutdown({})


def test_lifecycle_reprepare_protocol_error_is_exposed_and_not_retried(tmp_path):
    sender = PreparingSender()
    sender.reprepare_error = ProtocolError("invalid_params", "watched target binding mismatch")
    desktop = LifecycleDesktop()
    sender.desktop_control = desktop
    adapter, _, stream = setup_adapter(tmp_path, sender)
    adapter.poll_s = 0.02
    try:
        adapter.on_watch_set({"chatIds": [GROUP]})
        sender.finish_preparation()
        desktop.visible = True
        desktop.identity = {"pid": 101, "startedAt": 2.0}
        adapter._observe_desktop_lifecycle()
        desktop.visible = False
        deadline = time.monotonic() + 1
        while not sender.lifecycle_repreparations and time.monotonic() < deadline:
            time.sleep(0.01)
        time.sleep(0.08)

        assert sender.lifecycle_repreparations == [GROUP]
        assert adapter.status_thread.is_alive()
        assert adapter.last_status["canSend"] is False
        assert adapter.last_status["reason"] == "sender_recovery_required"
        logs = [frame["params"] for frame in map(json.loads, stream.getvalue().splitlines())
                if frame.get("method") == "event/log"]
        assert any("watched target binding mismatch" in item["message"] for item in logs)
    finally:
        adapter.on_shutdown({})


def test_detached_prepare_failure_is_logged_then_uses_legacy_send_availability(tmp_path):
    sender = PreparingSender()
    adapter, _, stream = setup_adapter(tmp_path, sender)
    try:
        adapter.on_watch_set({"chatIds": [GROUP]})
        sender.finish_preparation(failed=True)
        frames = [json.loads(line) for line in stream.getvalue().splitlines()]
        logs = [frame["params"] for frame in frames if frame.get("method") == "event/log"]
        statuses = [frame["params"] for frame in frames if frame.get("method") == "event/status"]
        assert any("独立窗口准备失败" in item["message"] for item in logs)
        assert any(item["canSend"] is False for item in statuses)
        assert statuses[-1]["canSend"] is True
        assert adapter.on_message_send({"chatId": GROUP, "clientId": "failed-prep", "content": {"kind": "text", "text": "仍走旧sender"}}) == {
            "messageId": "9912345678901234567",
        }
        assert len(sender.calls) == 1
        assert (tmp_path / "wechat-db" / "delivery.jsonl").exists()
    finally:
        adapter.on_shutdown({})

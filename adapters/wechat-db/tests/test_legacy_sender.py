"""Contract tests for the opt-in old-worker transport, using a fake child."""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wechat_db.rpc import ProtocolError  # noqa: E402
from wechat_db.legacy_sender import LegacySender  # noqa: E402


BOT = "wxid_test_bot"
GROUP = "test_group@chatroom"
DESKTOP = "DshWeChatBot_Test"


def _worker_config(tmp_path: Path) -> dict:
    return {
        "dbRoot": str(tmp_path / "db"),
        "stateRoot": str(tmp_path / "state"),
        "keyCacheFile": str(tmp_path / "key-cache.json"),
        "botWxid": BOT,
        "botName": "Test Bot",
        "targetWxid": GROUP,
        "targetName": "Test Group",
        "expectedExe": str(tmp_path / "WeChat.exe"),
        "expectedVersion": "test-version",
        "mainWindowClass": "TestWindow",
        "mainWindowTitle": "Test Window",
        "gateModule": str(tmp_path / "Weixin.dll"),
        "gateRva": "0x1234",
        "gateTimeoutSeconds": 5,
        "gateExpectedOriginalByte": 144,
        "gateEnabledByte": 204,
        "conversationType": "group",
        "desktopName": DESKTOP,
    }


def _sender_file(tmp_path: Path, mode: str = "confirmed", *, detached_window: bool = False) -> tuple[Path, Path]:
    trace = tmp_path / "fake-worker.jsonl"
    config_path = tmp_path / "sender.json"
    config = {
        "command": sys.executable,
        "args": [str(Path(__file__).resolve()), "--fake-worker", mode, str(trace)],
        "worker": _worker_config(tmp_path),
    }
    if detached_window:
        config["detachedWindow"] = True
    config_path.write_text(json.dumps(config), encoding="utf-8")
    return config_path, trace


def _read_trace(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


_DETACHED_BINDING = {
    "hwnd": 5970638,
    "pid": 113128,
    "processStartedAt": 1792634000.5,
    "mainWindowClass": "Qt51514QWindowIcon",
    "mainWindowTitle": "Test Group^",
}


def _install_fake_preparer(monkeypatch, *, blocked=False, fail_first=False, raise_first=False, ignore_cancel=False):
    import threading
    import types

    instances = []

    class FakePreparer:
        def __init__(self, command, args, worker, self_id):
            self.command = command
            self.args = list(args)
            self.worker = dict(worker)
            self.self_id = self_id
            self.worker_config = dict(worker)
            self.worker_config["mainWindowClass"] = _DETACHED_BINDING["mainWindowClass"]
            self.worker_config["mainWindowTitle"] = _DETACHED_BINDING["mainWindowTitle"]
            self.started = threading.Event()
            self.release = threading.Event()
            self.should_block = blocked
            self.ignore_cancel = ignore_cancel
            self.fail = fail_first and not instances
            self.raise_error = raise_first and not instances
            self.closed = False
            self.worker_args = self.args
            self.result = {
                "opened": True,
                "binding": dict(_DETACHED_BINDING),
                "reused": False,
                "gateActive": False,
                "gateRestored": True,
            }
            instances.append(self)

        def prepare(self, cancel_event):
            self.started.set()
            if self.should_block:
                while not self.release.wait(0.01):
                    if cancel_event.is_set() and not self.ignore_cancel:
                        return dict(self.result, opened=False)
            if self.raise_error:
                raise RuntimeError("simulated prepare failure with unknown gate state")
            if self.fail:
                return dict(self.result, opened=False)
            return dict(self.result)

        def close(self):
            self.closed = True
            return True

    monkeypatch.setitem(sys.modules, "wechat_db.detached_window", types.SimpleNamespace(
        DetachedWindowPreparer=FakePreparer,
    ))
    return instances


def _wait_until(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return bool(predicate())


class _BoundProbeChild:
    def __init__(self, binding, target_id=GROUP):
        self.binding = dict(binding)
        self.target_id = target_id
        self.process = object()
        self.methods = []
        self.configs = []

    def start(self):
        pass

    def request(self, method, params, _timeout):
        self.methods.append(method)
        if method in ("probe", "send"):
            self.configs.append(dict(params["config"]))
        if method == "probe":
            return {"result": {"selfId": BOT, "targetId": self.target_id, "binding": self.binding}}
        if method == "send":
            text = params["text"]
            return {"result": {
                "status": "confirmed",
                "outgoing": {
                    "target": self.target_id, "senderId": BOT, "text": text,
                    "serverId": "9001", "localId": 1, "sortSeq": 2,
                    "shard": "fake-shard",
                },
                "sendAttempted": True, "gateActive": False, "gateRestored": True,
            }}
        raise AssertionError(f"unexpected request: {method}")

    def close_normally(self, _timeout):
        self.methods.append("close")
        return True


def test_detached_sender_preparation_routes_send_to_prepared_native_window(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as module

    config_path, _trace = _sender_file(tmp_path, detached_window=True)
    preparers = _install_fake_preparer(monkeypatch, blocked=True)
    child = _BoundProbeChild(_DETACHED_BINDING)
    child_args = []
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    monkeypatch.setattr(module, "_JsonlChild", lambda _command, args: child_args.append(list(args)) or child)
    sender = LegacySender.from_file(config_path, BOT)
    state_changes = []
    sender.set_state_callback(lambda level, message: state_changes.append((level, message)))

    assert sender.available() is False
    with pytest.raises(ProtocolError) as unbound:
        sender.send(GROUP, {"kind": "text", "text": "before watch"}, "client-unbound")
    assert unbound.value.code == "unavailable"
    assert "nothing was sent" in str(unbound.value)
    assert child_args == []

    sender.prepare_target(GROUP)
    assert preparers[0].started.wait(1)
    assert sender.available() is False, "a running window preparation must never enable delivery"
    with pytest.raises(ProtocolError) as error:
        sender.send(GROUP, {"kind": "text", "text": "during preparation"}, "client-preparing")
    assert error.value.code == "unavailable"
    preparers[0].release.set()
    assert _wait_until(sender.available), "the old sender should be available after preparation completes"

    assert sender.send(GROUP, {"kind": "text", "text": "detached"}, "client-detached") == "9001"
    expected_args = [
        str(Path(module.__file__).with_name("native_window_worker.py")),
        "--legacy-root",
        str(Path(sender._args[0]).parent),
    ]
    expected_config = dict(sender._worker)
    expected_config["mainWindowClass"] = _DETACHED_BINDING["mainWindowClass"]
    expected_config["mainWindowTitle"] = _DETACHED_BINDING["mainWindowTitle"]
    assert child_args == [expected_args]
    assert child.methods == ["probe", "send", "close"]
    assert child.configs == [expected_config, expected_config]
    assert state_changes[-1] == ("info", "已打开微信独立窗口：Test Group")
    sender.close()
    assert preparers[0].closed


def test_detached_send_uses_prepared_binding_without_full_probe_binding_comparison(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as module

    config_path, _trace = _sender_file(tmp_path, detached_window=True)
    preparers = _install_fake_preparer(monkeypatch)
    # The native worker may report runtime binding details different from the
    # preparation snapshot. Only the existing self/target probe checks apply.
    child = _BoundProbeChild(dict(_DETACHED_BINDING, hwnd=1234, mainWindowTitle="Other^"))
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    monkeypatch.setattr(module, "_JsonlChild", lambda _command, _args: child)
    sender = LegacySender.from_file(config_path, BOT)
    sender.prepare_target(GROUP)
    assert _wait_until(sender.available)

    assert sender.send(GROUP, {"kind": "text", "text": "prepared path"}, "client-window-opened") == "9001"
    assert child.methods == ["probe", "send", "close"]
    expected_config = dict(sender._worker)
    expected_config["mainWindowClass"] = _DETACHED_BINDING["mainWindowClass"]
    expected_config["mainWindowTitle"] = _DETACHED_BINDING["mainWindowTitle"]
    assert child.configs == [expected_config, expected_config]
    assert sender.available() is True
    sender.close()
    assert preparers[0].closed


def test_select_target_updates_legacy_worker_and_rebuilds_preparer_for_one_chat(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as module

    friend = "wxid_friend"
    config_path, _trace = _sender_file(tmp_path, detached_window=True)
    preparers = _install_fake_preparer(monkeypatch)
    child = _BoundProbeChild(_DETACHED_BINDING, target_id=friend)
    child_args = []
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    monkeypatch.setattr(module, "_JsonlChild", lambda _command, args: child_args.append(list(args)) or child)
    sender = LegacySender.from_file(config_path, BOT)

    chat = {"id": friend, "name": "老朋友", "kind": "direct"}
    assert sender.select_target(chat) is True
    assert sender.target_id == friend
    assert preparers[0].closed, "switching must release the previous generation before selecting"
    assert sender.select_target(chat) is False, "reselecting the same target must not repeat UI side effects"
    assert sender.available() is False, "switching must clear the previous prepared send route"
    with pytest.raises(ProtocolError) as unprepared:
        sender.send(friend, {"kind": "text", "text": "before prepare"}, "client-unprepared-target")
    assert unprepared.value.code == "unavailable"
    assert child_args == []

    sender.prepare_target(friend)
    assert _wait_until(sender.available)
    assert len(preparers) == 2
    assert preparers[1].worker["targetWxid"] == friend
    assert preparers[1].worker["targetName"] == "老朋友"
    assert preparers[1].worker["conversationType"] == "direct"
    assert sender.send(friend, {"kind": "text", "text": "当前私聊"}, "client-dynamic-target") == "9001"
    expected_args = [
        str(Path(module.__file__).with_name("native_window_worker.py")),
        "--legacy-root",
        str(Path(sender._args[0]).parent),
    ]
    expected_config = dict(sender._worker)
    expected_config["mainWindowClass"] = _DETACHED_BINDING["mainWindowClass"]
    expected_config["mainWindowTitle"] = _DETACHED_BINDING["mainWindowTitle"]
    assert child_args == [expected_args]
    assert child.configs == [expected_config, expected_config]
    sender.close()
    assert all(preparer.closed for preparer in preparers)


def test_detached_prepare_reports_selected_group_name_from_its_generation(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as module

    group_id = "test_triangle@chatroom"
    config_path, _trace = _sender_file(tmp_path, detached_window=True)
    preparers = _install_fake_preparer(monkeypatch)
    child = _BoundProbeChild(_DETACHED_BINDING, target_id=group_id)
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    monkeypatch.setattr(module, "_JsonlChild", lambda _command, _args: child)
    sender = LegacySender.from_file(config_path, BOT)
    state_changes = []
    sender.set_state_callback(lambda level, message: state_changes.append((level, message)))

    sender.select_target({"id": group_id, "name": "△", "kind": "group"})
    sender.prepare_target(group_id)

    assert _wait_until(sender.available)
    assert state_changes[-1] == ("info", "已打开微信独立窗口：△")
    assert preparers[-1].worker["targetName"] == "△"
    sender.close()


def test_clearing_watch_invalidates_prepared_send_route(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as module

    config_path, _trace = _sender_file(tmp_path, detached_window=True)
    preparers = _install_fake_preparer(monkeypatch)
    child_args = []
    child = _BoundProbeChild(_DETACHED_BINDING)
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    monkeypatch.setattr(module, "_JsonlChild", lambda _command, args: child_args.append(list(args)) or child)
    sender = LegacySender.from_file(config_path, BOT)

    sender.prepare_target(GROUP)
    assert _wait_until(sender.available)
    assert sender.invalidate_target() is True
    assert sender.available() is False
    with pytest.raises(ProtocolError) as error:
        sender.send(GROUP, {"kind": "text", "text": "after watch clear"}, "client-watch-clear")
    assert error.value.code == "unavailable"
    assert "nothing was sent" in str(error.value)
    assert child_args == []
    sender.close()
    assert preparers[0].closed


def test_known_detached_ui_failure_is_logged_and_not_retried_until_watch_is_cleared(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as module

    config_path, _trace = _sender_file(tmp_path, detached_window=True)
    preparers = _install_fake_preparer(monkeypatch, fail_first=True)
    child = _BoundProbeChild(_DETACHED_BINDING)
    child_args = []
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    monkeypatch.setattr(module, "_JsonlChild", lambda _command, args: child_args.append(list(args)) or child)
    sender = LegacySender.from_file(config_path, BOT)
    state_changes = []
    sender.set_state_callback(lambda level, message: state_changes.append((level, message)))

    sender.prepare_target(GROUP)
    assert _wait_until(lambda: sender.preparation_error is not None)
    assert sender.available() is False, "a clean preparation failure must not enable main-window sends"
    with pytest.raises(ProtocolError) as send_error:
        sender.send(GROUP, {"kind": "text", "text": "must not fall back"}, "client-prepare-failed")
    assert send_error.value.code == "unavailable"
    assert "nothing was sent" in str(send_error.value)
    assert child_args == []
    sender.prepare_target(GROUP)
    time.sleep(0.05)
    assert len(preparers) == 1, "repeated watch/set must not replay native UI side effects"
    assert state_changes[-1][0] == "warn"

    assert sender.invalidate_target() is True
    assert sender.available() is False
    sender.prepare_target(GROUP)
    assert _wait_until(sender.available)
    assert len(preparers) == 2
    assert sender.send(GROUP, {"kind": "text", "text": "prepared retry"}, "client-prepare-retry") == "9001"
    assert len(child_args) == 1
    sender.close()
    assert all(preparer.closed for preparer in preparers)


def test_unknown_preparation_gate_state_keeps_legacy_sender_fail_closed(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as module

    config_path, trace = _sender_file(tmp_path, detached_window=True)
    preparers = _install_fake_preparer(monkeypatch, raise_first=True)
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    sender = LegacySender.from_file(config_path, BOT)

    sender.prepare_target(GROUP)

    assert _wait_until(lambda: sender.preparation_error is not None)
    assert sender.available() is False, "an exception leaves gate state unconfirmed"
    assert sender.recovery_required is True
    with pytest.raises(ProtocolError) as send_error:
        sender.send(GROUP, {"kind": "text", "text": "must stay disabled"}, "client-unknown-gate")
    assert send_error.value.code == "unavailable"
    assert _read_trace(trace) == []
    assert preparers[0].closed
    with pytest.raises(ProtocolError) as error:
        sender.close()
    assert error.value.code == "unavailable"


def test_detached_sender_close_cancels_inflight_prepare_and_closes_backend(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as module

    config_path, _trace = _sender_file(tmp_path, detached_window=True)
    preparers = _install_fake_preparer(monkeypatch, blocked=True)
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    sender = LegacySender.from_file(config_path, BOT)
    sender.prepare_target(GROUP)
    assert preparers[0].started.wait(1)

    sender.close()

    assert preparers[0].closed
    assert sender.available() is False


def test_detached_sender_shutdown_closes_preparer_even_before_first_watch(tmp_path, monkeypatch):
    config_path, _trace = _sender_file(tmp_path, detached_window=True)
    preparers = _install_fake_preparer(monkeypatch)
    sender = LegacySender.from_file(config_path, BOT)

    sender.close()

    assert preparers[0].closed


def test_detached_prepare_thread_start_failure_closes_unstarted_preparer(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as module

    config_path, _trace = _sender_file(tmp_path, detached_window=True)
    preparers = _install_fake_preparer(monkeypatch)
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    sender = LegacySender.from_file(config_path, BOT)
    original_start = module.threading.Thread.start

    def fail_prepare_start(thread):
        if thread.name == "wechat-detached-window-prepare":
            raise RuntimeError("simulated thread start failure")
        return original_start(thread)

    monkeypatch.setattr(module.threading.Thread, "start", fail_prepare_start)
    sender.prepare_target(GROUP)

    assert sender.preparation_error is not None
    assert sender.available() is False
    with pytest.raises(ProtocolError) as error:
        sender.send(GROUP, {"kind": "text", "text": "thread start failed"}, "client-prepare-start-failed")
    assert error.value.code == "unavailable"
    assert preparers[0].closed
    sender.close()


def test_detached_sender_cleanup_timeout_keeps_sender_closed_to_delivery_until_retry(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as module

    config_path, _trace = _sender_file(tmp_path, detached_window=True)
    preparers = _install_fake_preparer(
        monkeypatch, blocked=True, ignore_cancel=True,
    )
    monkeypatch.setattr(module, "_PREPARE_CLOSE_WAIT_S", 0.01)
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    sender = LegacySender.from_file(config_path, BOT)
    sender.prepare_target(GROUP)
    assert preparers[0].started.wait(1)

    with pytest.raises(ProtocolError) as error:
        sender.close()

    assert error.value.code == "unavailable"
    assert sender.available() is False
    preparers[0].release.set()
    assert _wait_until(lambda: preparers[0].closed)
    sender.close()


@pytest.mark.parametrize(
    "result",
    [
        {"opened": False, "binding": dict(_DETACHED_BINDING), "gateActive": False, "gateRestored": True},
        {"opened": True, "binding": dict(_DETACHED_BINDING), "gateActive": True, "gateRestored": True},
        {"opened": True, "binding": dict(_DETACHED_BINDING), "gateActive": False, "gateRestored": False},
        {"opened": True, "gateActive": False, "gateRestored": True},
    ],
)
def test_detached_preparation_requires_opened_window_and_restored_gate(tmp_path, monkeypatch, result):
    import wechat_db.legacy_sender as module

    config_path, _trace = _sender_file(tmp_path, detached_window=True)
    preparers = _install_fake_preparer(monkeypatch)
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    sender = LegacySender.from_file(config_path, BOT)
    preparers[0].result = result

    sender.prepare_target(GROUP)

    assert _wait_until(lambda: sender.preparation_error is not None)
    assert preparers[0].closed
    gate_unknown = result.get("gateRestored") is not True or result.get("gateActive") is not False
    assert sender.available() is False
    if gate_unknown:
        with pytest.raises(ProtocolError) as error:
            sender.close()
        assert error.value.code == "unavailable"
    else:
        sender.close()


def test_detached_window_option_must_be_a_boolean(tmp_path):
    config_path, _trace = _sender_file(tmp_path)
    config = json.loads(config_path.read_text(encoding="utf-8"))
    config["detachedWindow"] = "true"
    config_path.write_text(json.dumps(config), encoding="utf-8")

    with pytest.raises(ValueError, match="detachedWindow"):
        LegacySender.from_file(config_path, BOT)


def test_available_checks_desktop_without_starting_worker(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as module

    config_path, trace = _sender_file(tmp_path)
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    sender = LegacySender.from_file(config_path, BOT)

    assert sender.target_id == GROUP
    assert sender.available() is True
    assert _read_trace(trace) == []
    sender.close()


@pytest.mark.parametrize("change", ["missing_desktop", "default_desktop", "wrong_self", "empty_target"])
def test_from_file_rejects_unbound_or_default_desktop_config(tmp_path, change):
    config_path, _ = _sender_file(tmp_path)
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    if change == "missing_desktop":
        raw["worker"].pop("desktopName")
    elif change == "default_desktop":
        raw["worker"]["desktopName"] = "Default"
    elif change == "wrong_self":
        raw["worker"]["botWxid"] = "wxid_other"
    else:
        raw["worker"]["targetWxid"] = ""
    config_path.write_text(json.dumps(raw), encoding="utf-8")

    with pytest.raises((ValueError, ProtocolError)):
        LegacySender.from_file(config_path, BOT)


@pytest.mark.parametrize(
    ("chat_id", "content", "code"),
    [
        ("other_group@chatroom", {"kind": "text", "text": "hello"}, "invalid_params"),
        (GROUP, {"kind": "image", "path": "C:/not-used.png"}, "unsupported"),
        (GROUP, {"kind": "text", "text": "hello", "mentions": ["wxid_x"]}, "unsupported"),
        (GROUP, {"kind": "text", "text": ""}, "invalid_params"),
    ],
)
def test_rejected_send_input_never_starts_worker(tmp_path, chat_id, content, code):
    config_path, trace = _sender_file(tmp_path)
    sender = LegacySender.from_file(config_path, BOT)

    with pytest.raises(ProtocolError) as error:
        sender.send(chat_id, content, "client-1")

    assert error.value.code == code
    assert _read_trace(trace) == []
    sender.close()


def test_unsupported_content_does_not_change_desktop_availability(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as module

    config_path, trace = _sender_file(tmp_path)
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    sender = LegacySender.from_file(config_path, BOT)

    with pytest.raises(ProtocolError) as error:
        sender.send(GROUP, {"kind": "image", "path": "C:/not-used.png"}, "client-unsupported")

    assert error.value.code == "unsupported"
    assert sender.available() is True
    assert _read_trace(trace) == []
    sender.close()


def test_confirmed_send_checks_scope_and_gate_then_closes_worker(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as module

    config_path, trace = _sender_file(tmp_path)
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    sender = LegacySender.from_file(config_path, BOT)
    text = chr(0x4f60) + chr(0x597d) + chr(0xff0c) + "worker"

    message_id = sender.send(GROUP, {"kind": "text", "text": text}, "client-1")

    assert message_id == "9001"
    frames = _read_trace(trace)
    assert [frame["method"] for frame in frames] == ["probe", "send", "close"]
    send_params = frames[1]["params"]
    assert send_params["hostAttemptPersisted"] is True
    assert send_params["enableSend"] is True
    assert send_params["allowTemporaryGate"] is True
    assert send_params["attemptId"] == "client-1"
    assert send_params["target"] == GROUP
    assert send_params["expectedSelfId"] == BOT
    assert send_params["text"] == text
    assert frames[1]["stdoutEncoding"].lower().replace("_", "-") == "utf-8"
    assert sender.available() is True
    sender.close()


def test_slow_probe_fits_bounded_budget_and_preserves_send_and_close_reserves(tmp_path, monkeypatch):
    import types
    import wechat_db.legacy_sender as module

    class Clock:
        now = 0.0

        def monotonic(self):
            return self.now

        def advance(self, seconds):
            self.now += seconds

    clock = Clock()

    class SimulatedChild:
        def __init__(self, _command, _args):
            self.process = object()
            self.timeouts = {}

        def start(self):
            clock.advance(5.0)  # Include bounded worker startup in the hard deadline.

        def request(self, method, _params, timeout):
            self.timeouts[method] = timeout
            if method == "probe":
                clock.advance(13.875)  # Reproduce the measured account-selection probe.
                return {"result": {"selfId": BOT, "targetId": GROUP}}
            if method == "send":
                clock.advance(45.0)  # Consume the full reserved send allowance.
                return {"result": {
                    "status": "confirmed",
                    "outgoing": {
                        "target": GROUP, "senderId": BOT, "text": "hello",
                        "serverId": "9001", "localId": 1, "sortSeq": 2,
                        "shard": "fake-shard",
                    },
                    "sendAttempted": True, "gateActive": False, "gateRestored": True,
                }}
            raise AssertionError(f"unexpected request: {method}")

        def close_normally(self, timeout):
            self.timeouts["close"] = timeout
            clock.advance(timeout)
            return True

    config_path, _trace = _sender_file(tmp_path)
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    monkeypatch.setattr(module, "time", types.SimpleNamespace(monotonic=clock.monotonic))
    child = SimulatedChild("unused", [])
    monkeypatch.setattr(module, "_JsonlChild", lambda _command, _args: child)
    sender = LegacySender.from_file(config_path, BOT)

    assert sender.send(GROUP, {"kind": "text", "text": "hello"}, "client-slow-probe") == "9001"

    assert child.timeouts["probe"] >= 13.875
    assert child.timeouts["probe"] <= 30.0
    assert child.timeouts["send"] == 45.0
    assert child.timeouts["close"] == 5.0
    assert clock.now <= 80.0
    assert sender.recovery_required is False
    sender.close()


@pytest.mark.parametrize("mode", ["probe_error", "probe_mismatch", "probe_bad_frame"])
def test_probe_rejection_is_definitely_not_sent_after_normal_close(tmp_path, monkeypatch, mode):
    import wechat_db.legacy_sender as module

    config_path, trace = _sender_file(tmp_path, mode)
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    sender = LegacySender.from_file(config_path, BOT)

    with pytest.raises(ProtocolError) as error:
        sender.send(GROUP, {"kind": "text", "text": "hello"}, f"client-{mode}")

    assert error.value.code == "send_failed"
    assert [frame["method"] for frame in _read_trace(trace)] == ["probe", "close"]
    assert sender.recovery_required is False
    sender.close()


@pytest.mark.parametrize(
    ("mode", "code", "message_fragment"),
    [
        ("blocked", "unavailable", "desktop became unavailable"),
        ("not_attempted", "send_failed", "gate_preflight"),
        ("not_attempted_bad_reason", "send_failed", "send was not attempted"),
    ],
)
def test_only_explicit_no_send_receipts_are_retryable(tmp_path, monkeypatch, mode, code, message_fragment):
    import wechat_db.legacy_sender as module

    config_path, trace = _sender_file(tmp_path, mode)
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    sender = LegacySender.from_file(config_path, BOT)

    with pytest.raises(ProtocolError) as error:
        sender.send(GROUP, {"kind": "text", "text": "hello"}, "client-2")

    assert error.value.code == code
    assert message_fragment in str(error.value)
    if mode == "not_attempted_bad_reason":
        assert "uia_draft;secret" not in str(error.value)
    assert [frame["method"] for frame in _read_trace(trace)] == ["probe", "send", "close"]
    sender.close()


@pytest.mark.parametrize("mode", ["wrong_receipt", "worker_error"])
def test_unproven_send_outcome_is_uncertain(tmp_path, monkeypatch, mode):
    import wechat_db.legacy_sender as module

    config_path, trace = _sender_file(tmp_path, mode)
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    sender = LegacySender.from_file(config_path, BOT)

    with pytest.raises(ProtocolError) as error:
        sender.send(GROUP, {"kind": "text", "text": "hello"}, "client-3")

    assert error.value.code == "send_uncertain"
    assert [frame["method"] for frame in _read_trace(trace)] == ["probe", "send", "close"]
    sender.close()


def test_worker_preflight_error_without_confirmed_close_is_not_send_failed(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as module

    config_path, trace = _sender_file(tmp_path, "safe_error_close_fail")
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    sender = LegacySender.from_file(config_path, BOT)

    with pytest.raises(ProtocolError) as error:
        sender.send(GROUP, {"kind": "text", "text": "hello"}, "client-5")

    assert error.value.code == "send_uncertain"
    assert [frame["method"] for frame in _read_trace(trace)] == ["probe", "send", "close"]
    assert sender.available() is False
    assert sender.recovery_required is True
    with pytest.raises(ProtocolError):
        sender.close()


@pytest.mark.parametrize("mode", ["hang", "bad_frame"])
def test_hung_or_malformed_send_response_is_uncertain_and_normally_closes(tmp_path, monkeypatch, mode):
    import wechat_db.legacy_sender as module

    config_path, trace = _sender_file(tmp_path, mode)
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    monkeypatch.setattr(module, "_SEND_MAX_S", 0.05)
    sender = LegacySender.from_file(config_path, BOT)

    with pytest.raises(ProtocolError) as error:
        sender.send(GROUP, {"kind": "text", "text": "hello"}, f"client-{mode}")

    assert error.value.code == "send_uncertain"
    assert [frame["method"] for frame in _read_trace(trace)] == ["probe", "send", "close"]
    assert sender.recovery_required is False
    sender.close()


def test_blocked_stdin_write_has_a_deadline_and_keeps_recovery_required(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as module

    config_path, _ = _sender_file(tmp_path, "never_read_then_exit")
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    raw["worker"]["largeTestOnlyValue"] = "x" * (2 * 1024 * 1024)
    config_path.write_text(json.dumps(raw), encoding="utf-8")
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    monkeypatch.setattr(module, "_TOTAL_DEADLINE_S", 0.3)
    monkeypatch.setattr(module, "_PROBE_MAX_S", 0.05)
    monkeypatch.setattr(module, "_SEND_MAX_S", 0.05)
    monkeypatch.setattr(module, "_CLOSE_MAX_S", 0.1)
    sender = LegacySender.from_file(config_path, BOT)

    started = time.monotonic()
    with pytest.raises(ProtocolError) as error:
        sender.send(GROUP, {"kind": "text", "text": "hello"}, "client-blocked-write")
    elapsed = time.monotonic() - started

    assert error.value.code == "unavailable"
    assert elapsed < 0.8
    assert sender.recovery_required is True
    child = sender._child
    assert child is not None and child.process is not None
    with pytest.raises(ProtocolError):
        sender.close()
    child.process.wait(timeout=4)


def test_confirmed_receipt_is_returned_but_exited_worker_without_close_ack_stays_unsafe(tmp_path, monkeypatch):
    import wechat_db.legacy_sender as module

    config_path, trace = _sender_file(tmp_path, "close_fail_exit")
    monkeypatch.setattr(module, "_desktop_available", lambda: True)
    sender = LegacySender.from_file(config_path, BOT)

    assert sender.send(GROUP, {"kind": "text", "text": "hello"}, "client-4") == "9001"
    assert sender.available() is False
    assert [frame["method"] for frame in _read_trace(trace)] == ["probe", "send", "close"]
    child = sender._child
    assert child is not None and child.process is not None
    child.process.wait(timeout=2)
    with pytest.raises(ProtocolError) as error:
        sender.close()
    assert error.value.code == "unavailable"
    assert sender.recovery_required is True


def _fake_worker_main() -> None:
    import time

    mode = sys.argv[sys.argv.index("--fake-worker") + 1]
    trace_path = Path(sys.argv[sys.argv.index("--fake-worker") + 2])
    if mode == "never_read_then_exit":
        time.sleep(1.5)
        return
    for raw in sys.stdin:
        request = json.loads(raw)
        method, params = request["method"], request["params"]
        with trace_path.open("a", encoding="utf-8") as trace:
            trace.write(json.dumps({
                "method": method, "params": params, "stdoutEncoding": sys.stdout.encoding,
            }, ensure_ascii=False) + "\n")
        if method == "probe":
            result = {"selfId": params["config"]["botWxid"], "targetId": params["config"]["targetWxid"]}
            if mode == "probe_mismatch":
                result["targetId"] = "different_group@chatroom"
            if mode == "probe_error":
                response = {"id": request["id"], "error": {"code": "invalid_config"}}
            elif mode == "probe_bad_frame":
                sys.stdout.write("not-json\n")
                sys.stdout.flush()
                continue
            else:
                response = {"id": request["id"], "result": result}
        elif method == "send" and mode in ("worker_error", "safe_error_close_fail"):
            code = "scope_violation" if mode == "safe_error_close_fail" else "worker_error"
            response = {"id": request["id"], "error": {"code": code, "message": "redacted"}}
        elif method == "send" and mode == "hang":
            continue
        elif method == "send" and mode == "bad_frame":
            sys.stdout.write("not-json\n")
            sys.stdout.flush()
            continue
        elif method == "send":
            outgoing = {
                "target": params["target"],
                "senderId": params["expectedSelfId"],
                "text": params["text"],
                "serverId": "9001",
                "localId": 1,
                "sortSeq": 2,
                "shard": "fake-shard",
            }
            if mode == "wrong_receipt":
                outgoing["target"] = "other_group@chatroom"
            result = {
                "status": "confirmed",
                "outgoing": outgoing,
                "sendAttempted": True,
                "gateActive": False,
                "gateRestored": True,
            }
            if mode == "blocked":
                result = {
                    "status": "blocked",
                    "reasonCode": "desktop_unavailable",
                    "outgoing": None,
                    "sendAttempted": False,
                    "gateActive": False,
                    "gateRestored": True,
                }
            elif mode in ("not_attempted", "not_attempted_bad_reason"):
                result = {
                    "status": "ambiguous",
                    "reasonCode": ("gate_preflight" if mode == "not_attempted"
                                   else "uia_draft;secret"),
                    "outgoing": None,
                    "sendAttempted": False,
                    "gateActive": False,
                    "gateRestored": True,
                }
            response = {"id": request["id"], "result": result}
        elif method == "close":
            result = {"closed": True, "gateActive": False, "gateRestored": True}
            if mode in ("close_fail", "close_fail_exit", "safe_error_close_fail"):
                result = {"closed": False, "gateActive": True, "gateRestored": False}
            response = {"id": request["id"], "result": result}
        else:
            response = {"id": request["id"], "error": {"code": "unknown_method"}}
        sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
        sys.stdout.flush()
        if method == "close" and mode == "close_fail_exit":
            return


if __name__ == "__main__" and "--fake-worker" in sys.argv:
    _fake_worker_main()

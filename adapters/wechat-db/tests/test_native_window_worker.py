"""Detached-window worker contracts without starting WeChat or Win32 UI."""
from __future__ import annotations

import sys
import threading
import uuid
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from wechat_db.native_window_worker import (  # noqa: E402
    NativeWindowError,
    NativeWindowRuntime,
    _response_for_request,
    require_default_monitor_lease,
    run_watchdog_on_desktop,
    validate_prepared_window_binding,
)


TARGET = "测试联系人^"
DESKTOP = "DshWeChatBot_Test"


def _binding(*, hwnd: int = 5970638, title: str = TARGET) -> dict:
    return {
        "hwnd": hwnd,
        "pid": 113128,
        "processStartedAt": 1792634000.5,
        "mainWindowClass": "Qt51514QWindowIcon",
        "mainWindowTitle": title,
        "exePath": r"C:\Program Files\Tencent\Weixin\Weixin.exe",
        "version": "4.1.0.30",
        "modulePath": r"C:\Program Files\Tencent\Weixin\Weixin.dll",
        "moduleBase": 0x10000000,
        "moduleSize": 0x200000,
        "accountName": "wxid_test_bot",
        "accountPath": r"C:\Users\test\Documents\xwechat_files\wxid_test_bot",
    }


def _primary_binding() -> dict:
    return _binding(hwnd=515151, title="测试机器人")


def _config() -> dict:
    return {
        "botWxid": "wxid_test_bot",
        "targetWxid": "wxid_test_peer",
        "targetName": TARGET,
        "mainWindowClass": "Qt51514QWindowIcon",
        "mainWindowTitle": "测试机器人",
        "desktopName": DESKTOP,
    }


def _cancel_path(config: dict, *, name: str | None = None) -> str:
    marker_name = name or f"{uuid.uuid4().hex}.cancel"
    return str(Path(config["stateRoot"]) / "window-preparations" / marker_name)


def test_prepared_binding_is_a_different_window_in_the_same_account_process():
    config = _config()
    actual = _binding()

    assert validate_prepared_window_binding(config, _primary_binding(), actual) is actual

    wrong_process = _binding()
    wrong_process["pid"] += 1
    with pytest.raises(NativeWindowError):
        validate_prepared_window_binding(config, _primary_binding(), wrong_process)

    wrong_title = _binding(title="其他会话")
    with pytest.raises(NativeWindowError):
        validate_prepared_window_binding(config, _primary_binding(), wrong_title)

    same_window = _binding(hwnd=_primary_binding()["hwnd"])
    with pytest.raises(NativeWindowError):
        validate_prepared_window_binding(config, _primary_binding(), same_window)


def test_watchdog_attaches_its_current_thread_before_running_legacy_recovery(tmp_path):
    main_thread_id = threading.get_ident()
    legacy_root = tmp_path / "legacy"
    package = legacy_root / "dsh_wechat_bridge"
    package.mkdir(parents=True)
    (legacy_root / "worker.py").write_text("", encoding="utf-8")
    (package / "gate.py").write_text("", encoding="utf-8")
    events: list[tuple[str, int]] = []
    result: list[int] = []

    class FakeDesktopApi:
        def open_desktop(self, name):
            events.append((f"open:{name}", threading.get_ident()))
            return object()

        def set_thread_desktop(self, handle):
            events.append(("set-thread-desktop", threading.get_ident()))
            return True

        def close_desktop(self, handle):
            events.append(("close-desktop", threading.get_ident()))
            return True

    def watchdog_main(lease_path):
        events.append((f"watchdog:{lease_path}", threading.get_ident()))
        return 17

    thread = threading.Thread(
        target=lambda: result.append(run_watchdog_on_desktop(
            legacy_root,
            DESKTOP,
            tmp_path / "gate-lease.json",
            desktop_api_factory=FakeDesktopApi,
            watchdog_main=watchdog_main,
        )),
        name="fake-watchdog-desktop-thread",
    )
    thread.start()
    thread.join(timeout=2)

    assert not thread.is_alive()
    assert result == [17]
    assert [name for name, _thread in events] == [
        f"open:{DESKTOP}", "set-thread-desktop", f"watchdog:{tmp_path / 'gate-lease.json'}"
    ]
    assert all(thread_id != main_thread_id for _name, thread_id in events)
    assert len({thread_id for _name, thread_id in events}) == 1


def test_watchdog_does_not_run_recovery_when_thread_desktop_attachment_fails(tmp_path):
    events: list[str] = []
    legacy_root = tmp_path / "legacy"
    package = legacy_root / "dsh_wechat_bridge"
    package.mkdir(parents=True)
    (legacy_root / "worker.py").write_text("", encoding="utf-8")
    (package / "gate.py").write_text("", encoding="utf-8")

    class FakeDesktopApi:
        def open_desktop(self, _name):
            events.append("open")
            return object()

        def set_thread_desktop(self, _handle):
            events.append("set-thread-desktop")
            return False

        def close_desktop(self, _handle):
            events.append("close-unattached-handle")
            return True

    with pytest.raises(NativeWindowError):
        run_watchdog_on_desktop(
            legacy_root,
            DESKTOP,
            tmp_path / "gate-lease.json",
            desktop_api_factory=FakeDesktopApi,
            watchdog_main=lambda _path: events.append("watchdog"),
        )

    assert events == ["open", "set-thread-desktop", "close-unattached-handle"]


def test_watchdog_failure_writes_redacted_diagnostic_outside_gate_lease_directory(tmp_path):
    import wechat_db.native_window_worker as native_worker

    legacy_root = tmp_path / "legacy"
    package = legacy_root / "dsh_wechat_bridge"
    package.mkdir(parents=True)
    (legacy_root / "worker.py").write_text("", encoding="utf-8")
    (package / "gate.py").write_text("", encoding="utf-8")
    state_root = tmp_path / "state"
    lease_path = state_root / "gate-leases" / "lease-123.json"
    lease_path.parent.mkdir(parents=True)
    lease_path.write_text(json.dumps({"originalByte": 7, "enabledByte": 8}), encoding="utf-8")

    class ProcessBindingError(RuntimeError):
        pass

    ProcessBindingError.__module__ = "dsh_wechat_bridge.process"

    class Memory:
        def __init__(self, _lease):
            self.closed = False

        def read_byte(self, _lease):
            return 7

        def close(self):
            self.closed = True

    def atomic_json(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def fail_recovery(*_args):
        try:
            raise ProcessBindingError("Weixin process does not have exactly one configured unowned main window")
        except ProcessBindingError as exc:
            raise RuntimeError("private outer detail") from exc

    fake_gate = SimpleNamespace(
        Win32ProcessMemory=Memory,
        _atomic_json=atomic_json,
        watchdog_recover=fail_recovery,
        GateError=RuntimeError,
    )

    result = native_worker.watchdog_main_with_diagnostics(
        lease_path, state_root, gate_module=fake_gate, legacy_root=legacy_root
    )

    diagnostic_path = state_root / "window-preparations" / "last-watchdog-diagnostic.json"
    status_path = lease_path.with_suffix(".status.json")
    ready_path = lease_path.with_suffix(".ready.json")
    diagnostic_text = diagnostic_path.read_text(encoding="utf-8")
    diagnostic = json.loads(diagnostic_text)

    assert result == 2
    assert json.loads(ready_path.read_text(encoding="utf-8")) == {"ready": True}
    assert json.loads(status_path.read_text(encoding="utf-8")) == {
        "gateActive": None, "gateRestored": False
    }
    assert diagnostic["leaseId"] == "lease-123"
    assert diagnostic["stage"] == "watchdog_recover"
    failure, cause = diagnostic["exceptions"]
    assert failure["type"] == "builtins.RuntimeError"
    assert "message" not in failure
    assert cause["type"] == "dsh_wechat_bridge.process.ProcessBindingError"
    assert cause["message"] == "Weixin process does not have exactly one configured unowned main window"
    assert cause["frames"][-1]["function"] == "fail_recovery"
    assert all("locals" not in frame for item in diagnostic["exceptions"] for frame in item["frames"])
    assert "private outer detail" not in diagnostic_text
    assert "gate-leases" not in str(diagnostic_path.relative_to(state_root))


def test_watchdog_diagnostic_never_serializes_arbitrary_exception_text(tmp_path):
    import wechat_db.native_window_worker as native_worker

    legacy_root = tmp_path / "legacy"
    package = legacy_root / "dsh_wechat_bridge"
    package.mkdir(parents=True)
    (legacy_root / "worker.py").write_text("", encoding="utf-8")
    (package / "gate.py").write_text("", encoding="utf-8")
    state_root = tmp_path / "state"
    lease_path = state_root / "gate-leases" / "lease-secret.json"
    lease_path.parent.mkdir(parents=True)
    lease_path.write_text(json.dumps({"originalByte": 7}), encoding="utf-8")

    class Memory:
        def __init__(self, _lease):
            pass

        def read_byte(self, _lease):
            return 7

        def close(self):
            pass

    def atomic_json(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def fail_recovery(*_args):
        raise RuntimeError("do-not-write-this-secret")

    fake_gate = SimpleNamespace(
        Win32ProcessMemory=Memory,
        _atomic_json=atomic_json,
        watchdog_recover=fail_recovery,
        GateError=RuntimeError,
    )

    assert native_worker.watchdog_main_with_diagnostics(
        lease_path, state_root, gate_module=fake_gate, legacy_root=legacy_root
    ) == 2
    diagnostic_text = (state_root / "window-preparations" / "last-watchdog-diagnostic.json").read_text(
        encoding="utf-8"
    )

    assert "do-not-write-this-secret" not in diagnostic_text
    assert "locals" not in diagnostic_text
    failure = json.loads(diagnostic_text)["exceptions"][0]
    assert failure["type"] == "builtins.RuntimeError"
    assert "message" not in failure


def test_desktop_watchdog_default_path_uses_diagnostic_recovery_wrapper(tmp_path, monkeypatch):
    import sys
    from types import ModuleType
    import wechat_db.native_window_worker as native_worker

    legacy_root = tmp_path / "legacy"
    package_path = legacy_root / "dsh_wechat_bridge"
    package_path.mkdir(parents=True)
    (legacy_root / "worker.py").write_text("", encoding="utf-8")
    gate_path = package_path / "gate.py"
    gate_path.write_text("", encoding="utf-8")
    state_root = tmp_path / "state"
    lease_path = state_root / "gate-leases" / "lease-default.json"
    lease_path.parent.mkdir(parents=True)
    lease_path.write_text(json.dumps({"originalByte": 7}), encoding="utf-8")

    class Memory:
        def __init__(self, _lease):
            pass

        def read_byte(self, _lease):
            return 7

        def close(self):
            pass

    def atomic_json(path, value):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    gate_module = SimpleNamespace(
        __file__=str(gate_path),
        Win32ProcessMemory=Memory,
        _atomic_json=atomic_json,
        watchdog_recover=lambda *_args: (_ for _ in ()).throw(RuntimeError("private")),
        GateError=RuntimeError,
    )
    package_module = ModuleType("dsh_wechat_bridge")
    package_module.__path__ = [str(package_path)]
    package_module.gate = gate_module
    monkeypatch.setitem(sys.modules, "dsh_wechat_bridge", package_module)

    class FakeDesktopApi:
        def open_desktop(self, _name):
            return object()

        def set_thread_desktop(self, _handle):
            return True

        def close_desktop(self, _handle):
            raise AssertionError("attached desktop handle stays assigned until process exit")

    result = native_worker.run_watchdog_on_desktop(
        legacy_root,
        DESKTOP,
        lease_path,
        desktop_api_factory=FakeDesktopApi,
        diagnostic_root=state_root,
    )

    diagnostic = json.loads(
        (state_root / "window-preparations" / "last-watchdog-diagnostic.json").read_text(encoding="utf-8")
    )
    assert result == 2
    assert diagnostic["stage"] == "watchdog_recover"
    assert diagnostic["exceptions"][0]["type"] == "builtins.RuntimeError"
    assert "private" not in str(diagnostic)


def test_watchdog_diagnostic_wrapper_preserves_legacy_success_contract(tmp_path):
    import wechat_db.native_window_worker as native_worker

    legacy_root = tmp_path / "legacy"
    package = legacy_root / "dsh_wechat_bridge"
    package.mkdir(parents=True)
    (legacy_root / "worker.py").write_text("", encoding="utf-8")
    (package / "gate.py").write_text("", encoding="utf-8")
    state_root = tmp_path / "state"
    lease_path = state_root / "gate-leases" / "lease-ok.json"
    lease_path.parent.mkdir(parents=True)
    lease_path.write_text(json.dumps({"originalByte": 7}), encoding="utf-8")
    events = []

    class Memory:
        def __init__(self, _lease):
            events.append("memory-open")

        def read_byte(self, _lease):
            return 7

        def close(self):
            events.append("memory-close")

    def atomic_json(path, value):
        events.append((path.name, value))
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding="utf-8")

    def recover(_memory, _lease, stop_requested):
        assert callable(stop_requested)
        events.append("recover")
        return {"gateActive": False, "gateRestored": True}

    fake_gate = SimpleNamespace(
        Win32ProcessMemory=Memory,
        _atomic_json=atomic_json,
        watchdog_recover=recover,
        GateError=RuntimeError,
    )

    result = native_worker.watchdog_main_with_diagnostics(
        lease_path, state_root, gate_module=fake_gate, legacy_root=legacy_root
    )

    assert result == 0
    assert events == [
        "memory-open",
        ("lease-ok.ready.json", {"ready": True}),
        "recover",
        ("lease-ok.status.json", {"gateActive": False, "gateRestored": True}),
        "memory-close",
    ]
    assert not (state_root / "window-preparations" / "last-watchdog-diagnostic.json").exists()


def test_hidden_thread_checks_the_default_monitor_snapshot_without_calling_its_live_sampler():
    class Monitor:
        desktop = DESKTOP
        path = Path("monitor.json")
        nonce = "nonce"
        binding = {"pid": 7, "processStartedAt": 10.0}

        def safe(self):
            raise AssertionError("the hidden desktop must not sample as if it were Default")

    validated = []
    require_default_monitor_lease(
        Monitor(),
        desktop_names=lambda: (DESKTOP, "Default"),
        read_monitor_file=lambda _path: {"safe": True},
        validate_monitor_lease=lambda value, **kwargs: validated.append((value, kwargs)),
        now=20.0,
    )

    assert validated == [({"safe": True}, {
        "nonce": "nonce", "binding": {"pid": 7, "processStartedAt": 10.0},
        "desktop": DESKTOP, "now": 20.0,
    })]
    with pytest.raises(NativeWindowError):
        require_default_monitor_lease(
            Monitor(),
            desktop_names=lambda: ("Default", "Default"),
            read_monitor_file=lambda _path: {"safe": True},
            validate_monitor_lease=lambda *_args, **_kwargs: None,
            now=20.0,
        )


def test_close_failure_keeps_hidden_thread_and_desktop_for_safe_retry(tmp_path):
    main_thread_id = threading.get_ident()
    primary = _primary_binding()
    target = _binding()
    config = {**_config(), "stateRoot": str(tmp_path / "state")}

    class FakeDesktopApi:
        def __init__(self):
            self.calls: list[tuple[str, int]] = []
            self.close_attempts = 0
            self.last_error = None

        def open_desktop(self, name):
            self.calls.append((f"open:{name}", threading.get_ident()))
            return object()

        def set_thread_desktop(self, handle):
            self.calls.append(("set-thread-desktop", threading.get_ident()))
            return True

        def close_desktop(self, handle):
            self.calls.append(("close-desktop", threading.get_ident()))
            self.close_attempts += 1
            if self.close_attempts == 1:
                self.last_error = 170
                return False
            self.last_error = None
            return self.close_attempts > 1

    class FakeRuntime:
        def __init__(self):
            self.close_calls: list[int] = []

        def probe(self, received_config):
            return {
                "selfId": received_config["botWxid"],
                "targetId": received_config["targetWxid"],
                "binding": primary,
            }

        def verify(self, received_config, session):
            assert session["binding"] == primary

        def close(self):
            self.close_calls.append(threading.get_ident())
            if len(self.close_calls) == 1:
                return {"closed": False, "gateActive": True, "gateRestored": False}
            return {"closed": True, "gateActive": False, "gateRestored": True}

    class FakeLease:
        def __init__(self, _config, lease_binding):
            assert lease_binding == primary

        def start(self):
            return {"nonce": "test"}

        def safe(self):
            return True

        def close(self):
            return None

        def remove(self):
            return None

    def prepare(_runtime, _config, _session, _monitor, *, cancelled):
        assert not cancelled()
        return {
            "opened": True,
            "binding": target,
            "gateActive": False,
            "gateRestored": True,
        }

    api = FakeDesktopApi()
    legacy_runtime = FakeRuntime()
    runtime = NativeWindowRuntime(
        desktop_api_factory=lambda: api,
        runtime_factory=lambda _config: legacy_runtime,
        lease_factory=FakeLease,
        prepare_on_desktop=prepare,
    )

    prepared = runtime.prepare_window(config, _cancel_path(config))
    gate_close = runtime.close()
    assert gate_close == {"closed": False, "gateActive": True, "gateRestored": False}
    assert runtime.thread_alive is True

    with pytest.raises(NativeWindowError) as close_error:
        runtime.close()

    assert close_error.value.state == {
        "closed": False, "gateActive": False, "gateRestored": True
    }
    assert close_error.value.__cause__.last_error == 170
    assert close_error.value.__cause__.thread_joined is True
    assert close_error.value.__cause__.thread_alive is False
    assert close_error.value.__cause__.runtime_close_confirmed is True
    assert close_error.value.__cause__.handle_retained is True
    assert runtime.thread_alive is False
    assert legacy_runtime.close_calls[0] != main_thread_id
    assert legacy_runtime.close_calls[0] == legacy_runtime.close_calls[1]
    assert not any(name == "close-desktop" for name, _thread in api.calls[:2])

    assert prepared["binding"] == target

    third_close = runtime.close()
    assert third_close == {"closed": True, "gateActive": False, "gateRestored": True}
    assert runtime.thread_alive is False
    fourth_close = runtime.close()
    assert fourth_close == {"closed": True, "gateActive": False, "gateRestored": True}
    assert [name for name, _thread in api.calls] == [
        f"open:{DESKTOP}", "set-thread-desktop", "close-desktop", "close-desktop"
    ]
    assert all(thread_id != main_thread_id for name, thread_id in api.calls if name != "close-desktop")
    assert all(thread_id == main_thread_id for name, thread_id in api.calls if name == "close-desktop")


def test_win32_close_desktop_captures_only_last_error_code(monkeypatch):
    import wechat_db.native_window_worker as native_worker

    calls = []
    fake_ctypes = SimpleNamespace(
        set_last_error=lambda value: calls.append(("clear", value)),
        get_last_error=lambda: 87,
    )
    monkeypatch.setattr(native_worker, "ctypes", fake_ctypes)
    api = object.__new__(native_worker._Win32DesktopApi)
    api._user32 = SimpleNamespace(CloseDesktop=lambda _handle: False)
    api.last_error = None

    assert api.close_desktop(object()) is False
    assert api.last_error == 87
    assert calls == [("clear", 0)]


def test_process_owned_main_defers_only_error_170_to_normal_process_exit(tmp_path):
    handle = object()

    class FakeDesktopApi:
        last_error = None

        def open_desktop(self, _name):
            return handle

        def set_thread_desktop(self, _handle):
            return True

        def close_desktop(self, _handle):
            self.last_error = 170
            return False

    class FakeRuntime:
        def probe(self, _config):
            return {"binding": _primary_binding()}

        def close(self):
            return {"closed": True, "gateActive": False, "gateRestored": True}

    api = FakeDesktopApi()
    runtime = NativeWindowRuntime(
        desktop_api_factory=lambda: api,
        runtime_factory=lambda _config: FakeRuntime(),
        process_owned=True,
    )
    runtime._dispatcher.call("probe", _config())

    result = runtime.close()

    assert result == {
        "closed": True,
        "gateActive": False,
        "gateRestored": True,
        "desktopHandleDeferredToProcessExit": True,
    }
    assert runtime._closed is True
    assert runtime.desktop_handle_deferred_to_process_exit is True
    assert runtime.thread_alive is False
    assert runtime._dispatcher._handle is handle
    assert runtime._dispatcher._api is api
    assert runtime.close() == result


def test_main_jsonl_close_ack_exposes_deferred_handle_exit_and_process_owned_mode(tmp_path, monkeypatch):
    import sys
    from types import ModuleType
    import wechat_db.native_window_worker as native_worker

    legacy_root = tmp_path / "legacy"
    legacy_root.mkdir()
    (legacy_root / "worker.py").write_text("", encoding="utf-8")
    package = ModuleType("dsh_wechat_bridge")
    package.__path__ = [str(legacy_root)]
    worker_module = ModuleType("dsh_wechat_bridge.worker")
    captured = []

    class FakeWorker:
        def __init__(self, runtime):
            self.runtime = runtime

        def handle(self, _request):
            self.runtime.desktop_handle_deferred_to_process_exit = True
            return {"result": {"closed": True, "gateActive": False, "gateRestored": True}}

    worker_module.Worker = FakeWorker
    worker_module.validate_config = lambda value: value
    monkeypatch.setitem(sys.modules, "dsh_wechat_bridge", package)
    monkeypatch.setitem(sys.modules, "dsh_wechat_bridge.worker", worker_module)
    monkeypatch.setattr(sys, "path", list(sys.path))

    def capture_jsonl(_stdin, _stdout, worker, _validate_config):
        captured.append(worker.runtime.process_owned)
        response = native_worker._response_for_request(
            worker, {"method": "close", "params": {}}, lambda value: value
        )
        captured.append(response)

    monkeypatch.setattr(native_worker, "serve_jsonl", capture_jsonl)

    assert native_worker.main(["--legacy-root", str(legacy_root)]) == 0
    assert captured == [True, {"result": {
        "closed": True,
        "gateActive": False,
        "gateRestored": True,
        "desktopHandleDeferredToProcessExit": True,
    }}]


def test_prepare_window_probes_and_prepares_on_hidden_thread_with_default_lease(tmp_path):
    primary = _primary_binding()
    target = _binding()
    config = {**_config(), "stateRoot": str(tmp_path / "state")}
    main_thread_id = threading.get_ident()
    events: list[tuple[str, int]] = []

    class FakeDesktopApi:
        def open_desktop(self, name):
            events.append((f"open:{name}", threading.get_ident()))
            return object()

        def set_thread_desktop(self, handle):
            events.append(("set-thread-desktop", threading.get_ident()))
            return True

        def close_desktop(self, handle):
            events.append(("close-desktop", threading.get_ident()))
            return True

    class FakeLease:
        def __init__(self, lease_config, lease_binding):
            assert threading.get_ident() == main_thread_id
            assert lease_binding == primary
            self.config = lease_config
            events.append(("lease-created", threading.get_ident()))

        def start(self):
            events.append(("lease-started", threading.get_ident()))
            return {"nonce": "test"}

        def safe(self):
            events.append(("lease-safe", threading.get_ident()))
            return True

        def close(self):
            events.append(("lease-closed", threading.get_ident()))

        def remove(self):
            events.append(("lease-removed", threading.get_ident()))

    class FakeRuntime:
        def __init__(self):
            events.append(("runtime-created", threading.get_ident()))

        def probe(self, received_config):
            events.append(("probe", threading.get_ident()))
            return {
                "selfId": received_config["botWxid"],
                "targetId": received_config["targetWxid"],
                "binding": primary,
            }

        def verify(self, received_config, session):
            events.append(("verify", threading.get_ident()))

        def close(self):
            events.append(("runtime-close", threading.get_ident()))
            return {"closed": True, "gateActive": False, "gateRestored": True}

    def prepare(runtime, received_config, session, monitor, *, cancelled):
        assert threading.get_ident() != main_thread_id
        assert received_config == config
        assert session["binding"] == primary
        assert not cancelled()
        runtime.verify(received_config, session)
        events.append(("prepare", threading.get_ident()))
        return {
            "opened": True,
            "binding": target,
            "gateActive": False,
            "gateRestored": True,
            "reused": True,
        }

    runtime = NativeWindowRuntime(
        desktop_api_factory=FakeDesktopApi,
        runtime_factory=lambda _config: FakeRuntime(),
        lease_factory=FakeLease,
        prepare_on_desktop=prepare,
    )
    result = runtime.prepare_window(config, _cancel_path(config))
    close = runtime.close()

    assert result["gateRestored"] is True
    assert result["binding"] == target
    assert close == {"closed": True, "gateActive": False, "gateRestored": True}
    names = [name for name, _thread in events]
    assert names == [
        "open:" + DESKTOP,
        "set-thread-desktop",
        "runtime-created",
        "probe",
        "lease-created",
        "lease-started",
        "lease-safe",
        "verify",
        "prepare",
        "lease-safe",
        "lease-closed",
        "lease-removed",
        "runtime-close",
        "close-desktop",
    ]
    assert events[2][1] != main_thread_id
    assert events[3][1] != main_thread_id
    assert all(events[index][1] == main_thread_id for index in (4, 5, 6, 9, 10, 11))
    assert events[7][1] != main_thread_id
    assert events[8][1] != main_thread_id


def test_prepare_failure_preserves_exception_cause_for_local_diagnostics(tmp_path):
    primary = _primary_binding()
    config = {**_config(), "stateRoot": str(tmp_path / "state")}

    class FakeDesktopApi:
        def open_desktop(self, _name):
            return object()

        def set_thread_desktop(self, _handle):
            return True

        def close_desktop(self, _handle):
            return True

    class FakeLease:
        def __init__(self, _config, _binding):
            pass

        def start(self):
            return None

        def safe(self):
            return True

        def close(self):
            return None

        def remove(self):
            return None

    class FakeRuntime:
        def probe(self, received_config):
            return {
                "selfId": received_config["botWxid"],
                "targetId": received_config["targetWxid"],
                "binding": primary,
            }

        def close(self):
            return {"closed": True, "gateActive": False, "gateRestored": True}

    def prepare(*_args, **_kwargs):
        raise ValueError("private runtime detail")

    runtime = NativeWindowRuntime(
        desktop_api_factory=FakeDesktopApi,
        runtime_factory=lambda _config: FakeRuntime(),
        lease_factory=FakeLease,
        prepare_on_desktop=prepare,
    )

    with pytest.raises(NativeWindowError) as raised:
        runtime.prepare_window(config, _cancel_path(config))

    assert isinstance(raised.value.__cause__, NativeWindowError)
    assert isinstance(raised.value.__cause__.__cause__, ValueError)
    assert runtime.close() == {"closed": True, "gateActive": False, "gateRestored": True}


def test_cancel_path_is_confined_to_the_preparation_directory(tmp_path):
    state_root = tmp_path / "state"
    config = {**_config(), "stateRoot": str(state_root)}
    marker = state_root / "window-preparations" / (uuid.uuid4().hex + ".cancel")

    assert NativeWindowRuntime._validate_cancel_path(config, str(marker)) == marker.resolve()
    with pytest.raises(NativeWindowError):
        NativeWindowRuntime._validate_cancel_path(config, str(state_root / "outside.cancel"))
    with pytest.raises(NativeWindowError):
        NativeWindowRuntime._validate_cancel_path(
            config, str(state_root / "window-preparations" / "not-a-uuid.cancel")
        )


def test_jsonl_worker_routes_probe_send_and_close_through_worker_handle(tmp_path):
    state_root = tmp_path / "state"
    config = {**_config(), "stateRoot": str(state_root)}
    cancel_path = _cancel_path(config)
    calls = []

    class FakeRuntime:
        def prepare_window(self, received_config, received_cancel_path):
            calls.append((received_config, received_cancel_path))
            return {"opened": True, "gateActive": False, "gateRestored": True}

    class FakeWorker:
        runtime = FakeRuntime()

        def handle(self, request):
            calls.append(request)
            if request["method"] == "close":
                return {"result": {"closed": True, "gateActive": False, "gateRestored": True}}
            return {"result": {"method": request["method"]}}

    worker = FakeWorker()
    prepared = _response_for_request(
        worker,
        {"method": "prepareWindow", "params": {"config": config, "cancelPath": cancel_path}},
        lambda value: value,
    )
    missing_cancel = _response_for_request(
        worker, {"method": "prepareWindow", "params": {"config": config}}, lambda value: value
    )
    probed = _response_for_request(
        worker, {"method": "probe", "params": {"config": config}}, lambda value: value
    )
    sent = _response_for_request(
        worker, {"method": "send", "params": {"attemptId": "once"}}, lambda value: value
    )
    closed = _response_for_request(worker, {"method": "close", "params": {}}, lambda value: value)

    assert prepared["result"]["opened"] is True
    assert calls[0] == (config, cancel_path)
    assert missing_cancel["error"]["code"] == "prepare_failed"
    assert probed == {"result": {"method": "probe"}}
    assert sent == {"result": {"method": "send"}}
    assert closed["result"]["closed"] is True
    assert calls[1:] == [
        {"method": "probe", "params": {"config": config}},
        {"method": "send", "params": {"attemptId": "once"}},
        {"method": "close", "params": {}},
    ]


@pytest.mark.parametrize(
    ("conversation_type", "target_name", "target_id"),
    [
        ("direct", TARGET, "wxid_test_peer"),
        ("group", "△", "test_triangle@chatroom"),
    ],
)
def test_worker_probe_send_close_bridges_default_monitor_and_hidden_session(
    tmp_path, conversation_type, target_name, target_id
):
    config = {
        **_config(),
        "stateRoot": str(tmp_path / "state"),
        "targetName": target_name,
        "targetWxid": target_id,
        "mainWindowTitle": target_name,
        "conversationType": conversation_type,
    }
    main_thread_id = threading.get_ident()
    events = []
    hidden_binding = _binding(hwnd=7900 if conversation_type == "direct" else 7901, title=target_name)
    session = {"selfId": config["botWxid"], "targetId": target_id, "binding": hidden_binding}
    expected_message = "群聊发送测试" if conversation_type == "group" else "私聊发送测试"

    class FakeDesktopApi:
        def open_desktop(self, _name):
            events.append(("desktop-open", threading.get_ident()))
            return object()

        def set_thread_desktop(self, _handle):
            events.append(("desktop-set", threading.get_ident()))
            return True

        def close_desktop(self, _handle):
            events.append(("desktop-close", threading.get_ident()))
            return True

    class FakeLease:
        def __init__(self, lease_config, binding):
            assert threading.get_ident() == main_thread_id
            assert lease_config == config
            assert binding == hidden_binding
            self.safe_calls = 0
            events.append(("lease-created", threading.get_ident()))

        def start(self):
            assert threading.get_ident() == main_thread_id
            events.append(("lease-start", threading.get_ident()))
            return {"nonce": "test"}

        def safe(self):
            assert threading.get_ident() == main_thread_id
            self.safe_calls += 1
            events.append(("lease-safe", threading.get_ident()))
            return True

        def close(self):
            assert threading.get_ident() == main_thread_id
            events.append(("lease-close", threading.get_ident()))

        def remove(self):
            assert threading.get_ident() == main_thread_id
            events.append(("lease-remove", threading.get_ident()))

    class FakeRuntime:
        def __init__(self):
            self.monitor = None

        def probe(self, received_config):
            assert threading.get_ident() != main_thread_id
            assert received_config == config
            assert received_config["mainWindowTitle"] == received_config["targetName"]
            events.append(("hidden-probe", threading.get_ident()))
            return session

        def verify(self, received_config, received_session):
            assert threading.get_ident() != main_thread_id
            assert received_config == config
            assert received_session == session
            events.append(("hidden-verify", threading.get_ident()))

        def close(self):
            assert threading.get_ident() != main_thread_id
            events.append(("hidden-close", threading.get_ident()))
            return {"closed": True, "gateActive": False, "gateRestored": True}

    class FakeWorker:
        def __init__(self, runtime):
            self.runtime = runtime
            self._closed = False
            self._config = None
            self._session = None
            self._send_attempts = {}

        def handle(self, request):
            method, params = request["method"], request["params"]
            if method == "probe":
                self._config = params["config"]
                self._session = self.runtime.probe(self._config)
                return {"result": self._session}
            if method == "send":
                self.runtime.verify(self._config, self._session)
                return {"result": self.runtime.send(self._config, self._session, params)}
            if method == "close":
                result = self.runtime.close()
                self._closed = True
                return {"result": result}
            raise AssertionError(f"unexpected method: {method}")

    def send_on_desktop(runtime, received_config, received_session, params):
        assert threading.get_ident() != main_thread_id
        assert received_config == config
        assert received_session == session
        assert runtime.monitor is monitor_ref[0]
        assert params["target"] == target_id
        assert params["expectedSelfId"] == config["botWxid"]
        assert params["text"] == expected_message
        events.append(("hidden-send", threading.get_ident()))
        return {"status": "confirmed", "sendAttempted": True,
                "gateActive": False, "gateRestored": True}

    runtime = NativeWindowRuntime(
        desktop_api_factory=FakeDesktopApi,
        runtime_factory=lambda _config: FakeRuntime(),
        lease_factory=FakeLease,
        send_on_desktop=send_on_desktop,
    )
    monitor_ref = [None]
    worker = FakeWorker(runtime)
    probe = _response_for_request(
        worker, {"method": "probe", "params": {"config": config}}, lambda value: value
    )
    monitor_ref[0] = runtime._monitor
    send = _response_for_request(
        worker,
        {"method": "send", "params": {"target": target_id, "expectedSelfId": config["botWxid"], "text": expected_message}},
        lambda value: value,
    )
    close = _response_for_request(worker, {"method": "close", "params": {}}, lambda value: value)

    assert probe["result"] == session
    assert send["result"]["status"] == "confirmed"
    assert close["result"] == {"closed": True, "gateActive": False, "gateRestored": True}
    assert runtime._closed is True
    assert [name for name, _thread in events].count("hidden-probe") == 1
    assert [name for name, _thread in events].count("hidden-send") == 1
    assert [name for name, _thread in events].count("hidden-close") == 1
    assert [name for name, _thread in events].count("lease-safe") >= 3
    probe_index = next(index for index, event in enumerate(events) if event[0] == "hidden-probe")
    lease_start_index = next(index for index, event in enumerate(events) if event[0] == "lease-start")
    assert probe_index < lease_start_index
    assert all(thread_id == main_thread_id for name, thread_id in events if name.startswith("lease-"))


def test_jsonl_preparation_error_does_not_expose_local_exception_text(tmp_path):
    config = {**_config(), "stateRoot": str(tmp_path / "state")}
    cancel_path = _cancel_path(config)

    class FakeRuntime:
        def prepare_window(self, _config, _cancel_path):
            raise ValueError("private runtime detail")

    class FakeWorker:
        runtime = FakeRuntime()

    response = _response_for_request(
        FakeWorker(),
        {"method": "prepareWindow", "params": {"config": config, "cancelPath": cancel_path}},
        lambda value: value,
    )

    assert response == {
        "error": {"code": "prepare_failed", "message": "native window preparation failed"}
    }
    assert "private runtime detail" not in str(response)

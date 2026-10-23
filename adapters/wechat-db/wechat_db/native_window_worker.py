"""Serialized native-window preparation on a non-input Windows desktop.

The worker is intentionally small: it reuses the legacy runtime for account,
database, and gate checks, while owning one desktop-bound thread for all UIA
work.  The default desktop remains the user's input desktop.
"""
from __future__ import annotations

import argparse
import copy
import ctypes
from ctypes import wintypes
import importlib
import json
import math
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
import traceback
from contextlib import redirect_stdout
from dataclasses import dataclass
from typing import Any, Callable, TextIO


_BINDING_FIELDS = (
    "hwnd", "pid", "processStartedAt", "mainWindowClass", "mainWindowTitle",
    "exePath", "version", "modulePath", "moduleBase", "moduleSize",
    "accountName", "accountPath",
)
_CLOSED = {"closed": True, "gateActive": False, "gateRestored": True}
_UNCONFIRMED_CLOSE = {"closed": False, "gateActive": None, "gateRestored": False}
_DESKTOP_CLOSE_UNCONFIRMED = {"closed": False, "gateActive": False, "gateRestored": True}
_PREPARATION_REASONS = frozenset({
    "prepare_cancelled", "prepare_failed", "target_not_found", "target_ambiguous",
    "header_mismatch", "draft_not_empty", "desktop_unavailable", "monitor_unavailable",
    "gate_preflight", "gate_restore", "cleanup_unconfirmed",
})
_SAFE_PROCESS_BINDING_MESSAGES = frozenset({
    "configured account is not bound to exactly one Weixin process",
    "Weixin executable version could not be verified",
    "Windows UIA binding is available only on Windows",
    "Weixin windows could not be enumerated",
    "configured Weixin main-window class and title are required",
    "Weixin process does not have exactly one configured unowned main window",
    "Weixin binding is Windows-only",
    "Weixin executable version does not match the configured version",
    "configured bot wxid does not resolve to one account directory",
    "Weixin.dll could not be located in the bound process",
    "loaded Weixin.dll path does not match the configured module",
    "gate RVA is invalid",
    "gate RVA is outside the loaded Weixin.dll",
    "process identity verification is Windows-only",
    "bound process executable changed",
    "bound process start time changed",
    "bound Weixin process is unavailable",
    "bound main-window owner changed",
    "bound main window changed",
    "bound Weixin version changed",
    "bound Weixin.dll is unavailable",
    "bound Weixin.dll identity changed",
    "bound Weixin database handles could not be verified",
    "bound process no longer has the configured bot database open",
    "bound bot account directory changed",
    "configured executable changed after probe",
    "configured Weixin.dll changed after probe",
})


class NativeWindowError(RuntimeError):
    """Stable, redacted failure for the native window worker."""


class _DesktopCloseFailure(RuntimeError):
    """Fixed diagnostic cause for a failed desktop-handle release."""

    def __init__(self, last_error: int | None, thread: threading.Thread | None,
                 thread_joined: bool, runtime_close_confirmed: bool, handle_retained: bool):
        super().__init__("CloseDesktop failed")
        self.last_error = last_error
        self.thread_alive = thread.is_alive() if thread is not None else False
        self.thread_id = thread.ident if thread is not None else None
        self.thread_joined = thread_joined
        self.runtime_close_confirmed = runtime_close_confirmed
        self.handle_retained = handle_retained


def _require_desktop_name(value: Any) -> str:
    if not isinstance(value, str) or not re.fullmatch(r"DshWeChatBot_[A-Za-z0-9_-]{1,64}", value):
        raise NativeWindowError("configured desktop name is invalid")
    return value


def _require_binding_shape(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or any(key not in value for key in _BINDING_FIELDS):
        raise NativeWindowError("native window binding snapshot is incomplete")
    if (type(value["hwnd"]) is not int or value["hwnd"] <= 0
            or type(value["pid"]) is not int or value["pid"] <= 0
            or type(value["moduleBase"]) is not int or value["moduleBase"] <= 0
            or type(value["moduleSize"]) is not int or value["moduleSize"] <= 0):
        raise NativeWindowError("native window binding snapshot has invalid numeric identity")
    started = value["processStartedAt"]
    if type(started) not in (int, float) or not math.isfinite(float(started)) or started <= 0:
        raise NativeWindowError("native window binding snapshot has invalid process identity")
    if any(not isinstance(value[key], str) or not value[key] for key in (
        "mainWindowClass", "mainWindowTitle", "exePath", "version", "modulePath",
        "accountName", "accountPath",
    )):
        raise NativeWindowError("native window binding snapshot has invalid text identity")
    return value


def _watchdog_exception_record(exc: BaseException, legacy_root: Path) -> dict[str, Any]:
    exception_type = type(exc)
    qualified_type = f"{exception_type.__module__}.{exception_type.__name__}"
    frames = []
    for frame in traceback.extract_tb(exc.__traceback__):
        try:
            frame_path = Path(frame.filename).resolve().relative_to(legacy_root).as_posix()
        except (OSError, ValueError):
            frame_path = Path(frame.filename).name
        frames.append({"file": frame_path, "line": frame.lineno, "function": frame.name})

    record: dict[str, Any] = {"type": qualified_type, "frames": frames}
    if (qualified_type == "dsh_wechat_bridge.process.ProcessBindingError"
            and str(exc) in _SAFE_PROCESS_BINDING_MESSAGES):
        record["message"] = str(exc)
    return record


def _watchdog_exception_chain(exc: BaseException, legacy_root: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        records.append(_watchdog_exception_record(current, legacy_root))
        if current.__cause__ is not None:
            current = current.__cause__
        elif not current.__suppress_context__:
            current = current.__context__
        else:
            current = None
    return records


def watchdog_main_with_diagnostics(
    lease_path: str | Path,
    diagnostic_root: str | Path,
    *,
    gate_module: Any,
    legacy_root: str | Path,
    memory_factory: Callable[[dict[str, Any]], Any] | None = None,
) -> int:
    """Run the legacy watchdog choreography and persist a redacted failure trace."""
    path = Path(lease_path)
    state_root = Path(diagnostic_root).resolve()
    diagnostic_path = state_root / "window-preparations" / "last-watchdog-diagnostic.json"
    lease_directory = state_root / "gate-leases"
    try:
        path.resolve().relative_to(lease_directory.resolve())
    except ValueError:
        raise NativeWindowError("watchdog lease is outside the configured gate lease directory")
    if state_root.name.casefold() == "gate-leases":
        raise NativeWindowError("watchdog diagnostic root cannot be a gate lease directory")

    ready_path = path.with_suffix(".ready.json")
    status_path = path.with_suffix(".status.json")
    stop_path = path.with_suffix(".stop")
    memory = None
    lease: dict[str, Any] = {}
    failure: tuple[str, BaseException] | None = None
    stage = "read_lease"
    try:
        lease = json.loads(path.read_text(encoding="utf-8"))
        stage = "open_process_memory"
        memory = (memory_factory or gate_module.Win32ProcessMemory)(lease)
        stage = "verify_initial_byte"
        if memory.read_byte(lease) != lease["originalByte"]:
            raise gate_module.GateError("gate was not original when watchdog armed")
        stage = "write_ready"
        gate_module._atomic_json(ready_path, {"ready": True})
        stage = "watchdog_recover"
        restored = gate_module.watchdog_recover(memory, lease, stop_path.exists)
        stage = "write_status"
        gate_module._atomic_json(status_path, restored)
    except Exception as exc:
        failure = (stage, exc)

    if memory is not None:
        try:
            memory.close()
        except Exception as exc:
            if failure is None:
                failure = ("close_process_memory", exc)

    if failure is None:
        return 0

    failed_stage, failed_exception = failure
    diagnostic = {
        "leaseId": path.stem,
        "stage": failed_stage,
        "exceptions": _watchdog_exception_chain(failed_exception, Path(legacy_root).resolve()),
    }
    try:
        gate_module._atomic_json(diagnostic_path, diagnostic)
    except Exception:
        pass
    try:
        gate_module._atomic_json(status_path, {"gateActive": None, "gateRestored": False})
    except Exception:
        pass
    return 2


def validate_prepared_window_binding(
    config: dict[str, Any], account_binding: dict[str, Any], native_binding: dict[str, Any]
) -> dict[str, Any]:
    """Confirm that the prepared HWND is a separate window in the probed account process."""
    if not isinstance(config, dict):
        raise NativeWindowError("worker config is invalid")
    account = _require_binding_shape(account_binding)
    native = _require_binding_shape(native_binding)
    if (not isinstance(config.get("targetName"), str)
            or native["mainWindowTitle"] != config["targetName"]
            or native["mainWindowClass"] != config.get("mainWindowClass")
            or native["hwnd"] == account["hwnd"]):
        raise NativeWindowError("prepared window is not an independent window for the target")
    stable_fields = (
        "pid", "processStartedAt", "exePath", "version", "modulePath", "moduleBase",
        "moduleSize", "accountName", "accountPath",
    )
    if any(native[key] != account[key] for key in stable_fields):
        raise NativeWindowError("prepared window does not belong to the probed account process")
    return native


def run_watchdog_on_desktop(
    legacy_root: str | Path,
    desktop_name: str,
    lease_path: str | Path,
    *,
    desktop_api_factory: Callable[[], Any] | None = None,
    watchdog_main: Callable[[str], int] | None = None,
    diagnostic_root: str | Path | None = None,
) -> int:
    """Attach this process' initial thread before loading the legacy recovery routine."""
    desktop_name = _require_desktop_name(desktop_name)
    root = Path(legacy_root).resolve()
    lease = Path(lease_path).resolve()
    if not (root / "worker.py").is_file() or not (root / "dsh_wechat_bridge" / "gate.py").is_file():
        raise NativeWindowError("legacy watchdog root is invalid")

    sys.dont_write_bytecode = True
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    root_text = str(root)

    api = (desktop_api_factory or _Win32DesktopApi)()
    handle = api.open_desktop(desktop_name)
    if not handle:
        raise NativeWindowError("configured watchdog desktop could not be opened")
    try:
        attached = api.set_thread_desktop(handle)
    except Exception:
        attached = False
    if not attached:
        try:
            api.close_desktop(handle)
        except Exception:
            pass
        raise NativeWindowError("watchdog thread could not attach to the configured desktop")

    if watchdog_main is None:
        if diagnostic_root is None:
            raise NativeWindowError("watchdog diagnostic root is missing")
        if root_text not in sys.path:
            sys.path.insert(0, root_text)
        from dsh_wechat_bridge import gate as legacy_gate_module
        from wechat_db.native_binding import make_native_memory_factory

        watchdog_main = lambda path: watchdog_main_with_diagnostics(
            path, diagnostic_root, gate_module=legacy_gate_module, legacy_root=root,
            memory_factory=make_native_memory_factory(legacy_gate_module),
        )
    # The handle belongs to this thread until process exit. Do not call
    # CloseDesktop while it remains the thread's assigned desktop.
    return watchdog_main(str(lease))


def require_default_monitor_lease(
    monitor: Any,
    *,
    desktop_names: Callable[[], tuple[str, str]],
    read_monitor_file: Callable[[Any], dict[str, Any]],
    validate_monitor_lease: Callable[..., None],
    now: float,
) -> None:
    """Check the Default controller's fresh lease without sampling from this hidden thread."""
    try:
        if desktop_names() != (monitor.desktop, "Default"):
            raise NativeWindowError("worker or input desktop identity changed")
        value = read_monitor_file(monitor.path)
        validate_monitor_lease(
            value,
            nonce=monitor.nonce,
            binding=monitor.binding,
            desktop=monitor.desktop,
            now=now,
        )
    except Exception as exc:
        raise NativeWindowError("default desktop monitor lease is invalid") from exc


class _Win32DesktopApi:
    _DESKTOP_ACCESS = 0x0001 | 0x0002 | 0x0008 | 0x0040 | 0x0080

    def __init__(self) -> None:
        if os.name != "nt":
            raise NativeWindowError("native desktop worker is Windows-only")
        self._user32 = ctypes.WinDLL("user32", use_last_error=True)
        self._user32.OpenDesktopW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self._user32.OpenDesktopW.restype = wintypes.HANDLE
        self._user32.SetThreadDesktop.argtypes = [wintypes.HANDLE]
        self._user32.SetThreadDesktop.restype = wintypes.BOOL
        self._user32.CloseDesktop.argtypes = [wintypes.HANDLE]
        self._user32.CloseDesktop.restype = wintypes.BOOL
        self.last_error: int | None = None

    def open_desktop(self, name: str):
        handle = self._user32.OpenDesktopW(name, 0, False, self._DESKTOP_ACCESS)
        if not handle:
            raise NativeWindowError("configured hidden desktop could not be opened")
        return handle

    def set_thread_desktop(self, handle: Any) -> bool:
        return bool(self._user32.SetThreadDesktop(handle))

    def close_desktop(self, handle: Any) -> bool:
        ctypes.set_last_error(0)
        self.last_error = None
        closed = bool(self._user32.CloseDesktop(handle))
        self.last_error = None if closed else int(ctypes.get_last_error())
        return closed


@dataclass
class _Command:
    method: str
    args: tuple[Any, ...]
    done: threading.Event
    result: Any = None
    error: Exception | None = None


class _DesktopDispatcher:
    """One non-daemon thread, one desktop, and strictly serialized RPC calls."""

    def __init__(self, desktop_api_factory: Callable[[], Any], runtime_factory: Callable[[dict[str, Any]], Any],
                 prepare_on_desktop: Callable[..., dict[str, Any]],
                 send_on_desktop: Callable[..., dict[str, Any]] | None = None):
        self._desktop_api_factory = desktop_api_factory
        self._runtime_factory = runtime_factory
        self._prepare_on_desktop = prepare_on_desktop
        self._send_on_desktop = send_on_desktop
        self._lock = threading.RLock()
        self._commands: queue.Queue[_Command] = queue.Queue()
        self._ready = threading.Event()
        self._started = False
        self._startup_error = False
        self._startup_exception: Exception | None = None
        self._desktop_name: str | None = None
        self._thread: threading.Thread | None = None
        self._startup_config: dict[str, Any] | None = None
        self._close_result: dict[str, Any] | None = None
        self._api: Any = None
        self._handle: Any = None
        self._runtime_ready = False
        self._runtime_close_confirmed = False

    @property
    def thread_alive(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    def _start(self, config: dict[str, Any]) -> None:
        desktop = _require_desktop_name(config.get("desktopName"))
        with self._lock:
            if self._started:
                if desktop != self._desktop_name:
                    raise NativeWindowError("worker desktop cannot change during a session")
                if self._startup_error:
                    raise NativeWindowError("hidden desktop runtime could not start") from self._startup_exception
                return
            self._started = True
            self._desktop_name = desktop
            self._startup_config = dict(config)
            self._thread = threading.Thread(
                target=self._run,
                name="dsh-native-window-desktop",
                daemon=False,
            )
            self._thread.start()
        self._ready.wait()
        if self._startup_error:
            raise NativeWindowError("hidden desktop runtime could not start") from self._startup_exception

    @staticmethod
    def _confirmed_close(result: Any) -> bool:
        return (isinstance(result, dict) and result.get("closed") is True
                and result.get("gateActive") is False and result.get("gateRestored") is True)

    def call(self, method: str, config: dict[str, Any], *args: Any) -> Any:
        self._start(config)
        if self._close_result is not None:
            raise NativeWindowError("hidden desktop runtime is already closed")
        command = _Command(method, (dict(config), *args), threading.Event())
        self._commands.put(command)
        command.done.wait()
        if command.error is not None:
            raise NativeWindowError("hidden desktop request failed") from command.error
        return command.result

    def close(self) -> dict[str, Any]:
        with self._lock:
            if not self._started:
                self._close_result = dict(_CLOSED)
                return dict(_CLOSED)
            thread = self._thread
            if self._close_result is not None:
                return dict(self._close_result)
            startup_error = self._startup_error

        if thread is not None and thread.is_alive():
            if startup_error:
                thread.join()
            else:
                command = _Command("close", (), threading.Event())
                self._commands.put(command)
                command.done.wait()
                if command.error is not None:
                    raise NativeWindowError("hidden desktop runtime cleanup failed") from command.error
                result = command.result
                if not self._confirmed_close(result):
                    return dict(result) if isinstance(result, dict) else dict(_UNCONFIRMED_CLOSE)
            self._runtime_close_confirmed = True

        if thread is not None:
            thread.join()
            if thread.is_alive():
                return dict(_UNCONFIRMED_CLOSE)
        if self._runtime_ready and not self._runtime_close_confirmed:
            return dict(_UNCONFIRMED_CLOSE)

        # A desktop handle remains assigned to the thread that called
        # SetThreadDesktop until that thread exits. Close it only after join,
        # from the Default-desktop caller, and retain it when close fails.
        with self._lock:
            api, handle = self._api, self._handle
        if handle is not None:
            try:
                closed = api is not None and api.close_desktop(handle)
            except Exception:
                self._raise_desktop_close_error(api, thread)
            if not closed:
                last_error = getattr(api, "last_error", None) if api is not None else None
                if type(last_error) is int and last_error >= 0:
                    self._raise_desktop_close_error(api, thread, last_error=last_error)
                return dict(_DESKTOP_CLOSE_UNCONFIRMED)
            with self._lock:
                if self._handle is handle:
                    self._handle = None
                    self._api = None
        self._close_result = dict(_CLOSED)
        return dict(_CLOSED)

    def _raise_desktop_close_error(
        self,
        api: Any,
        thread: threading.Thread | None,
        *,
        last_error: int | None = None,
    ) -> None:
        if last_error is None and api is not None:
            candidate = getattr(api, "last_error", None)
            if type(candidate) is int and candidate >= 0:
                last_error = candidate
        cause = _DesktopCloseFailure(
            last_error,
            thread,
            thread_joined=thread is not None and not thread.is_alive(),
            runtime_close_confirmed=self._runtime_close_confirmed,
            handle_retained=self._handle is not None,
        )
        error = NativeWindowError("hidden desktop handle release is unconfirmed")
        error.state = dict(_DESKTOP_CLOSE_UNCONFIRMED)
        raise error from cause

    def _run(self) -> None:
        api = None
        handle = None
        runtime = None
        try:
            api = self._desktop_api_factory()
            handle = api.open_desktop(self._desktop_name)
            if handle:
                self._api = api
                self._handle = handle
            if not handle or not api.set_thread_desktop(handle):
                raise NativeWindowError("hidden desktop thread attachment failed")
            runtime = self._runtime_factory(dict(self._startup_config or {}))
            self._runtime_ready = True
        except Exception as exc:
            self._startup_error = True
            self._startup_exception = exc
            self._ready.set()
            return

        self._ready.set()
        while True:
            command = self._commands.get()
            if command.method == "close":
                try:
                    result = runtime.close()
                    if not self._confirmed_close(result):
                        command.result = result if isinstance(result, dict) else dict(_UNCONFIRMED_CLOSE)
                        command.done.set()
                        continue
                    command.result = dict(_CLOSED)
                    command.done.set()
                    return
                except Exception as exc:
                    command.error = exc
                    command.done.set()
                    continue
            try:
                config, *args = command.args
                if command.method == "probe":
                    command.result = runtime.probe(config)
                elif command.method == "verify":
                    runtime.verify(config, args[0])
                    command.result = {"verified": True}
                elif command.method == "prepare":
                    session, monitor, cancelled = args
                    runtime.monitor = monitor
                    try:
                        command.result = self._prepare_on_desktop(
                            runtime, config, session, monitor, cancelled=cancelled
                        )
                    finally:
                        if getattr(runtime, "monitor", None) is monitor:
                            runtime.monitor = None
                elif command.method == "send":
                    session, params, monitor = args
                    runtime.monitor = monitor
                    try:
                        send_on_desktop = self._send_on_desktop
                        if send_on_desktop is None:
                            module = importlib.import_module("wechat_db.native_send")
                            send_on_desktop = module.send_on_desktop
                        command.result = send_on_desktop(runtime, config, session, params)
                    finally:
                        if getattr(runtime, "monitor", None) is monitor:
                            runtime.monitor = None
                else:
                    command.error = NativeWindowError("unsupported hidden desktop command")
            except Exception as exc:
                command.error = exc
            finally:
                command.done.set()

class NativeWindowRuntime:
    """Worker-facing facade; default-desktop leases are always owned by this thread."""

    def __init__(
        self,
        *,
        desktop_api_factory: Callable[[], Any] = _Win32DesktopApi,
        runtime_factory: Callable[[dict[str, Any]], Any] | None = None,
        lease_factory: Callable[[dict[str, Any], dict[str, Any]], Any] | None = None,
        prepare_on_desktop: Callable[..., dict[str, Any]] | None = None,
        send_on_desktop: Callable[..., dict[str, Any]] | None = None,
        legacy_root: str | Path | None = None,
        process_owned: bool = False,
    ):
        self._legacy_root = Path(legacy_root).resolve() if legacy_root is not None else None
        self.process_owned = process_owned is True
        self.desktop_handle_deferred_to_process_exit = False
        self._runtime_factory = runtime_factory or self._make_legacy_runtime
        self._lease_factory = lease_factory
        self._prepare_callback = prepare_on_desktop or self._load_prepare_callback
        self._dispatcher = _DesktopDispatcher(
            desktop_api_factory, self._runtime_factory, self._prepare_callback, send_on_desktop
        )
        self._prepare_config: dict[str, Any] | None = None
        self._session_started = False
        self._session_config: dict[str, Any] | None = None
        self._session: dict[str, Any] | None = None
        self._monitor: Any = None
        self._monitor_closed = False
        self._monitor_removed = False
        self._closed = False
        self._lock = threading.RLock()

    @property
    def thread_alive(self) -> bool:
        return self._dispatcher.thread_alive

    def _activate_legacy_root(self) -> Path:
        if self._legacy_root is None:
            raise NativeWindowError("legacy runtime root is unavailable")
        root = self._legacy_root
        if not (root / "worker.py").is_file() or not (root / "dsh_wechat_bridge" / "runtime.py").is_file():
            raise NativeWindowError("legacy runtime root is invalid")
        sys.dont_write_bytecode = True
        os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
        root_text = str(root)
        if root_text not in sys.path:
            sys.path.insert(0, root_text)
        project_root = str(Path(__file__).resolve().parents[1])
        if project_root not in sys.path:
            sys.path.insert(0, project_root)
        return root

    def _make_legacy_runtime(self, config: dict[str, Any]) -> Any:
        legacy_root = self._activate_legacy_root()
        from dsh_wechat_bridge import gate as gate_module
        from dsh_wechat_bridge import runtime as runtime_module

        class DesktopBoundRuntimeMixin:
            monitor = None

            def probe(self, current_config):
                if "preparedBinding" not in current_config:
                    return super().probe(current_config)
                if self._binding is not None or self._db is not None:
                    raise runtime_module.RuntimeScopeError("runtime already owns a process binding")

                from wechat_db.native_binding import NativeBindingError

                try:
                    # The factory is bound to the exact prepared snapshot. It revalidates
                    # PID, HWND, DLL and account scope without a process-wide window scan.
                    binding = self._binding_factory(current_config)
                    db = self._db_factory(current_config, binding["accountName"])
                    self_info = db.get_self_info()
                    self_name = self_info.get("remark") or self_info.get("nick_name") or ""
                    if (self_info.get("username") != current_config["botWxid"]
                            or self_name != current_config["botName"]):
                        raise runtime_module.RuntimeScopeError(
                            "configured bot wxid and exact display name do not match"
                        )
                    runtime_module.verify_target_contact(
                        db, current_config["targetWxid"], current_config["targetName"]
                    )
                    if runtime_module.is_group(current_config):
                        runtime_module.group_members(
                            db, current_config["targetWxid"], current_config["botWxid"]
                        )
                except (NativeBindingError, runtime_module.DbScopeError) as exc:
                    raise runtime_module.RuntimeScopeError(str(exc)) from exc

                self._binding = binding
                self._db = db
                # preparedBinding is nested mutable data; own a deep snapshot so later
                # in-place config edits cannot mutate the session's comparison baseline.
                self._config = copy.deepcopy(current_config)
                return {
                    "selfId": current_config["botWxid"],
                    "targetId": current_config["targetWxid"],
                    "binding": dict(binding),
                }

            def verify(self, current_config, session):
                if "preparedBinding" not in current_config:
                    return super().verify(current_config, session)
                if self._binding is None or self._db is None or self._config != current_config:
                    raise runtime_module.RuntimeScopeError(
                        "runtime session is not bound to this configuration"
                    )
                if not isinstance(session, dict) or session.get("selfId") != current_config["botWxid"]:
                    raise runtime_module.RuntimeScopeError("runtime session identity changed")

                from wechat_db.native_binding import NativeBindingError, resolve_prepared_binding

                try:
                    # Per-operation verification is always against the original owned
                    # snapshot; failures propagate and never rediscover another window.
                    resolve_prepared_binding(current_config, self._binding)
                except NativeBindingError as exc:
                    raise runtime_module.RuntimeScopeError(str(exc)) from exc

            def require_monitor(self):
                monitor = self.monitor
                if monitor is None:
                    raise RuntimeError("default desktop monitor lease is missing")
                try:
                    from dsh_wechat_bridge.desktop import desktop_names
                    from dsh_wechat_bridge.isolated import _read_monitor_file, validate_monitor_lease
                    require_default_monitor_lease(
                        monitor,
                        desktop_names=desktop_names,
                        read_monitor_file=_read_monitor_file,
                        validate_monitor_lease=validate_monitor_lease,
                        now=time.time(),
                    )
                except Exception as exc:
                    raise RuntimeError("default desktop monitor lease is invalid") from exc

            def make_native_gate(self, gate_config, session):
                gate_module.ensure_no_unresolved_leases(gate_config["stateRoot"])
                lease = gate_module._lease_from_config(gate_config, session)
                desktop = _require_desktop_name(gate_config["desktopName"])
                base_watchdog = gate_module.ProcessWatchdog

                class DesktopBoundWatchdog(base_watchdog):
                    def start(watchdog_self):
                        watchdog_script = Path(__file__).resolve()
                        executable = Path(sys.executable)
                        if os.name == "nt":
                            executable = executable.with_name("pythonw.exe")
                            if not executable.is_file():
                                raise gate_module.GateError("windowless Python executable is missing")
                        safe_env = {
                            key: os.environ[key]
                            for key in ("SystemRoot", "WINDIR", "PATH", "TEMP", "TMP")
                            if os.environ.get(key)
                        }
                        safe_env["PYTHONDONTWRITEBYTECODE"] = "1"
                        flags = 0x00000200 | 0x08000000
                        try:
                            watchdog_self.process = subprocess.Popen(
                                [
                                    str(executable), "-B", "-u", str(watchdog_script),
                                    "--legacy-root", str(legacy_root),
                                    "--watchdog-desktop", desktop,
                                    "--watchdog-lease", str(watchdog_self.lease_path),
                                    "--watchdog-state-root", str(gate_config["stateRoot"]),
                                ],
                                stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL,
                                close_fds=True,
                                creationflags=flags if os.name == "nt" else 0,
                                env=safe_env,
                            )
                        except Exception as exc:
                            raise gate_module.GateError("recovery watchdog could not start") from exc

                return gate_module.TemporaryByteGate(
                    lease,
                    gate_config["stateRoot"],
                    memory_factory=importlib.import_module("wechat_db.native_binding").make_native_memory_factory(gate_module),
                    watchdog_factory=lambda path: DesktopBoundWatchdog(path),
                )

        runtime_type = type("NativeDesktopWindowsRuntime", (DesktopBoundRuntimeMixin, runtime_module.WindowsRuntime), {})
        if "preparedBinding" in config:
            from wechat_db.native_binding import resolve_prepared_binding
            return runtime_type(binding_factory=lambda current: resolve_prepared_binding(current, current["preparedBinding"]))
        return runtime_type()

    @staticmethod
    def _load_prepare_callback(
        runtime: Any, config: dict[str, Any], session: dict[str, Any], monitor: Any, *, cancelled: Callable[[], bool]
    ):
        module = importlib.import_module("wechat_db.detached_window")
        return module.prepare_on_desktop(runtime, config, session, monitor, cancelled=cancelled)

    def _new_monitor_lease(self, config: dict[str, Any], binding: dict[str, Any]) -> Any:
        if self._lease_factory is not None:
            return self._lease_factory(config, binding)
        self._activate_legacy_root()
        from dsh_wechat_bridge.isolated import MonitorLease
        return MonitorLease(config, binding)

    @staticmethod
    def _validate_identity_result(config: dict[str, Any], result: Any) -> dict[str, Any]:
        if (not isinstance(result, dict) or result.get("selfId") != config.get("botWxid")
                or result.get("targetId") != config.get("targetWxid")
                or not isinstance(result.get("binding"), dict)):
            raise NativeWindowError("runtime probe identity does not match the configured scope")
        return result

    @classmethod
    def _validate_native_probe_result(cls, config: dict[str, Any], result: Any) -> dict[str, Any]:
        session = cls._validate_identity_result(config, result)
        binding = _require_binding_shape(session["binding"])
        if (not isinstance(config.get("targetName"), str) or not config["targetName"]
                or config.get("mainWindowTitle") != config["targetName"]
                or binding["mainWindowTitle"] != config["targetName"]):
            raise NativeWindowError("runtime probe did not bind the configured target window title")
        return session

    def probe(self, config: dict[str, Any]) -> dict[str, Any]:
        """Bind one configured detached target through a hidden desktop runtime."""
        if not isinstance(config, dict):
            raise NativeWindowError("native target probe config is invalid")
        _require_desktop_name(config.get("desktopName"))
        if (not isinstance(config.get("targetName"), str) or not config["targetName"]
                or config.get("mainWindowTitle") != config["targetName"]):
            raise NativeWindowError("native target probe must use the exact target window title")
        with self._lock:
            if self._closed or self._prepare_config is not None or self._session_started:
                raise NativeWindowError("native worker already owns a runtime session")
            self._session_started = True

        monitor = None
        try:
            session = self._dispatcher.call("probe", config)
            self._validate_native_probe_result(config, session)
            monitor = self._new_monitor_lease(config, session["binding"])
            with self._lock:
                self._monitor = monitor
            monitor.start()
            if monitor.safe() is not True:
                raise NativeWindowError("default desktop monitor did not authorize target session")
            with self._lock:
                self._session_config = dict(config)
                self._session = session
            return session
        except Exception as exc:
            raise NativeWindowError("native target session probe failed") from exc

    def verify(self, config: dict[str, Any], session: dict[str, Any]) -> None:
        """Keep the old process/account verification on the hidden desktop."""
        with self._lock:
            if (self._closed or self._session_config != config or self._session != session
                    or self._monitor is None):
                raise NativeWindowError("native target session changed")
            monitor = self._monitor
        if monitor.safe() is not True:
            raise NativeWindowError("default desktop monitor lease is unsafe")
        self._dispatcher.call("verify", config, session)

    def send(self, config: dict[str, Any], session: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            if (self._closed or self._session_config != config or self._session != session
                    or self._monitor is None):
                raise NativeWindowError("native target session changed")
            monitor = self._monitor
        if monitor.safe() is not True:
            raise NativeWindowError("default desktop monitor lease is unsafe")
        try:
            result = self._dispatcher.call("send", config, session, params, monitor)
        except Exception:
            # The old Worker treats a lost hidden-thread response as an unknown send.
            try:
                monitor.safe()
            except Exception:
                pass
            raise
        if monitor.safe() is not True:
            if isinstance(result, dict):
                return {**result, "status": "ambiguous", "reasonCode": "foreground_guard"}
            return {
                "status": "ambiguous", "reasonCode": "foreground_guard", "sendAttempted": None,
                "gateActive": None, "gateRestored": False,
            }
        return result

    def _close_monitor(self, *, remove: bool) -> None:
        with self._lock:
            monitor = self._monitor
            monitor_closed = self._monitor_closed
            monitor_removed = self._monitor_removed
        if monitor is None:
            return
        if not monitor_closed:
            monitor.close()
            with self._lock:
                self._monitor_closed = True
        if remove and not monitor_removed:
            monitor.remove()
            with self._lock:
                self._monitor_removed = True

    @staticmethod
    def _validate_cancel_path(config: dict[str, Any], cancel_path: Any) -> Path:
        if not isinstance(cancel_path, str) or not Path(cancel_path).is_absolute():
            raise NativeWindowError("native preparation cancellation path is invalid")
        state_root = config.get("stateRoot")
        if not isinstance(state_root, str) or not Path(state_root).is_absolute():
            raise NativeWindowError("native preparation state root is invalid")
        path = Path(cancel_path).resolve(strict=False)
        expected_parent = (Path(state_root).resolve(strict=False) / "window-preparations").resolve(strict=False)
        match = re.fullmatch(r"([0-9a-fA-F]{32})\.cancel", path.name)
        if path.parent != expected_parent or match is None:
            raise NativeWindowError("native preparation cancellation path is outside its state root")
        return path

    def prepare_window(self, config: dict[str, Any], cancel_path: str | None = None) -> dict[str, Any]:
        """Probe the primary account window, prepare the target detached window, and revoke its lease."""
        if not isinstance(config, dict):
            raise NativeWindowError("native preparation config is invalid")
        _require_desktop_name(config.get("desktopName"))
        cancel_file = self._validate_cancel_path(config, cancel_path) if cancel_path is not None else None
        is_cancelled = (lambda: cancel_file is not None and cancel_file.exists())
        with self._lock:
            if self._closed or self._prepare_config is not None or self._session_started:
                raise NativeWindowError("native worker already owns a runtime session")
            self._prepare_config = dict(config)

        monitor = None
        result: dict[str, Any] | None = None
        monitor_safe = False
        monitor_closed = False
        try:
            if is_cancelled():
                raise NativeWindowError("native preparation was cancelled")
            session = self._dispatcher.call("probe", config)
            self._validate_identity_result(config, session)
            if is_cancelled():
                raise NativeWindowError("native preparation was cancelled")
            monitor = self._new_monitor_lease(config, session["binding"])
            monitor.start()
            if is_cancelled() or monitor.safe() is not True:
                raise NativeWindowError("default desktop monitor did not authorize preparation")
            result = self._dispatcher.call("prepare", config, session, monitor, is_cancelled)
            if is_cancelled():
                raise NativeWindowError("native preparation was cancelled")
            if not isinstance(result, dict) or result.get("gateActive") is not False or result.get("gateRestored") is not True:
                raise NativeWindowError("native preparation gate restoration is unconfirmed")
            binding = result.get("binding")
            if result.get("opened") is not True or not isinstance(binding, dict):
                raise NativeWindowError("native preparation returned an incomplete binding")
            validate_prepared_window_binding(config, session["binding"], binding)
            monitor_safe = monitor.safe() is True
            if not monitor_safe:
                raise NativeWindowError("default desktop monitor did not confirm safe preparation")
        except Exception as exc:
            raise NativeWindowError("native window preparation failed") from exc
        finally:
            if monitor is not None:
                try:
                    monitor.close()
                    monitor_closed = True
                except Exception:
                    monitor_closed = False
                if (monitor_closed and monitor_safe and isinstance(result, dict)
                        and result.get("gateRestored") is True):
                    try:
                        monitor.remove()
                    except Exception:
                        monitor_closed = False
        if not monitor_closed or result is None:
            raise NativeWindowError("native preparation cleanup is unconfirmed")
        return result

    def close(self) -> dict[str, Any]:
        with self._lock:
            if self._closed:
                result = dict(_CLOSED)
                if self.desktop_handle_deferred_to_process_exit:
                    result["desktopHandleDeferredToProcessExit"] = True
                return result
        try:
            result = self._dispatcher.close()
        except NativeWindowError as exc:
            cause = exc.__cause__
            if (
                self.process_owned
                and isinstance(cause, _DesktopCloseFailure)
                and cause.last_error == 170
                and cause.thread_alive is False
                and cause.thread_joined is True
                and cause.runtime_close_confirmed is True
                and cause.handle_retained is True
                and getattr(exc, "state", None) == _DESKTOP_CLOSE_UNCONFIRMED
            ):
                self._close_monitor(remove=True)
                with self._lock:
                    self.desktop_handle_deferred_to_process_exit = True
                    self._closed = True
                    self._prepare_config = None
                    self._session_config = None
                    self._session = None
                return {
                    **_CLOSED,
                    "desktopHandleDeferredToProcessExit": True,
                }
            self._close_monitor(remove=False)
            raise
        confirmed = (result.get("closed") is True and result.get("gateActive") is False
                     and result.get("gateRestored") is True)
        self._close_monitor(remove=confirmed)
        if confirmed:
            with self._lock:
                self._closed = True
                self._prepare_config = None
                self._session_config = None
                self._session = None
        return result


def _preparation_failure(exc: BaseException) -> dict[str, Any]:
    """Carry only bounded reason codes and explicit gate evidence across JSONL."""
    result = {"reasonCode": "prepare_failed", "gateActive": None, "gateRestored": False}
    seen: set[int] = set()
    current: BaseException | None = exc
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        reason = getattr(current, "reason_code", None)
        if (result["reasonCode"] == "prepare_failed" and isinstance(reason, str)
                and reason in _PREPARATION_REASONS):
            result["reasonCode"] = reason
        state = getattr(current, "state", None)
        if isinstance(state, dict):
            active, restored = state.get("gateActive"), state.get("gateRestored")
            if (active is None or type(active) is bool) and type(restored) is bool:
                result["gateActive"], result["gateRestored"] = active, restored
                # The nearest owner's restoration evidence takes precedence over causes.
                return result
        current = current.__cause__ if current.__cause__ is not None else (
            None if current.__suppress_context__ else current.__context__
        )
    return result


def _response_for_request(worker: Any, request: Any, validate_config: Callable[[Any], dict[str, Any]]) -> dict[str, Any]:
    if not isinstance(request, dict):
        return {"error": {"code": "invalid_request", "message": "request must be an object"}}
    method = request.get("method")
    params = request.get("params")
    if not isinstance(params, dict):
        return {"error": {"code": "invalid_request", "message": "params must be an object"}}
    if method == "prepareWindow":
        try:
            config = validate_config(params.get("config"))
            cancel_path = params.get("cancelPath")
            if not isinstance(cancel_path, str):
                raise NativeWindowError("native preparation cancellation path is required")
            result = worker.runtime.prepare_window(config, cancel_path)
            return {"result": result}
        except Exception as exc:
            return {"error": {"code": "prepare_failed", "message": "native window preparation failed",
                              **_preparation_failure(exc)}}
    if method == "close":
        try:
            response = worker.handle(request)
            runtime = getattr(worker, "runtime", None)
            if (getattr(runtime, "desktop_handle_deferred_to_process_exit", False)
                    and isinstance(response, dict) and isinstance(response.get("result"), dict)):
                response["result"]["desktopHandleDeferredToProcessExit"] = True
            return response
        except Exception:
            return {"error": {"code": "close_failed", "message": "native worker cleanup is unconfirmed"}}
    if method in ("probe", "send"):
        try:
            return worker.handle(request)
        except Exception:
            return {"error": {"code": "worker_error", "message": "native worker request failed"}}
    return {"error": {
        "code": "unsupported_method",
        "message": "native-window worker supports prepareWindow, probe, send and close only",
    }}


def serve_jsonl(stdin: TextIO, stdout: TextIO, worker: Any, validate_config: Callable[[Any], dict[str, Any]]) -> None:
    try:
        for line in stdin:
            try:
                request = json.loads(line)
            except json.JSONDecodeError:
                request, response = None, {"error": {"code": "invalid_json", "message": "invalid JSON line"}}
            else:
                response = None
                try:
                    with redirect_stdout(sys.stderr):
                        response = _response_for_request(worker, request, validate_config)
                except Exception:
                    response = {"error": {"code": "worker_error", "message": "request failed"}}
            request_id = request.get("id") if isinstance(request, dict) else None
            frame = {"id": request_id, **(response or {"error": {"code": "worker_error", "message": "request failed"}})}
            stdout.write(json.dumps(frame, ensure_ascii=False, separators=(",", ":")) + "\n")
            stdout.flush()
    finally:
        if not worker._closed:
            with redirect_stdout(sys.stderr):
                worker._close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Prepare a detached WeChat chat window on an isolated desktop")
    parser.add_argument("--legacy-root", required=True, help="parent directory of the legacy worker.py")
    parser.add_argument("--watchdog-desktop", help=argparse.SUPPRESS)
    parser.add_argument("--watchdog-lease", help=argparse.SUPPRESS)
    parser.add_argument("--watchdog-state-root", help=argparse.SUPPRESS)
    options = parser.parse_args(argv)
    watchdog_args = (options.watchdog_desktop, options.watchdog_lease, options.watchdog_state_root)
    if any(value is not None for value in watchdog_args) and not all(value is not None for value in watchdog_args):
        parser.error("watchdog desktop, lease and state root must be provided together")
    legacy_root = Path(options.legacy_root).resolve()
    if not (legacy_root / "worker.py").is_file():
        parser.error("--legacy-root must contain worker.py")
    # The watchdog is launched by filename too, so it needs the overlay package
    # available before entering the watchdog branch.
    project_root = str(Path(__file__).resolve().parents[1])
    if project_root not in sys.path:
        sys.path.insert(0, project_root)
    if options.watchdog_desktop is not None:
        try:
            return run_watchdog_on_desktop(
                legacy_root,
                options.watchdog_desktop,
                options.watchdog_lease,
                diagnostic_root=options.watchdog_state_root,
            )
        except Exception:
            return 2
    sys.dont_write_bytecode = True
    os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
    root_text = str(legacy_root)
    if root_text not in sys.path:
        sys.path.insert(0, root_text)
    from dsh_wechat_bridge.worker import Worker, validate_config

    serve_jsonl(
        sys.stdin,
        sys.stdout,
        Worker(runtime=NativeWindowRuntime(legacy_root=legacy_root, process_owned=True)),
        validate_config,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

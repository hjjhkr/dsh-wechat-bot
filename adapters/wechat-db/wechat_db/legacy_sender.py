"""Opt-in sender that delegates one text send to the legacy Windows worker.

The worker is started only for ``send`` and is closed through its normal JSONL
protocol.  This module never switches desktops and never force-stops a child.
"""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
import logging
import os
from pathlib import Path
import queue
import re
import subprocess
import threading
import time

from .rpc import ProtocolError


_LOG = logging.getLogger(__name__)
_MAX_FRAME_BYTES = 1024 * 1024
# The validated account-selection probe took 13.875s. Keep its allowance bounded
# at 30s, while reserving up to 45s for send and 5s for normal close/gate restore.
# The 80s hard total stays inside the adapter's 90s send timeout.
_TOTAL_DEADLINE_S = 80.0
_PROBE_MAX_S = 30.0
_SEND_MAX_S = 45.0
_CLOSE_MAX_S = 5.0
_PREPARE_CLOSE_WAIT_S = 5.0
_DETACHED_PREPARE_FAILED = "独立微信窗口准备失败；接收保持开启，真实发送已禁用。"
_DETACHED_GATE_UNCONFIRMED = "独立微信窗口 gate 恢复状态未确认；真实发送已禁用。"
_DETACHED_CLEANUP_FAILED = "独立微信窗口控制资源清理未确认；真实发送已禁用。"
_DESKTOP_RE = re.compile(r"DshWeChatBot_[A-Za-z0-9_-]{1,64}\Z")
_PREPARATION_REASON_CODES = frozenset({
    "prepare_cancelled",
    "prepare_failed",
    "target_not_found",
    "target_ambiguous",
    "header_mismatch",
    "draft_not_empty",
    "desktop_unavailable",
    "monitor_unavailable",
    "gate_preflight",
    "gate_restore",
    "cleanup_unconfirmed",
})


class PreparationError(RuntimeError):
    """Sanitized preparation failure with explicit gate and worker-close state."""

    def __init__(self, reason_code, gate_state=None, cleanup_confirmed=False):
        self.reason_code = (reason_code if isinstance(reason_code, str)
                            and reason_code in _PREPARATION_REASON_CODES else "prepare_failed")
        state = gate_state if isinstance(gate_state, dict) else {}
        gate_active = state.get("gateActive")
        self.gate_state = {
            "gateActive": gate_active if type(gate_active) is bool or gate_active is None else None,
            "gateRestored": state.get("gateRestored") if type(state.get("gateRestored")) is bool else False,
        }
        self.cleanup_confirmed = (cleanup_confirmed is True
                                  and self.gate_state == {"gateActive": False, "gateRestored": True})
        super().__init__(self.status_message)

    @property
    def status_message(self):
        return f"{_DETACHED_PREPARE_FAILED}原因码：{self.reason_code}。"

    def confirm_restored_cleanup(self):
        self.gate_state = {"gateActive": False, "gateRestored": True}
        self.cleanup_confirmed = True

# These worker-side errors are raised before runtime.send() is called.  They
# only become retryable after a successful normal close confirms gate recovery.
_DEFINITE_NO_SEND_ERRORS = {
    "attempt_marker_required",
    "closed",
    "config_changed",
    "gate_config_required",
    "invalid_attempt",
    "invalid_config",
    "invalid_text",
    "not_probed",
    "scope_violation",
    "send_disabled",
}


def _desktop_name(user, handle) -> str:
    buffer = ctypes.create_unicode_buffer(256)
    needed = wintypes.DWORD()
    if not handle or not user.GetUserObjectInformationW(
        handle, 2, buffer, ctypes.sizeof(buffer), ctypes.byref(needed)
    ):
        raise RuntimeError("desktop identity unavailable")
    return buffer.value


def _desktop_available() -> bool:
    """Return true only while this process and the interactive input use Default."""
    if os.name != "nt":
        return False
    try:
        user = ctypes.WinDLL("user32", use_last_error=True)
        user.GetThreadDesktop.argtypes = [wintypes.DWORD]
        user.GetThreadDesktop.restype = wintypes.HANDLE
        user.OpenInputDesktop.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        user.OpenInputDesktop.restype = wintypes.HANDLE
        user.CloseDesktop.argtypes = [wintypes.HANDLE]
        user.CloseDesktop.restype = wintypes.BOOL
        user.GetUserObjectInformationW.argtypes = [
            wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD,
            ctypes.POINTER(wintypes.DWORD),
        ]
        user.GetUserObjectInformationW.restype = wintypes.BOOL

        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentThreadId.restype = wintypes.DWORD
        # GetThreadDesktop returns a borrowed handle and must not be closed.
        thread_desktop = _desktop_name(
            user, user.GetThreadDesktop(kernel.GetCurrentThreadId())
        )
        input_handle = user.OpenInputDesktop(0, False, 1)
        if not input_handle:
            return False
        try:
            input_desktop = _desktop_name(user, input_handle)
        finally:
            if not user.CloseDesktop(input_handle):
                return False
        return (thread_desktop, input_desktop) == ("Default", "Default")
    except Exception:
        return False


class _FrameTooLarge(Exception):
    pass


class _JsonlChild:
    """Small old-worker transport; stderr is drained and never surfaced."""

    def __init__(self, command: str, args: list[str]):
        self.command = command
        self.args = args
        self.process: subprocess.Popen | None = None
        self._frames: queue.Queue = queue.Queue(maxsize=1)
        self._write_lock = threading.Lock()
        self._request_id = 0
        self._reader_threads: list[threading.Thread] = []
        self._close_acknowledged = False
        self._input_closed = False

    def start(self) -> None:
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
        env = os.environ.copy()
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        env["PYTHONUNBUFFERED"] = "1"
        try:
            process = subprocess.Popen(
                [self.command, *self.args],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                bufsize=0,
                shell=False,
                creationflags=flags,
                env=env,
            )
        except (OSError, ValueError):
            raise ProtocolError("unavailable", "legacy worker could not be started") from None
        self.process = process
        stdout_thread = threading.Thread(target=self._read_stdout, daemon=True)
        stderr_thread = threading.Thread(target=self._drain_stderr, daemon=True)
        stdout_thread.start()
        stderr_thread.start()
        self._reader_threads.extend((stdout_thread, stderr_thread))

    def _read_stdout(self) -> None:
        process = self.process
        assert process is not None and process.stdout is not None
        try:
            while True:
                raw = process.stdout.readline(_MAX_FRAME_BYTES + 1)
                if not raw:
                    self._frames.put(None)
                    return
                if len(raw) > _MAX_FRAME_BYTES or not raw.endswith(b"\n"):
                    self._frames.put(_FrameTooLarge())
                    return
                self._frames.put(raw)
        except Exception:
            try:
                self._frames.put(None)
            except Exception:
                pass

    def _drain_stderr(self) -> None:
        process = self.process
        assert process is not None and process.stderr is not None
        try:
            while process.stderr.read(8192):
                pass
        except Exception:
            pass

    def request(self, method: str, params: dict, timeout: float) -> dict:
        process = self.process
        if process is None or process.stdin is None or process.stdout is None:
            raise ProtocolError("unavailable", "legacy worker is not running")
        if timeout <= 0:
            raise TimeoutError("worker deadline exhausted")
        deadline = time.monotonic() + timeout
        self._request_id += 1
        request_id = self._request_id
        try:
            raw = (json.dumps(
                {"id": request_id, "method": method, "params": params},
                ensure_ascii=True, separators=(",", ":"),
            ) + "\n").encode("ascii")
        except (TypeError, ValueError, UnicodeError):
            raise ConnectionError("worker request transport failed") from None
        write_result: queue.Queue = queue.Queue(maxsize=1)

        def write_request() -> None:
            try:
                with self._write_lock:
                    stream = process.stdin
                    if stream is None or stream.closed:
                        raise OSError("worker request stream is closed")
                    remaining = memoryview(raw)
                    while remaining:
                        written = stream.write(remaining)
                        if not written:
                            raise OSError("worker request stream made no progress")
                        remaining = remaining[written:]
                    stream.flush()
                write_result.put(None)
            except Exception:
                write_result.put(False)

        try:
            threading.Thread(target=write_request, daemon=True).start()
        except RuntimeError:
            raise ConnectionError("worker request writer is unavailable") from None
        try:
            completed = write_result.get(timeout=max(0.0, deadline - time.monotonic()))
        except queue.Empty:
            raise TimeoutError("worker request write deadline exceeded") from None
        if completed is not None:
            raise ConnectionError("worker request transport failed")
        try:
            frame = self._frames.get(timeout=max(0.0, deadline - time.monotonic()))
        except queue.Empty:
            raise TimeoutError("worker response deadline exceeded") from None
        if frame is None:
            raise ConnectionError("worker closed its response stream")
        if isinstance(frame, _FrameTooLarge):
            raise ConnectionError("worker response frame is invalid")
        try:
            decoded = json.loads(frame.decode("utf-8").strip())
        except (UnicodeError, json.JSONDecodeError):
            raise ConnectionError("worker response frame is invalid") from None
        if not isinstance(decoded, dict) or decoded.get("id") != request_id:
            raise ConnectionError("worker response id is invalid")
        if "error" in decoded:
            error = decoded.get("error")
            if not isinstance(error, dict) or not isinstance(error.get("code"), str):
                raise ConnectionError("worker error frame is invalid")
            safe_error = {"code": error["code"]}
            if method == "prepareWindow":
                reason = error.get("reasonCode")
                safe_error["reasonCode"] = (
                    reason if isinstance(reason, str) and reason in _PREPARATION_REASON_CODES
                    else "prepare_failed"
                )
                gate_active = error.get("gateActive")
                safe_error["gateActive"] = (
                    gate_active if type(gate_active) is bool or gate_active is None else None
                )
                gate_restored = error.get("gateRestored")
                safe_error["gateRestored"] = gate_restored if type(gate_restored) is bool else False
            return {"error": safe_error}
        result = decoded.get("result")
        if not isinstance(result, dict):
            raise ConnectionError("worker result frame is invalid")
        return {"result": result}

    def close_normally(self, timeout: float) -> bool:
        process = self.process
        if process is None:
            return True
        deadline = time.monotonic() + max(0.0, timeout)
        if not self._close_acknowledged:
            if self._input_closed:
                return False
            try:
                frame = self.request("close", {}, max(0.0, deadline - time.monotonic()))
            except (ProtocolError, OSError, ValueError, ConnectionError, TimeoutError):
                return False
            result = frame.get("result")
            self._close_acknowledged = (
                isinstance(result, dict) and result.get("closed") is True
                and result.get("gateActive") is False and result.get("gateRestored") is True
            )
            if not self._close_acknowledged:
                return False
        if process.stdin is not None and not process.stdin.closed:
            try:
                process.stdin.close()
                self._input_closed = True
            except OSError:
                return False
        try:
            process.wait(timeout=max(0.0, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            return False
        if process.returncode is not None:
            for stream in (process.stdin, process.stdout, process.stderr):
                if stream is not None and not stream.closed:
                    try:
                        stream.close()
                    except OSError:
                        pass
        return self._close_acknowledged and process.returncode == 0


class LegacySender:
    """Optional text-only bridge to the isolated legacy worker."""

    def __init__(self, command: str, args: list[str], worker: dict, self_id: str, *,
                 detached_window: bool = False, preparer=None, preparer_factory=None):
        self._command = command
        self._args = list(args)
        self._worker = worker
        self._self_id = self_id
        self._target_id = worker["targetWxid"]
        self._lock = threading.RLock()
        self._preparer_lock = threading.RLock()
        self._target_switching = False
        self._closed = False
        self._closing = False
        self._disabled = False
        self._child: _JsonlChild | None = None
        self._detached_window = detached_window
        self._preparer_factory = preparer_factory
        self._next_preparer = preparer
        self._preparer = None
        self._prepared_worker_config: dict | None = None
        self._prepared_worker_args: list[str] | None = None
        self._prepare_state = "unbound" if detached_window else "ready"
        self._prepare_error: str | None = None
        self._prepare_cleanup_failed = False
        self._prepare_cleanup_pending = False
        self._prepare_generation = 0
        self._prepare_cancel: threading.Event | None = None
        self._prepare_thread: threading.Thread | None = None
        self._state_callback = None
        self.desktop_control = None

    @classmethod
    def from_file(cls, path: str | os.PathLike, self_id: str) -> "LegacySender":
        try:
            with Path(path).open("r", encoding="utf-8") as stream:
                raw = json.load(stream)
        except (OSError, UnicodeError, json.JSONDecodeError):
            raise ValueError("legacy sender configuration cannot be read") from None
        if not isinstance(raw, dict):
            raise ValueError("legacy sender configuration is invalid")
        detached_window = raw.get("detachedWindow", False)
        if type(detached_window) is not bool:
            raise ValueError("legacy sender detachedWindow must be a boolean")
        command = raw.get("command")
        args = raw.get("args")
        worker = raw.get("worker")
        if (not isinstance(command, str) or not Path(command).is_absolute()
                or not Path(command).is_file()):
            raise ValueError("legacy worker command must be an absolute executable path")
        if (not isinstance(args, list) or not args
                or any(not isinstance(value, str) for value in args)
                or not Path(args[0]).is_absolute() or not Path(args[0]).is_file()):
            raise ValueError("legacy worker args must begin with an absolute worker script")
        if not isinstance(worker, dict):
            raise ValueError("legacy worker config is invalid")
        if not isinstance(self_id, str) or not self_id or worker.get("botWxid") != self_id:
            raise ValueError("legacy worker bot identity does not match the adapter")
        target_id = worker.get("targetWxid")
        if not isinstance(target_id, str) or not target_id:
            raise ValueError("legacy worker target identity is required")
        desktop = worker.get("desktopName")
        if not isinstance(desktop, str) or not _DESKTOP_RE.fullmatch(desktop):
            raise ValueError("legacy worker requires a named isolated desktop")
        # Round-trip through JSON owns a detached, JSON-safe config snapshot.
        worker_snapshot = json.loads(json.dumps(worker, ensure_ascii=True))
        preparer = None
        preparer_factory = None
        if detached_window:
            try:
                from .detached_window import DetachedWindowPreparer

                def preparer_factory(current_worker):
                    return DetachedWindowPreparer(
                        command, list(args), json.loads(json.dumps(current_worker)), self_id,
                    )

                # Construction is cheap and owns only this target's preparation
                # controller. Native window work begins later on watch/set.
                preparer = preparer_factory(worker_snapshot)
            except Exception:
                raise ValueError("detached-window preparation backend is unavailable") from None
        sender = cls(command, args, worker_snapshot, self_id,
                     detached_window=detached_window, preparer=preparer,
                     preparer_factory=preparer_factory)
        desktop_control = raw.get('desktopControl', False)
        if type(desktop_control) is not bool or (desktop_control and not detached_window):
            raise ValueError('desktopControl requires detachedWindow mode and a boolean value')
        if desktop_control:
            from .desktop_control import DesktopController
            sender.desktop_control = DesktopController(path, python_command=command)
        return sender

    @property
    def target_id(self) -> str:
        with self._lock:
            return self._target_id

    @property
    def detached_window(self) -> bool:
        return self._detached_window

    @property
    def preparation_error(self) -> str | None:
        with self._lock:
            return self._prepare_error

    @property
    def preparation_status(self) -> dict:
        """Return a detached, read-only-by-convention preparation snapshot."""
        with self._lock:
            return {
                "state": self._prepare_state if self._detached_window else "unbound",
                "recoveryRequired": self._disabled or self._prepare_cleanup_failed,
                "error": self._prepare_error,
            }

    def set_state_callback(self, callback) -> None:
        """Install an adapter-owned callback for async preparation transitions."""
        if callback is not None and not callable(callback):
            raise TypeError("state callback must be callable")
        with self._lock:
            self._state_callback = callback

    def _notify_state(self, level=None, message=None) -> None:
        with self._lock:
            callback = self._state_callback
        if callback is not None:
            try:
                callback(level, message)
            except Exception:
                _LOG.exception("detached_window_state_callback_failed")

    def _generation_is_current(self, generation: int, cancel_event: threading.Event) -> bool:
        with self._lock:
            return (not self._closed and not self._closing
                    and not self._target_switching
                    and not cancel_event.is_set()
                    and generation == self._prepare_generation
                    and self._prepare_state == "preparing")

    def select_target(self, chat: dict) -> bool:
        """Select one existing chat for the configured sender path."""
        if not self._detached_window:
            raise ProtocolError("unsupported", "dynamic target selection requires detachedWindow")
        if not isinstance(chat, dict):
            raise ProtocolError("invalid_params", "chat must be an existing chat object")
        chat_id = chat.get("id")
        name = chat.get("name")
        kind = chat.get("kind")
        if (not isinstance(chat_id, str) or not chat_id
                or not isinstance(name, str) or not name
                or kind not in ("group", "direct")):
            raise ProtocolError("invalid_params", "chat must include id, name and group/direct kind")
        worker = json.loads(json.dumps(self._worker, ensure_ascii=True))
        worker.update({
            "targetWxid": chat_id,
            "targetName": name,
            "conversationType": kind,
        })
        with self._lock:
            if self._target_switching:
                raise ProtocolError("unavailable", "another target switch is in progress")
            if self._closed or self._closing or self._disabled or self._prepare_cleanup_failed:
                raise ProtocolError("unavailable", "legacy sender is not available for target selection")
            if all(self._worker.get(key) == worker.get(key)
                   for key in ("targetWxid", "targetName", "conversationType")):
                return False
            self._target_switching = True
        try:
            if not self.invalidate_target():
                raise ProtocolError("unavailable", "previous target cleanup is unconfirmed")
            with self._lock:
                if self._closed or self._closing or self._disabled:
                    raise ProtocolError("unavailable", "legacy sender closed during target selection")
                self._worker = worker
                self._target_id = chat_id
            return True
        finally:
            with self._lock:
                self._target_switching = False
            self._notify_state(None, None)

    def prepare_target(self, chat_id: str) -> None:
        """Prepare asynchronously; an explicit same-target watch may retry a safe failure."""
        if not self._detached_window:
            return
        if chat_id != self._target_id:
            raise ProtocolError("invalid_params", "chatId is outside the configured sender target")
        with self._lock:
            if self._target_switching:
                raise ProtocolError("unavailable", "target switch is in progress")
            if self._closed or self._closing or self._disabled or self._prepare_cleanup_failed:
                return
            if self._prepare_state == "failed":
                previous_thread = self._prepare_thread
                if (self._prepare_cleanup_pending
                        or (previous_thread is not None and previous_thread.is_alive())):
                    return
                # This call is the explicit same-target watch/set retry signal.
                # A failed attempt becomes retryable only after its worker thread
                # has exited and the cleanup path did not mark recovery unknown.
                self._prepare_state = "unbound"
                self._prepare_error = None
            elif self._prepare_state != "unbound":
                return
            self._prepare_generation += 1
            generation = self._prepare_generation
            cancel_event = threading.Event()
            self._prepare_cancel = cancel_event
            previous_thread = self._prepare_thread
            self._prepare_cleanup_pending = bool(previous_thread and previous_thread.is_alive())
            self._prepared_worker_config = None
            self._prepared_worker_args = None
            preparer = self._next_preparer
            self._next_preparer = None
            self._prepare_state = "preparing"
            self._prepare_error = None
            thread = threading.Thread(
                target=self._prepare_target_thread,
                args=(generation, cancel_event, previous_thread, preparer),
                name="wechat-detached-window-prepare", daemon=True,
            )
            self._prepare_thread = thread
            try:
                thread.start()
            except Exception as error:
                self._prepare_thread = None
                self._prepare_cancel = None
                self._prepare_state = "failed"
                self._prepare_error = _DETACHED_PREPARE_FAILED
                cancel_event.set()
                _LOG.warning("detached_window_prepare_start_failed type=%s", type(error).__name__)
                start_failed = True
            else:
                start_failed = False
        if start_failed:
            message = _DETACHED_PREPARE_FAILED
            if preparer is not None and not self._close_preparer(preparer):
                with self._lock:
                    self._prepare_cleanup_failed = True
                    self._prepare_error = _DETACHED_CLEANUP_FAILED
                message = _DETACHED_CLEANUP_FAILED
            self._notify_state("warn", message)

    def _prepare_target_thread(self, generation, cancel_event, previous_thread, preparer) -> None:
        accepted = False
        failed = False
        gate_confirmed = False
        prepare_started = False
        unsafe_gate = False
        error_message = None
        preparation_failure = None
        try:
            if previous_thread is not None and previous_thread is not threading.current_thread():
                previous_thread.join()
            if not self._generation_is_current(generation, cancel_event):
                return
            with self._lock:
                self._prepare_cleanup_pending = False
                cleanup_failed = self._prepare_cleanup_failed
                worker_snapshot = json.loads(json.dumps(self._worker, ensure_ascii=True))
                worker_args_snapshot = list(self._args)
            if cleanup_failed:
                raise RuntimeError("previous detached window cleanup was not confirmed")
            target_name = worker_snapshot.get("targetName")
            if not isinstance(target_name, str) or not target_name:
                target_name = worker_snapshot["targetWxid"]
            if preparer is None:
                preparer = self._preparer_factory(worker_snapshot)
            if not self._generation_is_current(generation, cancel_event):
                return
            with self._preparer_lock:
                prepare_started = True
                result = preparer.prepare(cancel_event)
                gate_confirmed = (isinstance(result, dict)
                                  and result.get("gateActive") is False
                                  and result.get("gateRestored") is True)
                if not gate_confirmed:
                    unsafe_gate = True
                    raise RuntimeError("detached window gate state is not confirmed restored")
                if cancel_event.is_set():
                    return
                if not isinstance(result, dict) or result.get("opened") is not True:
                    raise RuntimeError("detached window did not open")
                binding = result.get("binding")
                if (not isinstance(binding, dict)
                        or type(binding.get("hwnd")) is not int or binding["hwnd"] <= 0
                        or type(binding.get("pid")) is not int or binding["pid"] <= 0
                        or not isinstance(binding.get("mainWindowClass"), str)
                        or not binding["mainWindowClass"]
                        or not isinstance(binding.get("mainWindowTitle"), str)
                        or not binding["mainWindowTitle"]):
                    raise RuntimeError("detached window binding is incomplete")
                prepared_worker_config = json.loads(json.dumps(worker_snapshot, ensure_ascii=True))
                prepared_worker_config["mainWindowClass"] = binding["mainWindowClass"]
                prepared_worker_config["mainWindowTitle"] = binding["mainWindowTitle"]
                prepared_worker_config["preparedBinding"] = json.loads(json.dumps(binding))
                prepared_worker_args = [
                    str(Path(__file__).with_name("native_window_worker.py")),
                    "--legacy-root",
                    str(Path(worker_args_snapshot[0]).parent),
                ]
                with self._lock:
                    if (not self._closed and not self._closing and not cancel_event.is_set()
                            and generation == self._prepare_generation
                            and self._prepare_state == "preparing"):
                        self._preparer = preparer
                        self._prepared_worker_config = prepared_worker_config
                        self._prepared_worker_args = prepared_worker_args
                        self._prepare_state = "ready"
                        self._prepare_error = None
                        accepted = True
                    else:
                        return
        except Exception as error:
            if not cancel_event.is_set():
                failed = True
                if isinstance(error, PreparationError):
                    preparation_failure = error
                    gate_confirmed = (
                        error.cleanup_confirmed
                        and error.gate_state == {"gateActive": False, "gateRestored": True}
                    )
                    error_message = error.status_message
                    _LOG.warning(
                        "detached_window_prepare_failed reason=%s gate_confirmed=%s cleanup_confirmed=%s",
                        error.reason_code, gate_confirmed, error.cleanup_confirmed,
                    )
                else:
                    error_message = _DETACHED_PREPARE_FAILED
                    _LOG.warning("detached_window_prepare_failed type=%s", type(error).__name__)
                with self._lock:
                    if prepare_started and not gate_confirmed:
                        unsafe_gate = True
                    if (not self._closed and not self._closing
                            and generation == self._prepare_generation
                            and self._prepare_state == "preparing"):
                        self._prepare_state = "failed"
                        self._prepare_error = (_DETACHED_GATE_UNCONFIRMED if unsafe_gate
                                               else error_message)
        finally:
            if preparer is not None and not accepted:
                close_ok = self._close_preparer(preparer)
                if isinstance(preparation_failure, PreparationError) and close_ok:
                    preparation_failure.confirm_restored_cleanup()
                    gate_confirmed = True
                    unsafe_gate = False
                    error_message = preparation_failure.status_message
                    with self._lock:
                        if (not self._closed and generation == self._prepare_generation
                                and self._prepare_state == "failed"):
                            self._prepare_error = error_message
                if not close_ok:
                    failed = True
                    error_message = _DETACHED_CLEANUP_FAILED
                    with self._lock:
                        self._prepare_cleanup_failed = True
                        if not self._closed:
                            self._prepare_state = "failed"
                            self._prepare_error = error_message
                        current_cancel = self._prepare_cancel
                        if current_cancel is not None:
                            current_cancel.set()
            if unsafe_gate:
                failed = True
                error_message = _DETACHED_GATE_UNCONFIRMED
                with self._lock:
                    self._prepare_cleanup_failed = True
                    if not self._closed:
                        self._prepare_state = "failed"
                        self._prepare_error = error_message
                    current_cancel = self._prepare_cancel
                    if current_cancel is not None:
                        current_cancel.set()
            with self._lock:
                if self._prepare_thread is threading.current_thread():
                    self._prepare_thread = None
                    if self._prepare_state != "preparing":
                        self._prepare_cleanup_pending = False
                elif (generation != self._prepare_generation and self._prepare_thread is None
                      and self._prepare_cleanup_pending):
                    self._prepare_cleanup_pending = False
                if self._prepare_cancel is cancel_event and self._prepare_state != "preparing":
                    self._prepare_cancel = None
            if accepted:
                # Report the target captured for this generation; a later selection
                # must not relabel a completed preparation with its newer target.
                self._notify_state("info", f"已打开微信独立窗口：{target_name}")
            elif failed and (not cancel_event.is_set() or error_message == _DETACHED_CLEANUP_FAILED):
                self._notify_state("warn", error_message or _DETACHED_PREPARE_FAILED)

    def _close_preparer(self, preparer) -> bool:
        try:
            with self._preparer_lock:
                return preparer.close() is True
        except Exception:
            return False

    def invalidate_target(self) -> bool:
        """Invalidate a detached binding and release controller resources without closing WeChat's HWND."""
        if not self._detached_window:
            return True
        with self._lock:
            self._prepare_generation += 1
            if self._prepare_cancel is not None:
                self._prepare_cancel.set()
            previous_state = self._prepare_state
            thread = self._prepare_thread
            preparer = self._preparer if previous_state == "ready" else self._next_preparer
            self._preparer = None
            self._prepared_worker_config = None
            self._prepared_worker_args = None
            self._next_preparer = None
            self._prepare_cleanup_pending = bool(thread and thread.is_alive())
            if not self._prepare_cleanup_failed:
                self._prepare_state = "unbound"
                self._prepare_error = None
            if thread is not None and not thread.is_alive():
                self._prepare_thread = None
                self._prepare_cancel = None
        if preparer is not None and not self._close_preparer(preparer):
            with self._lock:
                self._prepare_cleanup_failed = True
                self._prepare_state = "failed"
                self._prepare_error = _DETACHED_CLEANUP_FAILED
            _LOG.warning("detached_window_cleanup_unconfirmed")
            self._notify_state("warn", _DETACHED_CLEANUP_FAILED)
            return False
        return not self._prepare_cleanup_failed

    def available(self) -> bool:
        with self._lock:
            if (self._closed or self._closing or self._disabled or self._target_switching
                    or self._prepare_cleanup_failed
                    or self._prepare_cleanup_pending or not _desktop_available()):
                return False
            if self._detached_window:
                if (self._prepare_state != "ready"
                        or self._prepared_worker_config is None
                        or self._prepared_worker_args is None):
                    return False
            return True

    @property
    def recovery_required(self) -> bool:
        with self._lock:
            return self._disabled or self._prepare_cleanup_failed

    def send(self, chat_id: str, content: dict, client_id: str) -> str:
        text = self._validate_request(chat_id, content, client_id)
        with self._lock:
            if (self._closed or self._closing or self._disabled or self._target_switching
                    or self._prepare_cleanup_failed
                    or not _desktop_available()):
                raise ProtocolError("unavailable", "legacy sender desktop is unavailable; nothing was sent")
            if self._detached_window:
                if self._prepare_state == "preparing" or self._prepare_cleanup_pending:
                    raise ProtocolError("unavailable", "detached window preparation is in progress; nothing was sent")
                if (self._prepare_state != "ready"
                        or self._prepared_worker_config is None
                        or self._prepared_worker_args is None):
                    reason = self._prepare_error or "detached window has not been prepared"
                    raise ProtocolError(
                        "unavailable",
                        f"detached window is not ready ({reason}); nothing was sent",
                    )
                worker_config = self._prepared_worker_config
                worker_args = self._prepared_worker_args
            else:
                worker_config = self._worker
                worker_args = self._args

            child = _JsonlChild(self._command, worker_args)
            self._child = child
            deadline = time.monotonic() + _TOTAL_DEADLINE_S
            send_issued = False
            probe_started = False
            probe_failed = False
            receipt_id: str | None = None
            failure: ProtocolError | None = None
            failure_requires_close = False
            close_ok = True
            try:
                child.start()
                remaining = deadline - time.monotonic()
                probe_timeout = min(_PROBE_MAX_S, remaining - _SEND_MAX_S - _CLOSE_MAX_S)
                if probe_timeout <= 0:
                    failure = ProtocolError("unavailable", "legacy worker probe deadline exhausted")
                else:
                    probe_started = True
                    probe = child.request("probe", {"config": worker_config}, probe_timeout)
                    if "error" in probe:
                        probe_failed = True
                        failure = ProtocolError("send_failed", "legacy worker probe was not accepted")
                    elif not self._identity_matches(probe["result"]):
                        probe_failed = True
                        failure = ProtocolError("send_failed", "legacy worker identity probe did not match")
                    else:
                        remaining = deadline - time.monotonic()
                        send_timeout = min(_SEND_MAX_S, remaining - _CLOSE_MAX_S)
                        if send_timeout <= 0:
                            failure = ProtocolError("unavailable", "legacy worker send deadline exhausted")
                        else:
                            send_issued = True
                            try:
                                frame = child.request("send", {
                                    "config": worker_config,
                                    "enableSend": True,
                                    "allowTemporaryGate": True,
                                    "hostAttemptPersisted": True,
                                    "attemptId": client_id,
                                    "target": chat_id,
                                    "expectedSelfId": self._self_id,
                                    "text": text,
                                }, send_timeout)
                            except (ConnectionError, OSError, TimeoutError, ValueError):
                                failure = ProtocolError("send_uncertain", "legacy send outcome is unconfirmed")
                            else:
                                worker_error_code = frame.get("error", {}).get("code") if "error" in frame else None
                                failure_requires_close = worker_error_code in _DEFINITE_NO_SEND_ERRORS
                                failure, receipt_id = self._classify_send_frame(frame, chat_id, text)
            except ProtocolError as error:
                probe_failed = probe_failed or (probe_started and not send_issued)
                failure = error if not send_issued else ProtocolError(
                    "send_uncertain", "legacy send outcome is unconfirmed"
                )
            except (ConnectionError, OSError, TimeoutError, ValueError):
                probe_failed = probe_failed or (probe_started and not send_issued)
                failure = ProtocolError(
                    "send_uncertain" if send_issued else "unavailable",
                    "legacy worker response is unavailable",
                )
            finally:
                if child.process is not None:
                    remaining = deadline - time.monotonic()
                    close_timeout = min(_CLOSE_MAX_S, max(0.0, remaining))
                    close_ok = child.close_normally(close_timeout)
                    if not close_ok:
                        self._disable_after_unconfirmed_close()
                if probe_failed:
                    failure = ProtocolError(
                        "send_failed" if close_ok else "unavailable",
                        "legacy probe failed before send" if close_ok
                        else "legacy probe failed and worker recovery is unconfirmed",
                    )
                if close_ok:
                    self._child = None

            if failure_requires_close and not close_ok:
                failure = ProtocolError("send_uncertain", "legacy worker could not confirm safe recovery")

            # A complete outgoing database receipt remains authoritative even if
            # later process cleanup could not be confirmed. No future send is
            # allowed until that worker cleanup problem is resolved externally.
            if receipt_id is not None:
                return receipt_id
            if failure is None:
                failure = ProtocolError("send_uncertain", "legacy send outcome is unconfirmed")
            raise failure

    def _validate_request(self, chat_id: str, content: dict, client_id: str) -> str:
        if chat_id != self._target_id:
            raise ProtocolError("invalid_params", "chatId is outside the configured sender scope")
        if not isinstance(client_id, str) or not client_id.strip():
            raise ProtocolError("invalid_params", "clientId is required")
        if not isinstance(content, dict):
            raise ProtocolError("invalid_params", "content must be an object")
        if content.get("kind") != "text":
            raise ProtocolError("unsupported", "legacy sender supports text only")
        text = content.get("text")
        if not isinstance(text, str) or not text or len(text) > 4096:
            raise ProtocolError("invalid_params", "text must contain 1 to 4096 characters")
        try:
            text.encode("utf-8")
        except UnicodeEncodeError:
            raise ProtocolError("invalid_params", "text must be valid UTF-8") from None
        mentions = content.get("mentions", [])
        if not isinstance(mentions, list):
            raise ProtocolError("invalid_params", "mentions must be a list")
        if mentions:
            raise ProtocolError("unsupported", "legacy sender does not support mentions")
        return text

    def _identity_matches(self, result: dict) -> bool:
        if not isinstance(result, dict):
            return False
        return result.get("selfId") == self._self_id and result.get("targetId") == self._target_id

    def _classify_send_frame(self, frame: dict, target: str, text: str) -> tuple[ProtocolError | None, str | None]:
        if "error" in frame:
            code = frame["error"].get("code")
            if code in _DEFINITE_NO_SEND_ERRORS:
                return ProtocolError("send_failed", "legacy worker rejected the send before dispatch"), None
            return ProtocolError("send_uncertain", "legacy worker did not confirm the send outcome"), None

        result = frame.get("result")
        if not isinstance(result, dict):
            return ProtocolError("send_uncertain", "legacy worker send result is invalid"), None
        attempted = result.get("sendAttempted")
        gate_active = result.get("gateActive")
        gate_restored = result.get("gateRestored")
        if (result.get("status") == "blocked"
                and result.get("reasonCode") == "desktop_unavailable"
                and attempted is False and gate_active is False and gate_restored is True
                and result.get("outgoing") is None):
            return ProtocolError("unavailable", "legacy desktop became unavailable before send"), None
        if (result.get("status") in ("failed", "ambiguous")
                and attempted is False and gate_active is False and gate_restored is True
                and result.get("outgoing") is None):
            reason_code = result.get("reasonCode")
            reason = (f" ({reason_code})" if isinstance(reason_code, str)
                      and re.fullmatch(r"[a-z_]{1,64}", reason_code) else "")
            return ProtocolError(
                "send_failed", f"legacy worker confirmed the send was not attempted{reason}"
            ), None
        if (result.get("status") != "confirmed" or attempted is not True
                or gate_active is not False or gate_restored is not True):
            return ProtocolError("send_uncertain", "legacy worker did not confirm send and gate recovery"), None
        outgoing = result.get("outgoing")
        if not isinstance(outgoing, dict):
            return ProtocolError("send_uncertain", "legacy outgoing receipt is missing"), None
        server_id = outgoing.get("serverId")
        if (outgoing.get("target") != target or outgoing.get("senderId") != self._self_id
                or outgoing.get("text") != text or not isinstance(server_id, str)
                or not server_id.isascii() or not server_id.isdecimal()
                or server_id.startswith("0")
                or type(outgoing.get("localId")) is not int
                or type(outgoing.get("sortSeq")) is not int
                or not isinstance(outgoing.get("shard"), str) or not outgoing["shard"]):
            return ProtocolError("send_uncertain", "legacy outgoing receipt did not match the request"), None
        return None, server_id

    def _disable_after_unconfirmed_close(self) -> None:
        self._disabled = True
        _LOG.warning("legacy_worker_close_unconfirmed; future sends disabled")

    def close(self) -> None:
        close_error = None
        with self._lock:
            if self._closed:
                return
            self._closing = True
            self._prepare_generation += 1
            if self._prepare_cancel is not None:
                self._prepare_cancel.set()
            prepare_thread = self._prepare_thread
            preparer = self._preparer if self._prepare_state == "ready" else self._next_preparer
            self._preparer = None
            self._prepared_worker_config = None
            self._prepared_worker_args = None
            self._next_preparer = None
            self._prepare_cleanup_pending = bool(prepare_thread and prepare_thread.is_alive())
            if not self._prepare_cleanup_failed:
                self._prepare_state = "unbound"
            child = self._child
            if child is not None and child.process is not None:
                if not child.close_normally(_CLOSE_MAX_S):
                    self._disable_after_unconfirmed_close()
                    close_error = ProtocolError("unavailable", "legacy worker close or gate recovery is unconfirmed")
                else:
                    self._child = None
            elif self._disabled:
                close_error = ProtocolError("unavailable", "legacy worker recovery remains unconfirmed")
            if close_error is None:
                self._child = None

        if preparer is not None and not self._close_preparer(preparer):
            with self._lock:
                self._prepare_cleanup_failed = True
                self._prepare_state = "failed"
                self._prepare_error = _DETACHED_CLEANUP_FAILED
            close_error = close_error or ProtocolError(
                "unavailable", "detached window controller cleanup is unconfirmed"
            )
            self._notify_state("warn", _DETACHED_CLEANUP_FAILED)
        if prepare_thread is not None and prepare_thread is not threading.current_thread():
            prepare_thread.join(timeout=_PREPARE_CLOSE_WAIT_S)
            if prepare_thread.is_alive():
                with self._lock:
                    self._prepare_state = "failed"
                    self._prepare_error = _DETACHED_CLEANUP_FAILED
                close_error = close_error or ProtocolError(
                    "unavailable", "detached window preparation cleanup is unconfirmed"
                )
                self._notify_state("warn", _DETACHED_CLEANUP_FAILED)
        with self._lock:
            if self._prepare_cleanup_failed:
                close_error = close_error or ProtocolError(
                    "unavailable", "detached window controller cleanup is unconfirmed"
                )
            if close_error is None:
                self._closed = True
        if close_error is not None:
            raise close_error

"""No-focus UIA draft plus HWND-targeted Return for one already-selected chat."""

from __future__ import annotations

import ctypes
import os
import threading
import time
from ctypes import wintypes
from typing import Any


class UiaSendError(RuntimeError):
    def __init__(self, message: str, reason_code: str = "uia_draft", send_attempted: bool | None = False):
        super().__init__(message)
        self.reason_code = reason_code
        self.send_attempted = send_attempted


def require_selected_target(actual_name: str, expected_name: str) -> None:
    if not expected_name or actual_name != expected_name:
        raise UiaSendError("the already-selected chat does not match the configured target")


def return_key_lparams(scan_code: int) -> tuple[int, int]:
    if type(scan_code) is not int or not 1 <= scan_code <= 0xff:
        raise UiaSendError("Return scan code is invalid")
    down = 1 | (scan_code << 16)
    up = down | (1 << 30) | (1 << 31)
    return down, up


class _FocusMonitor:
    def __init__(self, pid: int):
        self.pid = pid
        self.user32 = ctypes.WinDLL("user32", use_last_error=True)
        self.ready = threading.Event()
        self.stop = threading.Event()
        self.errors: list[str] = []
        self.events: list[dict[str, int]] = []
        self.foregrounds: list[int] = []
        self.foreground_owners: list[int] = []
        self._sample_lock = threading.Lock()
        self.thread: threading.Thread | None = None
        self._callback: Any = None

    def owner(self, hwnd: int) -> int:
        process_id = wintypes.DWORD()
        self.user32.GetWindowThreadProcessId(hwnd or 0, ctypes.byref(process_id))
        return int(process_id.value)

    def foreground(self) -> int:
        return int(self.user32.GetForegroundWindow() or 0)

    def start(self) -> None:
        self.user32.GetForegroundWindow.restype = wintypes.HWND
        self.user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
        self.user32.GetWindowThreadProcessId.restype = wintypes.DWORD
        self.user32.SetWinEventHook.argtypes = [
            wintypes.DWORD, wintypes.DWORD, wintypes.HMODULE,
            ctypes.WINFUNCTYPE(None, wintypes.HANDLE, wintypes.DWORD, wintypes.HWND,
                               ctypes.c_long, ctypes.c_long, wintypes.DWORD, wintypes.DWORD),
            wintypes.DWORD, wintypes.DWORD, wintypes.DWORD,
        ]
        self.user32.SetWinEventHook.restype = wintypes.HANDLE
        self.user32.UnhookWinEvent.argtypes = [wintypes.HANDLE]
        self.user32.UnhookWinEvent.restype = wintypes.BOOL
        self.user32.PeekMessageW.argtypes = [ctypes.POINTER(wintypes.MSG), wintypes.HWND,
                                             wintypes.UINT, wintypes.UINT, wintypes.UINT]
        self.user32.PeekMessageW.restype = wintypes.BOOL
        self.user32.TranslateMessage.argtypes = [ctypes.POINTER(wintypes.MSG)]
        self.user32.DispatchMessageW.argtypes = [ctypes.POINTER(wintypes.MSG)]
        self.thread = threading.Thread(target=self._run, name="wechat-focus-monitor", daemon=True)
        self.thread.start()
        if not self.ready.wait(2.0) or self.errors:
            self.close()
            raise UiaSendError("foreground/focus monitoring could not be established")

    def _run(self) -> None:
        callback_type = ctypes.WINFUNCTYPE(
            None, wintypes.HANDLE, wintypes.DWORD, wintypes.HWND,
            ctypes.c_long, ctypes.c_long, wintypes.DWORD, wintypes.DWORD,
        )

        @callback_type
        def callback(_hook, event, hwnd, _object_id, _child_id, _thread_id, _tick):
            try:
                self._record_focus_event(int(event), int(hwnd or 0))
            except Exception as exc:
                self.errors.append(type(exc).__name__)

        self._callback = callback
        hooks = []
        try:
            hooks = [
                self.user32.SetWinEventHook(3, 3, None, callback, 0, 0, 0),
                self.user32.SetWinEventHook(0x8005, 0x8005, None, callback, 0, 0, 0),
            ]
            if not all(hooks):
                raise UiaSendError("WinEvent focus hooks could not be installed")
            self.ready.set()
            msg = wintypes.MSG()
            while not self.stop.is_set():
                while self.user32.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):
                    self.user32.TranslateMessage(ctypes.byref(msg))
                    self.user32.DispatchMessageW(ctypes.byref(msg))
                foreground = self.foreground()
                # Resolving an owner calls Win32 and can yield to the lease
                # thread. Publish both halves together after that call returns.
                owner = self.owner(foreground) if foreground else 0
                with self._sample_lock:
                    self.foregrounds.append(foreground)
                    self.foreground_owners.append(owner)
                self.stop.wait(0.01)
        except Exception as exc:
            self.errors.append(type(exc).__name__)
            self.ready.set()
        finally:
            for hook in hooks:
                if hook:
                    self.user32.UnhookWinEvent(hook)

    def _record_focus_event(self, event: int, hwnd: int) -> None:
        owner = self.owner(hwnd)
        if not hwnd or not owner:
            self.errors.append("focus_event_owner_unavailable")
            return
        if owner == self.pid:
            self.events.append({"event": event, "hwnd": hwnd, "owner": owner})

    def sample_snapshot(self):
        with self._sample_lock:
            return list(self.foregrounds), list(self.foreground_owners)

    def safe(self, foreground_before: int, *, allow_transient_zero: bool = False) -> bool:
        foreground = self.foreground()
        foregrounds, owners = self.sample_snapshot()
        if not foreground_before or not foreground or not foregrounds:
            self.last_failure = ["foreground_unavailable" if not foreground_before or not foreground else "no_samples"]
            return False
        if len(foregrounds) != len(owners):
            self.last_failure = ["sample_count_mismatch"]
            return False
        initial_owner = self.owner(foreground_before)
        current_owner = self.owner(foreground)
        # A single NULL foreground can occur during activation. Only the hidden
        # desktop controller enables this after independently proving HWND scope.
        zero_allowed = allow_transient_zero and foregrounds.count(0) <= 1
        valid_samples = all(
            (hwnd == 0 and owner == 0 and zero_allowed)
            or (hwnd != 0 and owner > 0 and owner != self.pid)
            for hwnd, owner in zip(foregrounds, owners)
        )
        safe = (
            not self.errors
            and not self.events
            and initial_owner > 0 and initial_owner != self.pid
            and current_owner > 0 and current_owner != self.pid
            and valid_samples
        )
        if not safe:
            reasons = []
            if self.errors: reasons.append("monitor_errors")
            if self.events: reasons.append("bot_focus_event")
            if not initial_owner: reasons.append("initial_window_owner_unavailable")
            if not current_owner: reasons.append("current_window_owner_unavailable")
            if initial_owner == self.pid or current_owner == self.pid or self.pid in owners:
                reasons.append("bot_foreground")
            if not valid_samples:
                reasons.append("sample_owner_unavailable")
            self.last_failure = reasons
        else:
            self.last_failure = []
        return safe

    def close(self) -> None:
        self.stop.set()
        if self.thread is not None:
            self.thread.join(2.0)
            if self.thread.is_alive():
                self.errors.append("monitor_thread_did_not_exit")


class BackgroundUISender:
    """Set one exact chat draft without focus, then post Return to that HWND only."""

    WM_KEYDOWN = 0x0100
    WM_KEYUP = 0x0101
    VK_RETURN = 0x0D

    def __init__(self, config: dict[str, Any], binding: dict[str, Any]):
        self.config = config
        self.binding = binding

    def send(self, text: str, target_name: str, gate: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        if os.name != "nt":
            raise UiaSendError("background UIA send is Windows-only", "gate_preflight", False)
        hwnd = int(self.binding["hwnd"])
        pid = int(self.binding["pid"])
        monitor = None
        try:
            monitor = _FocusMonitor(pid)
            monitor.start()
            foreground_before = monitor.foreground()
            foreground_owner = monitor.owner(foreground_before) if foreground_before else 0
        except UiaSendError:
            if monitor is not None:
                monitor.close()
            raise
        except Exception as exc:
            if monitor is not None:
                monitor.close()
            raise UiaSendError("foreground/focus monitor setup failed", "monitor_start", False) from exc
        if not foreground_before or foreground_owner == 0:
            monitor.close()
            raise UiaSendError("foreground window could not be identified", "monitor_start", False)
        if foreground_owner == pid:
            monitor.close()
            raise UiaSendError("bot must start outside the foreground for a no-focus proof", "foreground_guard", False)
        value = None
        attempted = False
        gate_state = {"gateActive": False, "gateRestored": True}
        action_result: dict[str, Any] = {}
        try:
            def post_return(assert_active):
                nonlocal attempted
                assert_active()
                if not monitor.safe(foreground_before):
                    code = "monitor_start" if monitor.errors else "targeted_return"
                    raise UiaSendError("focus proof failed before the targeted Return", code, attempted)
                user32 = monitor.user32
                user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
                user32.PostMessageW.restype = wintypes.BOOL
                user32.MapVirtualKeyW.argtypes = [wintypes.UINT, wintypes.UINT]
                user32.MapVirtualKeyW.restype = wintypes.UINT
                scan = int(user32.MapVirtualKeyW(self.VK_RETURN, 0))
                if scan != 0x1C:
                    raise UiaSendError("Return scan code does not match the verified client", "targeted_return", False)
                down, up = return_key_lparams(scan)
                attempted = True
                try:
                    keydown = bool(user32.PostMessageW(hwnd, self.WM_KEYDOWN, self.VK_RETURN, down))
                    keyup = bool(user32.PostMessageW(hwnd, self.WM_KEYUP, self.VK_RETURN, up))
                except Exception as exc:
                    raise UiaSendError("targeted Return could not be queued", "targeted_return", True) from exc
                if not keydown or not keyup:
                    raise UiaSendError("targeted Return messages were not both queued", "targeted_return", True)
                time.sleep(0.35)
                assert_active()
                if not monitor.safe(foreground_before):
                    code = "monitor_start" if monitor.errors else "targeted_return"
                    raise UiaSendError("focus proof failed during targeted Return", code, True)
                return {"keydownQueued": keydown, "keyupQueued": keyup, "sendAttempted": True}

            def gated_send(assert_active):
                nonlocal value
                assert_active()
                try:
                    value, automation_enabled = self._set_exact_draft(hwnd, target_name, text)
                    if not automation_enabled:
                        raise UiaSendError("automation may focus during draft preparation", "uia_draft", False)
                    if not monitor.safe(foreground_before):
                        code = "monitor_start" if monitor.errors else "uia_draft"
                        raise UiaSendError("focus proof failed during draft preparation", code, False)
                    return post_return(assert_active)
                except UiaSendError:
                    if not attempted and value is not None:
                        try:
                            if value.Value == text:
                                value.SetValue("", waitTime=0.2)
                        except Exception:
                            pass
                    raise
                except Exception as exc:
                    if not attempted and value is not None:
                        try:
                            if value.Value == text:
                                value.SetValue("", waitTime=0.2)
                        except Exception:
                            pass
                    reason_code = "monitor_start" if monitor.errors else (
                        "targeted_return" if attempted else "uia_draft"
                    )
                    raise UiaSendError(
                        "background UIA send action failed", reason_code, attempted
                    ) from exc

            action_result, gate_state = gate.run(gated_send)
        finally:
            monitor.close()

        no_focus = monitor.safe(foreground_before)
        result = {
            **action_result,
            "autoSetFocus": False,
            "noBotFocusObserved": no_focus,
            "foregroundBefore": foreground_before,
            "foregroundAfter": monitor.foreground(),
            "foregroundUnchanged": monitor.foreground() == foreground_before,
            "botFocusEvents": list(monitor.events),
            "foregroundSamples": len(monitor.foregrounds),
            "monitorErrors": list(monitor.errors),
            "attempted": attempted,
            "sendAttempted": attempted,
        }
        return result, gate_state

    @staticmethod
    def _set_exact_draft(hwnd: int, target_name: str, text: str) -> tuple[Any, bool]:
        try:
            import comtypes.client
            from wx4py.core import uiautomation as ui
            from wx4py.core.uia_wrapper import UIAWrapper

            client = ui._AutomationClient.instance()
            automation = comtypes.client.CreateObject(
                client.UIAutomationCore.CUIAutomation8,
                interface=client.UIAutomationCore.IUIAutomation2,
            )
            automation.AutoSetFocus = False
            client.IUIAutomation = automation
            client.ViewWalker = automation.RawViewWalker
            root = UIAWrapper(hwnd).root
            field = root.EditControl(AutomationId="chat_input_field", searchDepth=22)
            if not field.Exists(maxSearchSeconds=2):
                raise UiaSendError("configured chat input field is unavailable")
            require_selected_target(field.Name, target_name)
            value = field.GetValuePattern()
            if value is None or value.IsReadOnly or not field.IsEnabled:
                raise UiaSendError("configured chat input does not support safe value setting")
            if value.Value != "":
                raise UiaSendError("chat input already contains a draft")
            value.SetValue(text, waitTime=0.2)
            if value.Value != text:
                raise UiaSendError("UIA did not preserve the exact draft text")
            return value, not automation.AutoSetFocus
        except UiaSendError:
            raise
        except Exception as exc:
            raise UiaSendError("chat input could not be accessed without focus") from exc


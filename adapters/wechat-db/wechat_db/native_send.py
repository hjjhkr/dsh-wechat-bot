"""Send through the selected native chat HWND, retaining the legacy receipt contract."""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import time


class NativeSendError(RuntimeError):
    def __init__(self, message, reason_code="uia_draft", send_attempted=False):
        super().__init__(message)
        self.reason_code, self.send_attempted = reason_code, send_attempted


class NativeUISender:
    def __init__(self, config, binding, require_monitor):
        self.config, self.binding, self.require_monitor = config, binding, require_monitor

    @staticmethod
    def _set_draft(hwnd, text):
        from dsh_wechat_bridge.uia_send import BackgroundUISender
        # Independent windows expose a generic input label. The account/target
        # remains the real configured group/private chat in Worker and runtime.
        return BackgroundUISender._set_exact_draft(hwnd, "输入", text)

    @staticmethod
    def _click_sender(hwnd, before_click):
        from dsh_wechat_bridge.isolated_send import live_click_plan
        from wx4py.core.uia_wrapper import UIAWrapper
        root = UIAWrapper(hwnd).root
        button = root.ButtonControl(Name="发送", searchDepth=22)
        if not button.Exists(maxSearchSeconds=2):
            raise NativeSendError("native send button is unavailable")
        user = ctypes.WinDLL("user32", use_last_error=True)
        packed = live_click_plan(user, hwnd, button)
        user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user.PostMessageW.restype = wintypes.BOOL
        before_click()
        for message, wp in ((0x200, 0), (0x201, 1), (0x202, 0)):
            if not user.PostMessageW(hwnd, message, wp, packed):
                raise NativeSendError("native send click could not be queued", "send_unknown", True)

    def send(self, text, target_name, gate):
        attempted = False
        value = None
        def action(active):
            nonlocal attempted, value
            try:
                self.require_monitor()
                active()
                value, auto_focus_off = self._set_draft(self.binding["hwnd"], text)
                if auto_focus_off is not True or value.Value != text:
                    raise NativeSendError("exact native draft preparation failed")
                def before_click():
                    nonlocal attempted
                    active()
                    self.require_monitor()
                    if value.Value != text:
                        raise NativeSendError("native draft changed before commit")
                    # The host and Worker have already persisted attempt markers.
                    attempted = True
                self._click_sender(self.binding["hwnd"], before_click)
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline and value.Value == text:
                    active()
                    self.require_monitor()
                    time.sleep(.1)
                if value.Value != "":
                    raise NativeSendError("native draft did not clear", "send_unknown", True)
                self.require_monitor()
                return {"sendAttempted": True, "noBotFocusObserved": True}
            except Exception as error:
                # Only remove this exact uncommitted draft. An uncertain click
                # is never retried or followed by further draft manipulation.
                if not attempted and value is not None:
                    try:
                        if value.Value == text:
                            value.SetValue("", waitTime=.2)
                    except Exception:
                        pass
                raise NativeSendError("native send failed", getattr(error, "reason_code", "uia_draft"), attempted) from error
        return gate.run(action)


def _outcome(reason, attempted, state):
    return {"status": "ambiguous", "reasonCode": reason, "sendAttempted": attempted,
            "gateActive": state.get("gateActive"), "gateRestored": state.get("gateRestored") is True}


def send_on_desktop(runtime, config, session, params, *, sender_factory=NativeUISender, receipt_lookup=None):
    """Legacy-compatible UI action and exact database confirmation on the UI thread."""
    runtime.verify(config, session)
    runtime.require_monitor()
    if (params.get("enableSend") is not True or params.get("allowTemporaryGate") is not True
            or params.get("target") != config["targetWxid"]
            or params.get("expectedSelfId") != config["botWxid"]):
        raise NativeSendError("native send scope or permissions do not match", "gate_preflight")
    text = params["text"]
    restored = {"gateActive": False, "gateRestored": True}
    try:
        latest = runtime._db.get_messages(config["targetWxid"], limit=1)
        since = latest[0]["sort_seq"] if latest else 0
        if type(since) is not int or since < 0:
            raise ValueError("invalid database send cursor")
    except Exception:
        return _outcome("db_verify", False, restored)
    started = time.time()
    try:
        gate = runtime.make_native_gate(config, session)
    except Exception:
        return _outcome("gate_preflight", False, restored)
    runtime._gate = gate
    error = None
    ui_result = {}
    try:
        ui_result, restored = sender_factory(config, runtime._binding, runtime.require_monitor).send(
            text, config["targetName"], gate)
    except Exception as caught:
        error = caught
    finally:
        try:
            restored = gate.close()
        except Exception:
            restored = {"gateActive": None, "gateRestored": False}
        if restored.get("gateActive") is False and restored.get("gateRestored") is True:
            runtime._gate = None
    attempted = getattr(error, "send_attempted", None) if error else ui_result.get("sendAttempted")
    attempted = attempted if type(attempted) is bool else None
    if restored.get("gateActive") is not False or restored.get("gateRestored") is not True:
        return _outcome("gate_restore", attempted, restored)
    if error is not None:
        reason = getattr(error, "reason_code", "send_unknown")
        if reason not in {"uia_draft", "send_unknown", "gate_preflight", "gate_restore", "foreground_guard", "monitor_start", "desktop_unavailable"}:
            reason = "send_unknown"
        return _outcome(reason, attempted, restored)
    if attempted is not True or ui_result.get("noBotFocusObserved") is not True:
        return _outcome("foreground_guard", attempted, restored)
    if receipt_lookup is None:
        from dsh_wechat_bridge.runtime import match_outgoing_row
        receipt_lookup = match_outgoing_row
    deadline = time.monotonic() + 4
    try:
        while time.monotonic() < deadline:
            runtime.verify(config, session)
            outgoing = receipt_lookup(runtime._db, config["targetWxid"], config["botWxid"], text, since, started)
            if outgoing is not None:
                return {"status": "confirmed", "outgoing": outgoing, "sendAttempted": True,
                        "gateActive": False, "gateRestored": True}
            time.sleep(.15)
    except Exception:
        return _outcome("db_verify", True, restored)
    return _outcome("db_verify", True, restored)

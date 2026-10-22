"""Prepare one native WeChat chat window with account-scoped, targeted input."""
from __future__ import annotations

import ctypes
from ctypes import wintypes
import json
from pathlib import Path
import re
import threading
import time
import uuid


_HEADER_ID = (
    "content_view.top_content_view.title_h_view.left_v_view."
    "left_content_v_view.left_ui_.big_title_line_h_view"
)


def native_header_matches(actual, name, kind):
    if actual == name:
        return True
    return kind == "group" and re.fullmatch(re.escape(name) + r"\([0-9]+\)", actual) is not None


def prepare_surface(surface, active):
    """Reuse an unambiguous window, or select and double-click exactly once."""
    active()
    windows = surface.candidates()
    reused = bool(windows)
    if len(windows) > 1:
        raise RuntimeError("independent chat window is ambiguous")
    if not windows:
        surface.select(active)
        active()
        surface.double_click(active)
        deadline = time.monotonic() + 6
        while True:
            active()
            windows = surface.candidates()
            if windows:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("native double-click did not open the target window")
            time.sleep(0.1)
    if len(windows) != 1:
        raise RuntimeError("independent chat window is ambiguous")
    surface.inspect(windows[0])
    active()
    return {"window": windows[0], "reused": reused}


class _WindowsSurface:
    def __init__(self, config, binding, check):
        import comtypes.client
        from wx4py.core import uiautomation as ui
        from wx4py.core.uia_wrapper import UIAWrapper

        self.ui, self.wrapper = ui, UIAWrapper
        self.config, self.binding, self.check = config, binding, check
        client = ui._AutomationClient.instance()
        automation = comtypes.client.CreateObject(
            client.UIAutomationCore.CUIAutomation8,
            interface=client.UIAutomationCore.IUIAutomation2,
        )
        automation.AutoSetFocus = False
        automation.ConnectionTimeout = automation.TransactionTimeout = 2000
        client.IUIAutomation, client.ViewWalker = automation, automation.RawViewWalker
        self.root = UIAWrapper(binding["hwnd"]).root

    def candidates(self):
        from dsh_wechat_bridge.process import _window_records
        return [row for row in _window_records(self.binding["pid"])
                if row["hwnd"] != self.binding["hwnd"]
                and row["visible"] and row["ownerHwnd"] == 0
                and row["captionStyle"] and not row["toolWindow"]
                and row["className"] == self.config["mainWindowClass"]
                and row["title"] == self.config["targetName"]]

    def _field(self, root):
        return root.EditControl(AutomationId="chat_input_field", searchDepth=22)

    def _row(self, active):
        choices = []
        started = time.monotonic()
        for index, (control, _) in enumerate(self.ui.WalkControl(self.root, maxDepth=22)):
            if index > 500 or time.monotonic() - started > 8:
                raise RuntimeError("target session scan deadline")
            if index % 10 == 0:
                active()
            if (control.ControlType == self.ui.ControlType.ListItemControl
                    and control.Name.split("\n")[0] == self.config["targetName"]):
                choices.append(control)
        if len(choices) != 1:
            raise RuntimeError("one exact visible target session is required")
        return choices[0]

    def _post(self, row, messages, active):
        from dsh_wechat_bridge.isolated_send import live_click_plan
        user = ctypes.WinDLL("user32", use_last_error=True)
        packed = live_click_plan(user, self.binding["hwnd"], row, expected_name=row.Name)
        user.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
        user.PostMessageW.restype = wintypes.BOOL
        active()
        for message, wp in messages:
            if not user.PostMessageW(self.binding["hwnd"], message, wp, packed):
                raise RuntimeError("targeted session input was rejected")

    def select(self, active):
        field = self._field(self.root)
        exists = field.Exists(maxSearchSeconds=2)
        if exists and field.GetValuePattern().Value != "":
            raise RuntimeError("existing main-window draft must be preserved")
        if not exists or field.Name != self.config["targetName"]:
            self._post(self._row(active), ((0x200, 0), (0x201, 1), (0x202, 0)), active)
            time.sleep(0.4)
            field = self._field(self.root)
        if (not field.Exists(maxSearchSeconds=2) or field.Name != self.config["targetName"]
                or field.GetValuePattern().Value != ""):
            raise RuntimeError("selected target and empty draft did not verify")

    def double_click(self, active):
        # WM_* targets the already verified bot HWND; no system pointer is moved.
        self._post(self._row(active),
                   ((0x200, 0), (0x201, 1), (0x202, 0), (0x203, 1), (0x202, 0)), active)

    def inspect(self, window):
        self.check()
        root = self.wrapper(window["hwnd"]).root
        header = root.TextControl(AutomationId=_HEADER_ID, searchDepth=22)
        field = self._field(root)
        if (not header.Exists(maxSearchSeconds=2)
                or not native_header_matches(header.Name, self.config["targetName"], self.config["conversationType"])
                or not field.Exists(maxSearchSeconds=2) or field.Name != "输入"
                or field.GetValuePattern().Value != ""):
            raise RuntimeError("native chat header/input/draft did not verify")


def prepare_on_desktop(runtime, config, session, monitor, cancelled=lambda: False):
    """Called only by the native worker's serialized hidden-desktop executor."""
    from dsh_wechat_bridge.conversations import catalog
    if cancelled():
        raise RuntimeError("native preparation was cancelled")
    runtime.verify(config, session)
    matches = [row for row in catalog(runtime._db, config["botWxid"])
               if row["name"] == config["targetName"]]
    if len(matches) != 1 or matches[0]["id"] != config["targetWxid"]:
        raise RuntimeError("target display name does not map to one configured contact")
    runtime.monitor = monitor
    runtime.require_monitor()
    gate = runtime._gate = runtime.make_native_gate(config, session)
    try:
        def action(assert_active):
            def check():
                if cancelled():
                    raise RuntimeError("native preparation was cancelled")
                assert_active()
                runtime.require_monitor()
            surface = _WindowsSurface(config, session["binding"], check)
            prepared = prepare_surface(surface, check)
            window = prepared["window"]
            binding = {**session["binding"], "hwnd": window["hwnd"],
                       "mainWindowClass": window["className"], "mainWindowTitle": window["title"]}
            return {"opened": True, "binding": binding, "reused": prepared["reused"]}
        result, restored = gate.run(action)
        return {**result, **restored}
    finally:
        # An unconfirmed gate stays owned by runtime.close(); never hide it.
        state = gate.close()
        if state.get("gateActive") is False and state.get("gateRestored") is True:
            runtime._gate = None
        runtime.monitor = None


class DetachedWindowPreparer:
    """Short-lived worker controller; closing resources leaves native chat open."""
    def __init__(self, command, args, worker, self_id):
        if worker.get("botWxid") != self_id:
            raise ValueError("prepared account must match adapter self")
        self.command = command
        self.worker = json.loads(json.dumps(worker))
        self.args = [str(Path(__file__).with_name("native_window_worker.py").resolve()),
                     "--legacy-root", str(Path(args[0]).resolve().parent)]
        self._child = None
        self._closed = False
        self._lock = threading.RLock()

    def prepare(self, cancel_event):
        from .legacy_sender import _JsonlChild
        with self._lock:
            if self._closed or cancel_event.is_set():
                raise RuntimeError("native preparation was cancelled")
            marker = Path(self.worker["stateRoot"]) / "window-preparations" / (uuid.uuid4().hex + ".cancel")
            marker.parent.mkdir(parents=True, exist_ok=True)
            finished = threading.Event()
            def observe_cancel():
                while not finished.wait(0.05):
                    if cancel_event.is_set():
                        try:
                            with marker.open("x", encoding="ascii") as stream:
                                stream.write("cancel\n")
                        except FileExistsError:
                            pass
                        return
            observer = threading.Thread(target=observe_cancel, daemon=True)
            observer.start()
            self._child = _JsonlChild(self.command, self.args)
            try:
                self._child.start()
                frame = self._child.request("prepareWindow", {"config": self.worker, "cancelPath": str(marker)}, 65)
                result = frame.get("result")
                if (not isinstance(result, dict) or result.get("gateActive") is not False
                        or result.get("gateRestored") is not True or result.get("opened") is not True):
                    raise RuntimeError("native window preparation failed")
                if cancel_event.is_set():
                    raise RuntimeError("native preparation was cancelled")
                return result
            finally:
                finished.set()
                observer.join(1)
                if self._child.close_normally(5):
                    self._child = None
                    marker.unlink(missing_ok=True)
                else:
                    raise RuntimeError("native preparation cleanup is unconfirmed")

    def close(self):
        with self._lock:
            self._closed = True
            if self._child is not None:
                if not self._child.close_normally(5):
                    return False
                self._child = None
            return True

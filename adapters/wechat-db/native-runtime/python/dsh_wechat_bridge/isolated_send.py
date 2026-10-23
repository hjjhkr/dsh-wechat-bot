"""UIA draft and live HWND-relative click, exclusively on an isolated desktop."""
import ctypes
from ctypes import wintypes
import time

from .uia_send import BackgroundUISender, UiaSendError, require_selected_target


def pack_point(x, y, width, height):
    if not (0 <= x < width and 0 <= y < height and x <= 32767 and y <= 32767):
        raise UiaSendError("send button outside window client")
    return (y << 16) | x


def live_click_plan(user32, hwnd, button, expected_name="发送"):
    user32.SetThreadDpiAwarenessContext.argtypes = [wintypes.HANDLE]
    user32.SetThreadDpiAwarenessContext.restype = wintypes.HANDLE
    user32.ScreenToClient.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
    user32.ScreenToClient.restype = wintypes.BOOL
    user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetClientRect.restype = wintypes.BOOL
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsIconic.argtypes = [wintypes.HWND]
    old_context = user32.SetThreadDpiAwarenessContext(-4)
    if not old_context:
        raise UiaSendError("thread DPI context unavailable")
    try:
        if not user32.IsWindowVisible(hwnd) or user32.IsIconic(hwnd):
            raise UiaSendError("isolated main window must remain open")
        if button.Name != expected_name or not button.IsEnabled or button.IsOffscreen:
            raise UiaSendError("send button unavailable")
        bounds = button.BoundingRectangle
        if bounds.right <= bounds.left or bounds.bottom <= bounds.top:
            raise UiaSendError("send button geometry invalid")
        point = wintypes.POINT((bounds.left + bounds.right) // 2, (bounds.top + bounds.bottom) // 2)
        if not user32.ScreenToClient(hwnd, ctypes.byref(point)):
            raise UiaSendError("screen to client conversion failed")
        client = wintypes.RECT()
        if not user32.GetClientRect(hwnd, ctypes.byref(client)):
            raise UiaSendError("client rectangle unavailable")
        return pack_point(point.x, point.y, client.right, client.bottom)
    finally:
        if not user32.SetThreadDpiAwarenessContext(old_context):
            raise UiaSendError("thread DPI context restoration failed")


class IsolatedUISender:
    def __init__(self, config, binding, require_monitor):
        self.config, self.binding, self.require_monitor = config, binding, require_monitor

    def send(self, text, target_name, gate):
        hwnd = self.binding["hwnd"]
        attempted = False

        def action(assert_active):
            nonlocal attempted
            try:
                self.require_monitor()
                assert_active()
                value, auto_focus_off = BackgroundUISender._set_exact_draft(hwnd, target_name, text)
                if auto_focus_off is not True or value.Value != text:
                    raise UiaSendError("exact draft preparation failed")
                from wx4py.core.uia_wrapper import UIAWrapper
                root = UIAWrapper(hwnd).root
                button = root.ButtonControl(Name="发送", searchDepth=22)
                if not button.Exists(maxSearchSeconds=2):
                    raise UiaSendError("send button missing")
                require_selected_target(root.EditControl(AutomationId="chat_input_field", searchDepth=22).Name, target_name)
                user32 = ctypes.WinDLL("user32", use_last_error=True)
                packed = live_click_plan(user32, hwnd, button)
                assert_active()
                self.require_monitor()
                if value.Value != text:
                    raise UiaSendError("draft changed before click")
                user32.PostMessageW.argtypes = [wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM]
                user32.PostMessageW.restype = wintypes.BOOL
                # Existing host and Worker attempt markers already forbid retries.
                attempted = True
                for message, wparam in ((0x0200, 0), (0x0201, 1), (0x0202, 0)):
                    if not user32.PostMessageW(hwnd, message, wparam, packed):
                        raise UiaSendError("targeted click rejected", "send_unknown", True)
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline and value.Value == text:
                    assert_active()
                    time.sleep(0.1)
                self.require_monitor()
                if value.Value != "":
                    raise UiaSendError("draft did not clear after single click", "send_unknown", True)
                # This is provisional; the Default controller independently checks
                # its full monitor history after the DB confirmation returns.
                return {"sendAttempted": True, "noBotFocusObserved": True}
            except Exception as exc:
                raise UiaSendError("isolated send failed", getattr(exc, "reason_code", "send_unknown"), attempted) from exc

        return gate.run(action)

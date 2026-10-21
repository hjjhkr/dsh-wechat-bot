import sys
import types
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PLUGIN_ROOT / "python"))

from dsh_wechat_bridge.uia_send import BackgroundUISender, UiaSendError, _FocusMonitor, require_selected_target, return_key_lparams  # noqa: E402


class UiaSendContractTests(unittest.TestCase):
    def test_only_exact_already_selected_target_is_accepted(self):
        require_selected_target("USER_OWNER", "USER_OWNER")
        with self.assertRaises(UiaSendError):
            require_selected_target("另一个联系人", "USER_OWNER")
        with self.assertRaises(UiaSendError):
            require_selected_target("", "USER_OWNER")

    def test_return_message_parameters_match_verified_scan_code(self):
        self.assertEqual(return_key_lparams(0x1C), (0x001C0001, 0xC01C0001))
        with self.assertRaises(UiaSendError):
            return_key_lparams(0)

    def test_com_bool_integer_zero_means_autofocus_is_disabled(self):
        class ValuePattern:
            Value = ""
            IsReadOnly = False

            def SetValue(self, value, waitTime=0):
                self.Value = value

        class Field:
            Name = "USER_OWNER"
            IsEnabled = True

            def Exists(self, **_kwargs):
                return True

            def GetValuePattern(self):
                return ValuePattern()

        class Automation:
            RawViewWalker = object()

            def __init__(self, value):
                self.com_value = value

            @property
            def AutoSetFocus(self):
                return self.com_value

            @AutoSetFocus.setter
            def AutoSetFocus(self, _value):
                # COM BOOL properties can read back as Python int 0/1.
                pass

        class AutomationClient:
            UIAutomationCore = types.SimpleNamespace(
                CUIAutomation8=object(), IUIAutomation2=object()
            )

            def __init__(self, automation):
                self.automation = automation

            def instance(self):
                return self

        class Wrapper:
            def __init__(self, _hwnd):
                self.root = self

            def EditControl(self, **_kwargs):
                return Field()

        for com_value, expected in ((0, True), (1, False)):
            with self.subTest(com_value=com_value):
                automation = Automation(com_value)
                client = AutomationClient(automation)
                comtypes = types.ModuleType("comtypes")
                comtypes.__path__ = []
                comtypes_client = types.ModuleType("comtypes.client")
                comtypes_client.CreateObject = lambda *_args, automation=automation, **_kwargs: automation
                comtypes.client = comtypes_client

                wx4py = types.ModuleType("wx4py")
                wx4py.__path__ = []
                wx4py_core = types.ModuleType("wx4py.core")
                wx4py_core.__path__ = []
                uiautomation = types.ModuleType("wx4py.core.uiautomation")
                uiautomation._AutomationClient = types.SimpleNamespace(instance=lambda: client)
                wx4py_core.uiautomation = uiautomation
                wx4py.core = wx4py_core
                uia_wrapper = types.ModuleType("wx4py.core.uia_wrapper")
                uia_wrapper.UIAWrapper = Wrapper

                modules = {
                    "comtypes": comtypes,
                    "comtypes.client": comtypes_client,
                    "wx4py": wx4py,
                    "wx4py.core": wx4py_core,
                    "wx4py.core.uiautomation": uiautomation,
                    "wx4py.core.uia_wrapper": uia_wrapper,
                }
                with patch.dict(sys.modules, modules):
                    _value, automation_enabled = BackgroundUISender._set_exact_draft(
                        777, "USER_OWNER", "hello"
                    )

                self.assertIs(automation_enabled, expected)

    def test_send_posts_only_to_bound_hwnd_and_keeps_focus_unchanged(self):
        monitors = []
        events = []

        class ApiFunction:
            def __init__(self, fn):
                self.fn = fn
            def __call__(self, *args):
                return self.fn(*args)

        class User32:
            def __init__(self):
                self.posts = []
                self.PostMessageW = ApiFunction(lambda *args: self.posts.append(args) or 1)
                self.MapVirtualKeyW = ApiFunction(lambda *_args: 0x1C)

        class Monitor:
            def __init__(self, pid):
                self.user32 = User32()
                monitors.append(self)
                self.events = []
                self.foregrounds = [100]
                self.errors = []
            def start(self):
                pass
            def foreground(self):
                return 100
            def owner(self, _hwnd):
                return 9
            def safe(self, _before, _initial_owner):
                return True
            def close(self):
                pass

        class Gate:
            def run(self, action):
                events.append("gate_enter")
                value = action(lambda: None)
                events.append("gate_exit")
                return value, {"gateActive": False, "gateRestored": True}

        config = {"targetName": "USER_OWNER"}
        binding = {"pid": 42, "hwnd": 777}
        sender = BackgroundUISender(config, binding)
        value = type("Value", (), {"Value": ""})()
        def set_draft(*_args):
            events.append("draft")
            return value, True
        with patch("dsh_wechat_bridge.uia_send._FocusMonitor", Monitor), patch.object(
            BackgroundUISender, "_set_exact_draft", side_effect=set_draft
        ):
            result, gate_state = sender.send("hello", "USER_OWNER", Gate())

        self.assertEqual(gate_state, {"gateActive": False, "gateRestored": True})
        self.assertTrue(result["noBotFocusObserved"])
        self.assertEqual(events, ["gate_enter", "draft", "gate_exit"])
        posts = monitors[0].user32.posts
        self.assertEqual([post[0] for post in posts], [777, 777])
        self.assertEqual([post[1] for post in posts], [0x0100, 0x0101])

    def test_monitor_allows_switches_between_non_bot_foreground_windows(self):
        monitor = object.__new__(_FocusMonitor)
        monitor._sample_lock = threading.Lock()
        monitor.pid = 42
        monitor.events = []
        monitor.foregrounds = [100, 200, 300]
        monitor.foreground_owners = [9, 10, 9]
        monitor.errors = []
        monitor.foreground = lambda: 300
        owners = {100: 9, 200: 10, 300: 9}
        monitor.owner = lambda hwnd: owners.get(hwnd, 0)

        self.assertTrue(monitor.safe(100, 9))

    def test_monitor_never_publishes_half_a_sample_while_resolving_window_owner(self):
        monitor = object.__new__(_FocusMonitor)
        monitor.pid, monitor.errors, monitor.events = 42, [], []
        monitor.foregrounds, monitor.foreground_owners = [100], [9]
        monitor._sample_lock = threading.Lock()
        monitor.ready, monitor.stop = threading.Event(), threading.Event()
        entered, release = threading.Event(), threading.Event()
        monitor.user32 = types.SimpleNamespace(
            SetWinEventHook=lambda *_: 1, UnhookWinEvent=lambda *_: 1,
            PeekMessageW=lambda *_: 0)
        monitor.foreground = lambda: 200

        def owner(_hwnd):
            if threading.current_thread().name == "test-focus-sampler":
                entered.set()
                if not release.wait(2):
                    raise TimeoutError("test sample release")
                monitor.stop.set()
            return 9
        monitor.owner = owner
        sampler = threading.Thread(target=monitor._run, name="test-focus-sampler")
        sampler.start()
        try:
            self.assertTrue(entered.wait(2))
            # There is no bot focus or missing owner: a second thread is merely
            # between querying the HWND and resolving its owning process.
            self.assertTrue(monitor.safe(100, 9))
        finally:
            release.set()
            sampler.join(2)
        self.assertFalse(sampler.is_alive())
        self.assertEqual(monitor.errors, [])

    def test_isolated_monitor_allows_one_null_sample_but_no_unknown_window_or_bot_focus(self):
        monitor = object.__new__(_FocusMonitor)
        monitor._sample_lock = threading.Lock()
        monitor.pid, monitor.events, monitor.errors = 42, [], []
        monitor.foreground = lambda: 100
        monitor.owner = lambda hwnd: {100: 9, 777: 42}.get(hwnd, 0)
        for foregrounds, owners, allowed in (
            ([100, 0, 100], [9, 0, 9], True),
            ([100, 0, 0, 100], [9, 0, 0, 9], False),
            ([100, 123, 100], [9, 0, 9], False),
            ([100, 777, 100], [9, 42, 9], False),
        ):
            monitor.foregrounds, monitor.foreground_owners = foregrounds, owners
            self.assertIs(monitor.safe(100, 9, allow_transient_zero=True), allowed)
        monitor.foregrounds, monitor.foreground_owners = [100, 0, 100], [9, 0, 9]
        monitor.errors = ["hook_failed"]
        self.assertFalse(monitor.safe(100, 9, allow_transient_zero=True))

    def test_monitor_records_only_bot_owned_focus_events_and_rejects_bot_focus(self):
        monitor = object.__new__(_FocusMonitor)
        monitor._sample_lock = threading.Lock()
        monitor.pid = 42
        monitor.events = []
        monitor.foregrounds = [100, 200, 100]
        monitor.foreground_owners = [9, 10, 9]
        monitor.errors = []
        monitor.foreground = lambda: 100
        owners = {100: 9, 200: 10, 777: 42}
        monitor.owner = lambda hwnd: owners.get(hwnd, 0)

        monitor._record_focus_event(3, 200)
        self.assertEqual(monitor.events, [])
        monitor._record_focus_event(0x8005, 777)
        self.assertEqual(monitor.events, [{"event": 0x8005, "hwnd": 777, "owner": 42}])
        self.assertFalse(monitor.safe(100, 9))

    def test_monitor_fails_closed_when_focus_event_owner_is_unknown(self):
        monitor = object.__new__(_FocusMonitor)
        monitor._sample_lock = threading.Lock()
        monitor.pid = 42
        monitor.events = []
        monitor.foregrounds = [100]
        monitor.foreground_owners = [9]
        monitor.errors = []
        monitor.foreground = lambda: 100
        monitor.owner = lambda _hwnd: 0

        monitor._record_focus_event(0x8005, 777)

        self.assertTrue(monitor.errors)
        self.assertFalse(monitor.safe(100, 9))

    def test_monitor_fails_closed_when_current_or_sampled_foreground_is_unknown(self):
        for current, foregrounds, owners in ((0, [100], [9]), (100, [100, 0], [9, 0])):
            monitor = object.__new__(_FocusMonitor)
            monitor._sample_lock = threading.Lock()
            monitor.pid = 42
            monitor.events = []
            monitor.foregrounds = foregrounds
            monitor.foreground_owners = owners
            monitor.errors = []
            monitor.foreground = lambda current=current: current
            owner_map = {100: 9, 0: 0}
            monitor.owner = lambda hwnd, owner_map=owner_map: owner_map.get(hwnd, 0)
            self.assertFalse(monitor.safe(100, 9))

    def test_invalid_captured_owner_is_never_repaired_by_later_hwnd_reuse(self):
        monitor = object.__new__(_FocusMonitor)
        monitor._sample_lock = threading.Lock()
        monitor.pid, monitor.errors, monitor.events = 42, [], []
        monitor.foregrounds, monitor.foreground_owners = [100], [9]
        monitor.foreground = lambda: 100
        monitor.owner = lambda _hwnd: 9
        for captured_owner in (0, 42):
            with self.subTest(captured_owner=captured_owner):
                self.assertFalse(monitor.safe(100, captured_owner))



if __name__ == "__main__":
    unittest.main()

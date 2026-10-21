import sys
import unittest
import tempfile
import io
from types import SimpleNamespace
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))

from dsh_wechat_bridge.desktop import require_window_desktop, validate_desktop
from dsh_wechat_bridge.isolated import IsolatedRuntime, IsolatedWindowsRuntime, MonitorLease, validate_monitor_lease
from dsh_wechat_bridge.isolated_send import IsolatedUISender, live_click_plan, pack_point
from dsh_wechat_bridge.uia_send import UiaSendError
import test_worker


DESKTOP = "DshWeChatBot_test"
BINDING = {"pid": 42, "processStartedAt": 100.0}
GOOD = {"nonce": "a" * 32, "botPid": 42, "botStartedAt": 100.0,
        "desktop": DESKTOP, "at": 999.0, "safe": True}


class LeaseTests(unittest.TestCase):
    def test_live_lease_reader_allows_atomic_publisher_and_then_observes_revocation(self):
        with tempfile.TemporaryDirectory() as root:
            config = {"desktopName": DESKTOP, "stateRoot": root}
            lease = MonitorLease(config, BINDING)
            runtime = IsolatedWindowsRuntime(DESKTOP)
            runtime._config, runtime._binding = config, BINDING
            runtime.monitor = {"path": str(lease.path), "nonce": lease.nonce}
            lease._publish(True)
            real_open = io.open
            publish_during_read = True

            def overlapping_reader(file, *args, **kwargs):
                nonlocal publish_during_read
                stream = real_open(file, *args, **kwargs)
                if publish_during_read and Path(file) == lease.path:
                    publish_during_read = False
                    try:
                        lease._publish(True)  # Writer overlaps the real open reader.
                    except BaseException:
                        stream.close()
                        raise
                return stream

            try:
                with patch.object(runtime, "require_desktop"), \
                     patch("dsh_wechat_bridge.isolated.input_desktop_name", return_value="Default"), \
                     patch("io.open", side_effect=overlapping_reader):
                    self.assertTrue(runtime.require_monitor())
                    lease._publish(False)
                    with self.assertRaises(UiaSendError):
                        runtime.require_monitor()
            finally:
                lease.remove()

    def test_closing_initial_non_bot_window_does_not_revoke_live_monitor(self):
        with tempfile.TemporaryDirectory() as root:
            lease = MonitorLease({"desktopName": DESKTOP, "stateRoot": root}, BINDING)
            monitor = lease.monitor
            owners = {100: 9, 200: 10}
            monitor.start = lambda: None
            monitor.foreground = lambda: 100
            monitor.owner = lambda hwnd: owners.get(hwnd, 0)
            monitor.foregrounds, monitor.foreground_owners = [100], [9]
            with patch("dsh_wechat_bridge.isolated.desktop_names", return_value=("Default", "Default")), \
                 patch("dsh_wechat_bridge.isolated.desktop_available", return_value=True), \
                 patch("dsh_wechat_bridge.isolated.require_window_desktop"):
                try:
                    lease.start()
                    monitor.foreground = lambda: 200
                    with monitor._sample_lock:
                        monitor.foregrounds.append(200)
                        monitor.foreground_owners.append(10)
                    del owners[100]  # The original application's window has closed.
                    self.assertTrue(lease.safe(), "closing a prior non-bot window must not invalidate observed history")
                    self.assertEqual(lease.diagnostic()["failureReasons"], [])
                    # A real bot foreground is still rejected after the same close.
                    owners[200] = BINDING["pid"]
                    self.assertFalse(lease.safe())
                finally:
                    lease.close()
                    lease.remove()

    def test_stale_future_revoked_or_wrong_identity_never_authorizes(self):
        validate_monitor_lease(GOOD, nonce="a" * 32, binding=BINDING, desktop=DESKTOP, now=1000)
        for changed in ({"at": 997}, {"at": 1001}, {"safe": False}, {"botPid": 43},
                        {"botStartedAt": 200.0}, {"nonce": "b" * 32}, {"desktop": "Default"},
                        {"at": float("nan")}, {"at": "999"}):
            with self.subTest(changed=changed), self.assertRaises(UiaSendError):
                validate_monitor_lease({**GOOD, **changed}, nonce="a" * 32, binding=BINDING,
                                       desktop=DESKTOP, now=1000)

    def test_desktop_validation_rejects_default_and_paths(self):
        self.assertEqual(validate_desktop(DESKTOP), DESKTOP)
        for name in ("Default", None, "WinSta0\\Default", "../Default", "DshWeChatBot_"):
            with self.assertRaises(ValueError):
                validate_desktop(name)

    def test_click_coordinates_stay_inside_current_client_bounds(self):
        self.assertEqual(pack_point(12, 34, 100, 100), (34 << 16) | 12)
        for args in ((-1, 2, 10, 10), (10, 2, 10, 10), (2, 10, 10, 10), (40000, 2, 50000, 10)):
            with self.assertRaises(UiaSendError):
                pack_point(*args)


class FakeChild:
    def __init__(self, desktop):
        self.desktop, self.calls, self.closed = desktop, [], False
        self.outcome = {"status": "confirmed", "gateActive": False, "gateRestored": True,
                        "sendAttempted": True, "outgoing": {"serverId": "123"}}

    def alive(self):
        return not self.closed

    def request(self, method, params, **kwargs):
        self.calls.append((method, params))
        if method == "probe":
            return {"desktopName": self.desktop, "binding": BINDING, "selfId": "bot", "targetId": "user"}
        if method == "send":
            return self.outcome
        return {}

    def close(self):
        self.closed = True
        return {"closed": True, "gateActive": False, "gateRestored": True}


class FakeLease:
    allowed = True
    start_error = False

    def __init__(self, *_args):
        self.closed = self.removed = False

    def start(self):
        if self.start_error:
            raise RuntimeError("monitor unavailable")
        return {"nonce": "a" * 32}

    def close(self):
        self.closed = True

    def safe(self):
        return self.allowed

    def diagnostic(self):
        return {"safe": self.allowed, "monitorFailed": not self.allowed, "defaultDesktop": True,
                "samples": 10, "zeroForegrounds": 0, "unknownOwners": 0,
                "botForegrounds": 0, "botFocusEvents": 0, "errors": [],
                "failureReasons": [] if self.allowed else ["sample_owner_unavailable"]}

    def remove(self):
        self.removed = True


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.config = {"desktopName": DESKTOP}
        self.available = True
        self.runtime = IsolatedRuntime(child_factory=FakeChild, lease_factory=FakeLease,
                                       availability=lambda: self.available)
        self.session = self.runtime.probe(self.config)

    def test_default_focus_failure_overrides_confirmed_delivery_and_never_retries(self):
        with patch.object(FakeLease, "allowed", False):
            result = self.runtime.send(self.config, self.session, {"attemptId": "one"})
        self.assertEqual(result["status"], "ambiguous")
        self.assertEqual(result["reasonCode"], "foreground_guard")
        self.assertEqual(result["outgoing"]["serverId"], "123")
        self.assertEqual(result["focusDiagnostic"]["failureReasons"], ["sample_owner_unavailable"])
        self.assertEqual(len([x for x in self.runtime.child.calls if x[0] == "send"]), 1)

    def test_monitor_failure_prevents_any_send_rpc(self):
        with patch.object(FakeLease, "start_error", True):
            result = self.runtime.send(self.config, self.session, {})
        self.assertFalse(result["sendAttempted"])
        self.assertEqual(result["status"], "ambiguous")
        self.assertEqual(result["reasonCode"], "monitor_start")
        self.assertTrue(result["gateRestored"])
        self.assertEqual([x[0] for x in self.runtime.child.calls], ["probe"])
        availability = iter((True, False))
        self.runtime.availability = lambda: next(availability)
        with patch.object(FakeLease, "start_error", True):
            locked = self.runtime.send(self.config, self.session, {})
        self.assertEqual(locked["status"], "blocked")
        self.assertEqual(locked["reasonCode"], "desktop_unavailable")
        self.assertEqual([x[0] for x in self.runtime.child.calls], ["probe"])

    def test_locked_poll_continues_but_send_and_selection_wait_for_unlock(self):
        self.available = False
        polled = self.runtime.poll(self.config, self.session, {"sortSeq": 0}, 1, 100)
        self.assertIs(polled["desktopAvailable"], False)
        self.assertEqual(self.runtime.send(self.config, self.session, {})["status"], "blocked")
        self.assertFalse(self.runtime.select(self.config, self.session, {})["selected"])
        self.assertEqual([x[0] for x in self.runtime.child.calls], ["probe", "poll"])
        self.assertEqual(self.runtime.leases, [])
        self.available = True
        self.assertIs(self.runtime.poll(self.config, self.session, {"sortSeq": 0}, 1, 100)["desktopAvailable"], True)
        self.assertEqual(self.runtime.send(self.config, self.session, {})["status"], "confirmed")
        self.assertEqual([x[0] for x in self.runtime.child.calls].count("send"), 1)

    def test_child_reply_cannot_relabel_an_issued_send_as_retryable(self):
        self.runtime.child.outcome = {"status": "blocked", "reasonCode": "desktop_unavailable",
                                      "sendAttempted": False, "gateActive": False, "gateRestored": True}
        result = self.runtime.send(self.config, self.session, {})
        self.assertEqual(result["status"], "ambiguous")

    def test_unknown_child_result_is_ambiguous_and_revoked_lease_retained_until_close(self):
        original = self.runtime.child.request
        def fail_send(method, params, **kwargs):
            if method == "send":
                raise RuntimeError("pipe died")
            return original(method, params, **kwargs)
        self.runtime.child.request = fail_send
        result = self.runtime.send(self.config, self.session, {})
        self.assertEqual(result["status"], "ambiguous")
        self.assertIsNone(result["sendAttempted"])
        self.assertFalse(result["gateRestored"])
        lease = self.runtime.leases[0]
        self.assertTrue(lease.closed)
        self.assertFalse(lease.removed)
        self.runtime.close()
        self.assertTrue(lease.removed)

    def test_close_only_closes_worker_and_is_idempotent(self):
        child = self.runtime.child
        result = self.runtime.close()
        self.assertTrue(child.closed)
        self.assertEqual(self.runtime.close(), result)

    def test_dead_child_or_changed_scope_is_rejected_before_poll(self):
        self.runtime.child.closed = True
        with self.assertRaises(RuntimeError):
            self.runtime.poll(self.config, self.session, {"sortSeq": 0}, 1, 100)


class HiddenDesktopIdentityTests(unittest.TestCase):
    def setUp(self):
        self.config = {"desktopName": DESKTOP, "botWxid": "bot", "targetWxid": "user"}
        self.runtime = IsolatedWindowsRuntime(DESKTOP)
        self.runtime._config = self.config
        self.runtime._binding = {"pid": 42, "hwnd": 77}
        self.runtime._db = SimpleNamespace(get_new_messages=lambda *_args, **_kwargs: [])
        self.session = {"selfId": "bot"}

    def test_window_scope_resolves_actual_owner_thread_and_desktop(self):
        from unittest.mock import Mock
        owner_pid = 42
        def lookup(_hwnd, owner):
            owner._obj.value = owner_pid
            return 123
        api = SimpleNamespace(GetWindowThreadProcessId=Mock(side_effect=lookup),
                              GetThreadDesktop=Mock(return_value=456),
                              OpenDesktopW=Mock(return_value=456), CloseDesktop=Mock(return_value=True),
                              EnumDesktopWindows=Mock(side_effect=lambda _h, callback, _p: callback(77, 0)))
        with patch("dsh_wechat_bridge.desktop._desktop_api", return_value=api), \
             patch("dsh_wechat_bridge.desktop._desktop_name", return_value=DESKTOP) as name:
            require_window_desktop(self.runtime._binding, DESKTOP)
            name.return_value = "Default"
            with self.assertRaises(RuntimeError):
                require_window_desktop(self.runtime._binding, DESKTOP)
            name.return_value, owner_pid = DESKTOP, 43
            with self.assertRaises(RuntimeError):
                require_window_desktop(self.runtime._binding, DESKTOP)

    def test_controller_can_validate_hidden_hwnd_only_after_named_desktop_enumeration(self):
        # Live Default -> hidden HWND lookup returned ERROR_INVALID_WINDOW_HANDLE
        # until EnumDesktopWindows registered it in the controller's view.
        from unittest.mock import Mock
        opened = False
        enumerated = False
        def open_desktop(*_args):
            nonlocal opened
            opened = True
            return 456
        def close_desktop(_handle):
            nonlocal opened
            opened = False
            return True
        def lookup(_hwnd, owner):
            if not opened or not enumerated:
                return 0
            owner._obj.value = 42
            return 123
        def enumerate_windows(_handle, callback, _param):
            nonlocal enumerated
            if not opened:
                return False
            enumerated = True
            return callback(77, 0)
        api = SimpleNamespace(OpenDesktopW=Mock(side_effect=open_desktop),
            CloseDesktop=Mock(side_effect=close_desktop),
            EnumDesktopWindows=Mock(side_effect=enumerate_windows),
            GetWindowThreadProcessId=Mock(side_effect=lookup), GetThreadDesktop=Mock(return_value=456))
        with patch('dsh_wechat_bridge.desktop._desktop_api', return_value=api), \
             patch('dsh_wechat_bridge.desktop._desktop_name', return_value=DESKTOP):
            require_window_desktop(self.runtime._binding, DESKTOP)
        self.assertFalse(opened, 'the temporary desktop handle must be released')

    def test_read_verifies_hidden_window_without_opening_input_desktop(self):
        with patch("dsh_wechat_bridge.isolated.thread_desktop_name", return_value=DESKTOP), \
             patch("dsh_wechat_bridge.isolated.require_window_desktop") as window, \
             patch("dsh_wechat_bridge.runtime.verify_account_binding"), \
             patch("dsh_wechat_bridge.isolated.input_desktop_name", side_effect=AssertionError("read touched input")):
            result = self.runtime.poll(self.config, self.session, {"sortSeq": 0}, 1, 100)
        self.assertEqual(result["messages"], [])
        window.assert_called_with(self.runtime._binding, DESKTOP)

    def test_wrong_window_desktop_blocks_reads_and_sends(self):
        with patch("dsh_wechat_bridge.isolated.thread_desktop_name", return_value=DESKTOP), \
             patch("dsh_wechat_bridge.isolated.require_window_desktop", side_effect=RuntimeError("wrong desktop")), \
             patch.object(self.runtime._db, "get_new_messages") as read:
            with self.assertRaises(RuntimeError):
                self.runtime.poll(self.config, self.session, {"sortSeq": 0}, 1, 100)
            with self.assertRaises(RuntimeError):
                self.runtime.send(self.config, self.session, {})
        read.assert_not_called()

    def test_transient_zero_permission_requires_verified_hidden_window(self):
        lease = object.__new__(MonitorLease)
        lease.failed, lease.binding, lease.desktop, lease.before = False, self.runtime._binding, DESKTOP, 100
        lease.before_owner = 9
        from unittest.mock import Mock
        lease.monitor = SimpleNamespace(safe=Mock(return_value=True))
        with patch("dsh_wechat_bridge.isolated.desktop_available", return_value=True), \
             patch("dsh_wechat_bridge.isolated.require_window_desktop") as window:
            self.assertTrue(lease.safe())
        window.assert_called_once_with(self.runtime._binding, DESKTOP)
        lease.monitor.safe.assert_called_once_with(100, 9, allow_transient_zero=True)
        lease.monitor.safe.reset_mock()
        with patch("dsh_wechat_bridge.isolated.desktop_available", return_value=True), \
             patch("dsh_wechat_bridge.isolated.require_window_desktop", side_effect=RuntimeError("wrong desktop")):
            self.assertFalse(lease.safe())
        lease.monitor.safe.assert_not_called()


class RoutingTests(unittest.TestCase):
    def test_explicit_desktop_routes_to_isolated_facade(self):
        fixture = test_worker.WorkerContractTests()
        fixture.setUp()
        try:
            fixture.config["desktopName"] = DESKTOP
            from dsh_wechat_bridge.worker import Worker
            with patch("dsh_wechat_bridge.isolated.IsolatedRuntime", return_value=fixture.runtime) as factory:
                result = Worker().handle({"method": "probe", "params": {"config": fixture.config}})
            self.assertIn("result", result)
            factory.assert_called_once_with()
        finally:
            fixture.tearDown()


class SenderTests(unittest.TestCase):
    def test_expired_monitor_cannot_even_write_a_draft(self):
        def expired():
            raise UiaSendError("lease expired")
        sender = IsolatedUISender({}, {"hwnd": 77}, expired)
        gate = SimpleNamespace(run=lambda action: action(lambda: None))
        with patch("dsh_wechat_bridge.isolated_send.BackgroundUISender._set_exact_draft") as draft:
            with self.assertRaises(UiaSendError) as error:
                sender.send("hello", "target", gate)
        self.assertIs(error.exception.send_attempted, False)
        draft.assert_not_called()

    def _send_with_mock_window(self, *, expire_after_draft=False, reject_down=False):
        from unittest.mock import Mock
        value = SimpleNamespace(Value="hello")
        button = SimpleNamespace(Exists=lambda **_: True)
        root = SimpleNamespace(ButtonControl=lambda **_: button,
                               EditControl=lambda **_: SimpleNamespace(Name="target"))
        wrapper = SimpleNamespace(UIAWrapper=lambda _: SimpleNamespace(root=root))
        posts = []
        def post(hwnd, msg, wp, lp):
            posts.append((hwnd, msg, wp, lp))
            if reject_down and msg == 0x201:
                return False
            if msg == 0x202:
                value.Value = ""
            return True
        api = SimpleNamespace(PostMessageW=Mock(side_effect=post))
        checks = 0
        def monitor():
            nonlocal checks
            checks += 1
            if expire_after_draft and checks == 2:
                raise UiaSendError("expired", "foreground_guard")
            return True
        sender = IsolatedUISender({}, {"hwnd": 77}, monitor)
        gate = SimpleNamespace(run=lambda action: (action(lambda: None), {"gateActive": False, "gateRestored": True}))
        with patch.dict(sys.modules, {"wx4py.core.uia_wrapper": wrapper}), \
             patch("dsh_wechat_bridge.isolated_send.BackgroundUISender._set_exact_draft", return_value=(value, True)), \
             patch("dsh_wechat_bridge.isolated_send.ctypes.WinDLL", return_value=api), \
             patch("dsh_wechat_bridge.isolated_send.live_click_plan", return_value=1234):
            try:
                result = sender.send("hello", "target", gate)
            except UiaSendError as exc:
                return posts, exc
        return posts, result

    def test_one_click_targets_only_bound_hwnd(self):
        posts, result = self._send_with_mock_window()
        self.assertEqual(posts, [(77, 0x200, 0, 1234), (77, 0x201, 1, 1234), (77, 0x202, 0, 1234)])
        self.assertTrue(result[0]["sendAttempted"])

    def test_lease_loss_after_drafting_prevents_click(self):
        posts, error = self._send_with_mock_window(expire_after_draft=True)
        self.assertEqual(posts, [])
        self.assertIs(error.send_attempted, False)

    def test_partial_click_failure_is_uncertain_and_never_retried(self):
        posts, error = self._send_with_mock_window(reject_down=True)
        self.assertEqual([p[1] for p in posts], [0x200, 0x201])
        self.assertIs(error.send_attempted, True)

    def test_live_coordinates_follow_window_move_and_layout_change(self):
        import ctypes
        from ctypes import wintypes
        from unittest.mock import Mock
        for origin, center in [((10, 20), (800, 550)), ((850, 300), (700, 450)), ((-1100, 40), (800, 550))]:
            def convert(_hwnd, pointer):
                point = ctypes.cast(pointer, ctypes.POINTER(wintypes.POINT)).contents
                point.x -= origin[0]
                point.y -= origin[1]
                return 1
            def rect(_hwnd, pointer):
                box = ctypes.cast(pointer, ctypes.POINTER(wintypes.RECT)).contents
                box.right, box.bottom = 900, 600
                return 1
            api = SimpleNamespace(SetThreadDpiAwarenessContext=Mock(return_value=1),
                                  ScreenToClient=Mock(side_effect=convert), GetClientRect=Mock(side_effect=rect),
                                  IsWindowVisible=Mock(return_value=True), IsIconic=Mock(return_value=False))
            x, y = origin[0] + center[0], origin[1] + center[1]
            button = SimpleNamespace(Name="发送", IsEnabled=True, IsOffscreen=False,
                                     BoundingRectangle=SimpleNamespace(left=x-20, right=x+20, top=y-10, bottom=y+10))
            self.assertEqual(live_click_plan(api, 77, button), (center[1] << 16) | center[0])


if __name__ == "__main__":
    unittest.main()

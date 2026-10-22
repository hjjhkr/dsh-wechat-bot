"""Independent-window sending preserves exact receipts and no-retry boundaries."""
import sys
from pathlib import Path
from types import SimpleNamespace
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class Gate:
    def run(self, action):
        return action(lambda: None), {"gateActive": False, "gateRestored": True}
    def close(self):
        return {"gateActive": False, "gateRestored": True}


class Runtime:
    def __init__(self):
        self._binding = {"hwnd": 77}
        self._db = SimpleNamespace(get_messages=lambda *a, **kw: [{"sort_seq": 12}])
        self._gate = None
        self.gate = Gate()
        self.monitored = 0
    def verify(self, config, session): pass
    def make_native_gate(self, config, session): return self.gate
    def require_monitor(self): self.monitored += 1


CFG = {"targetWxid": "123@chatroom", "targetName": "△", "botWxid": "bot", "mainWindowTitle": "△"}
PARAMS = {"target": "123@chatroom", "expectedSelfId": "bot", "text": "hello", "enableSend": True, "allowTemporaryGate": True}


def test_selected_native_window_produces_confirmed_exact_receipt():
    from wechat_db.native_send import send_on_desktop
    runtime = Runtime()
    class Sender:
        def __init__(self, config, binding, monitor):
            assert binding["hwnd"] == 77
            self.monitor = monitor
        def send(self, text, target_name, gate):
            assert text == "hello" and target_name == "△"
            self.monitor()
            return gate.run(lambda active: {"sendAttempted": True, "noBotFocusObserved": True})
    def receipt(db, target, bot, text, since, started):
        assert target == "123@chatroom" and since == 12
        return {"serverId": "9912345678901234567", "target": target, "senderId": bot, "text": text}
    result = send_on_desktop(runtime, CFG, {}, PARAMS, sender_factory=Sender, receipt_lookup=receipt)
    assert result["status"] == "confirmed"
    assert result["outgoing"]["serverId"] == "9912345678901234567"
    assert result["gateRestored"] is True and runtime._gate is None


def test_input_failure_before_commit_is_definite_and_does_not_poll_receipt():
    from wechat_db.native_send import send_on_desktop
    runtime = Runtime()
    class Sender:
        def __init__(self, *args): pass
        def send(self, *args):
            error = RuntimeError("native input missing")
            error.send_attempted = False
            error.reason_code = "uia_draft"
            raise error
    result = send_on_desktop(runtime, CFG, {}, PARAMS, sender_factory=Sender,
                             receipt_lookup=lambda *a: pytest.fail("must not poll before commit"))
    assert result == {"status": "ambiguous", "reasonCode": "uia_draft", "sendAttempted": False,
                      "gateActive": False, "gateRestored": True}


def test_uncertain_commit_never_becomes_a_definite_failure():
    from wechat_db.native_send import send_on_desktop
    runtime = Runtime()
    class Sender:
        def __init__(self, *args): pass
        def send(self, *args):
            error = RuntimeError("queued click, no clear confirmation")
            error.send_attempted = True
            error.reason_code = "send_unknown"
            raise error
    result = send_on_desktop(runtime, CFG, {}, PARAMS, sender_factory=Sender,
                             receipt_lookup=lambda *a: None)
    assert result["sendAttempted"] is True and result["status"] == "ambiguous"


def test_unrestored_gate_blocks_receipt_success():
    from wechat_db.native_send import send_on_desktop
    runtime = Runtime()
    runtime.gate.close = lambda: {"gateActive": None, "gateRestored": False}
    class Sender:
        def __init__(self, *args): pass
        def send(self, *args):
            return {"sendAttempted": True, "noBotFocusObserved": True}, {"gateActive": True, "gateRestored": False}
    result = send_on_desktop(runtime, CFG, {}, PARAMS, sender_factory=Sender,
                             receipt_lookup=lambda *a: pytest.fail("unrestored gate"))
    assert result["reasonCode"] == "gate_restore" and result["gateRestored"] is False


def test_native_ui_commits_once_to_the_bound_window(monkeypatch):
    from wechat_db.native_send import NativeUISender
    value = SimpleNamespace(Value="hello")
    seen = []
    monkeypatch.setattr(NativeUISender, "_set_draft", staticmethod(lambda hwnd, text: (value, True)))
    def click(hwnd, before):
        before()
        seen.append(hwnd)
        value.Value = ""
    monkeypatch.setattr(NativeUISender, "_click_sender", staticmethod(click))
    result, state = NativeUISender(CFG, {"hwnd": 77}, lambda: None).send("hello", "△", Gate())
    assert seen == [77] and result["sendAttempted"] is True
    assert state["gateRestored"] is True


def test_native_ui_removes_only_its_own_uncommitted_draft(monkeypatch):
    from wechat_db.native_send import NativeUISender, NativeSendError
    value = SimpleNamespace(Value="hello")
    value.SetValue = lambda text, **kw: setattr(value, "Value", text)
    monkeypatch.setattr(NativeUISender, "_set_draft", staticmethod(lambda *args: (value, True)))
    def missing_button(hwnd, before): raise NativeSendError("no button")
    monkeypatch.setattr(NativeUISender, "_click_sender", staticmethod(missing_button))
    with pytest.raises(NativeSendError) as failed:
        NativeUISender(CFG, {"hwnd": 77}, lambda: None).send("hello", "△", Gate())
    assert failed.value.send_attempted is False and value.Value == ""


def test_native_ui_does_not_touch_draft_after_uncertain_commit(monkeypatch):
    from wechat_db.native_send import NativeUISender, NativeSendError
    value = SimpleNamespace(Value="hello")
    value.SetValue = lambda *a, **kw: pytest.fail("must not clear after commit")
    monkeypatch.setattr(NativeUISender, "_set_draft", staticmethod(lambda *args: (value, True)))
    def uncertain(hwnd, before):
        before()
        raise NativeSendError("unknown click outcome", "send_unknown", True)
    monkeypatch.setattr(NativeUISender, "_click_sender", staticmethod(uncertain))
    with pytest.raises(NativeSendError) as failed:
        NativeUISender(CFG, {"hwnd": 77}, lambda: None).send("hello", "△", Gate())
    assert failed.value.send_attempted is True and value.Value == "hello"


def test_missing_database_receipt_after_click_is_uncertain(monkeypatch):
    import wechat_db.native_send as native
    times = iter([0, 0, 4])
    monkeypatch.setattr(native.time, "monotonic", lambda: next(times))
    monkeypatch.setattr(native.time, "sleep", lambda seconds: None)
    class Sender:
        def __init__(self, *args): pass
        def send(self, *args):
            return {"sendAttempted": True, "noBotFocusObserved": True}, {"gateActive": False, "gateRestored": True}
    result = native.send_on_desktop(Runtime(), CFG, {}, PARAMS, sender_factory=Sender, receipt_lookup=lambda *a: None)
    assert result == {"status": "ambiguous", "reasonCode": "db_verify", "sendAttempted": True,
                      "gateActive": False, "gateRestored": True}

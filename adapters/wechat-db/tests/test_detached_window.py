"""Native double-click selection and window reuse; no real desktop input."""
import sys
import threading
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def _module():
    from wechat_db import detached_window
    return detached_window


class Surface:
    def __init__(self, windows=(), *, draft="", header="Peer"):
        self.rows = list(windows)
        self.draft, self.header = draft, header
        self.selected = False
        self.clicked = 0

    def candidates(self):
        return self.rows

    def select(self, active):
        if self.draft:
            raise RuntimeError("existing draft")
        self.selected = True

    def double_click(self, active):
        assert self.selected
        self.clicked += 1
        self.rows = [{"hwnd": 21, "title": "Peer", "className": "Qt"}]

    def inspect(self, window):
        if self.header != "Peer" or self.draft:
            raise RuntimeError("wrong header or existing draft")


def test_select_then_double_click_and_bind_one_native_window():
    surface = Surface()
    result = _module().prepare_surface(surface, lambda: None)
    assert result["window"]["hwnd"] == 21
    assert result["reused"] is False
    assert surface.clicked == 1


def test_reuse_existing_window_without_replaying_input():
    surface = Surface([{"hwnd": 21, "title": "Peer", "className": "Qt"}])
    assert _module().prepare_surface(surface, lambda: None)["reused"] is True
    assert surface.clicked == 0


def test_ambiguous_windows_or_wrong_header_block_without_click():
    surface = Surface([{"hwnd": 21}, {"hwnd": 22}])
    with pytest.raises(RuntimeError):
        _module().prepare_surface(surface, lambda: None)
    assert surface.clicked == 0
    surface = Surface([{"hwnd": 21}], header="Other")
    with pytest.raises(RuntimeError):
        _module().prepare_surface(surface, lambda: None)
    assert surface.clicked == 0


def test_existing_main_draft_blocks_double_click():
    surface = Surface(draft="unsent")
    with pytest.raises(RuntimeError):
        _module().prepare_surface(surface, lambda: None)
    assert surface.clicked == 0


def test_group_header_member_count_is_not_part_of_the_conversation_name():
    matches = _module().native_header_matches
    assert matches("△(9)", "△", "group")
    assert not matches("Other(9)", "△", "group")
    assert not matches("△(9)", "△", "direct")
    assert matches("Peer", "Peer", "direct")


def test_cancelled_preparation_does_not_start_worker(tmp_path):
    script = tmp_path / "worker.py"
    script.write_text("", encoding="utf-8")
    prep = _module().DetachedWindowPreparer(sys.executable, [str(script)], {"botWxid": "bot"}, "bot")
    cancel = threading.Event()
    cancel.set()
    with pytest.raises(RuntimeError):
        prep.prepare(cancel)
    assert prep.close() is True


@pytest.mark.parametrize("active,restored", [(True, True), (None, True), (False, False)])
def test_unconfirmed_gate_never_publishes_prepared_window(monkeypatch, tmp_path, active, restored):
    import wechat_db.legacy_sender as sender
    class Child:
        def __init__(self, *args): pass
        def start(self): pass
        def request(self, *args):
            return {"result": {"binding": {"hwnd": 21}, "opened": True,
                               "gateActive": active, "gateRestored": restored}}
        def close_normally(self, timeout): return True
    monkeypatch.setattr(sender, "_JsonlChild", Child)
    prep = _module().DetachedWindowPreparer(sys.executable, [str(tmp_path / "worker.py")], {"botWxid": "bot", "stateRoot": str(tmp_path)}, "bot")
    with pytest.raises(RuntimeError):
        prep.prepare(threading.Event())
    assert prep.close() is True


def test_prepare_error_preserves_safe_cause_and_normal_close_confirmation(monkeypatch, tmp_path):
    import wechat_db.legacy_sender as sender
    from wechat_db.legacy_sender import PreparationError

    class Child:
        def __init__(self, *args):
            pass

        def start(self):
            pass

        def request(self, *args):
            return {"error": {
                "code": "prepare_failed",
                "message": "private runtime path must not escape",
                "reasonCode": "target_ambiguous",
                "gateActive": None,
                "gateRestored": False,
            }}

        def close_normally(self, timeout):
            return True

    monkeypatch.setattr(sender, "_JsonlChild", Child)
    prep = _module().DetachedWindowPreparer(
        sys.executable, [str(tmp_path / "worker.py")],
        {"botWxid": "bot", "stateRoot": str(tmp_path)}, "bot",
    )

    with pytest.raises(RuntimeError) as failure:
        prep.prepare(threading.Event())

    assert isinstance(failure.value, PreparationError)
    assert failure.value.reason_code == "target_ambiguous"
    assert failure.value.cleanup_confirmed is True
    assert failure.value.gate_state == {"gateActive": False, "gateRestored": True}
    assert "private runtime path" not in str(failure.value)
    assert prep.close() is True


def test_failed_normal_close_rejects_ready_result_and_keeps_cleanup_retryable(monkeypatch, tmp_path):
    import wechat_db.legacy_sender as sender
    from wechat_db.legacy_sender import PreparationError

    class Child:
        def __init__(self, *args): self.attempts = 0
        def start(self): pass
        def request(self, *args):
            return {"error": {"code": "prepare_failed", "reasonCode": "gate_restore",
                               "gateActive": None, "gateRestored": False}}
        def close_normally(self, timeout):
            self.attempts += 1
            return self.attempts > 1
    monkeypatch.setattr(sender, "_JsonlChild", Child)
    prep = _module().DetachedWindowPreparer(sys.executable, [str(tmp_path / "worker.py")], {"botWxid": "bot", "stateRoot": str(tmp_path)}, "bot")
    with pytest.raises(RuntimeError) as failure:
        prep.prepare(threading.Event())
    assert isinstance(failure.value, PreparationError)
    assert failure.value.reason_code == "gate_restore"
    assert failure.value.cleanup_confirmed is False
    assert failure.value.gate_state == {"gateActive": None, "gateRestored": False}
    assert prep.close() is True

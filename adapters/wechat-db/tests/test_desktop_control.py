import json
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def spec_file(tmp_path, **updates):
    exe = tmp_path / 'Weixin.exe'
    exe.write_bytes(b'fixture')
    worker = {'expectedExe': str(exe), 'expectedVersion': '4.1.15.13',
              'botWxid': 'wxid_synthetic_bot', 'botName': '测试小号',
              'desktopName': 'DshWeChatBot_test', 'stateRoot': str(tmp_path / 'state')}
    worker.update(updates)
    path = tmp_path / 'sender.json'
    path.write_text(json.dumps({'worker': worker}), encoding='utf8')
    return path


def test_desktop_control_refuses_default_desktop_and_missing_executable(tmp_path):
    from wechat_db.desktop_control import load_spec, DesktopControlError
    with pytest.raises(DesktopControlError):
        load_spec(spec_file(tmp_path, desktopName='Default'))
    with pytest.raises(DesktopControlError):
        load_spec(spec_file(tmp_path, expectedExe=str(tmp_path / 'missing.exe')))


def test_owned_process_identity_never_adopts_a_reused_pid(tmp_path):
    from wechat_db.desktop_control import load_spec, session_running, DesktopControlError
    spec = load_spec(spec_file(tmp_path))
    state = {'desktop': spec.desktop, 'botWxid': spec.bot_id, 'pid': 12, 'startedAt': 100}
    assert session_running(spec, state, lambda _pid: {'exe': str(spec.exe), 'start': 100})
    assert not session_running(spec, state, lambda _pid: None)
    with pytest.raises(DesktopControlError):
        session_running(spec, state, lambda _pid: {'exe': str(spec.exe), 'start': 200})
    with pytest.raises(DesktopControlError):
        session_running(spec, {**state, 'desktop': 'Default'}, lambda _pid: None)


def test_process_identity_requires_the_recorded_process_instance(tmp_path):
    from wechat_db.desktop_control import DesktopControlError, load_spec, session_identity
    spec = load_spec(spec_file(tmp_path))
    state = {'desktop': spec.desktop, 'botWxid': spec.bot_id, 'pid': 12, 'startedAt': 100}

    assert session_identity(spec, state, lambda _pid: {'exe': str(spec.exe), 'start': 100}) == {
        'pid': 12, 'startedAt': 100.0,
    }
    assert session_identity(spec, state, lambda _pid: None) is None
    with pytest.raises(DesktopControlError):
        session_identity(spec, {**state, 'startedAt': float('nan')}, lambda _pid: None)
    with pytest.raises(DesktopControlError):
        session_identity(spec, {**state, 'pid': True}, lambda _pid: None)


def test_show_requires_return_toolbar_and_hide_does_not_launch_wechat(tmp_path):
    from wechat_db.desktop_control import DesktopController, DesktopControlError
    class Backend:
        current = 'Default'
        ready = False
        starts = 0
        def input_desktop(self): return self.current
        def ensure_started(self): self.starts += 1; return self.ready
        def switch(self, desktop): self.current = desktop
        def running(self): return True
    backend = Backend()
    controller = DesktopController(spec_file(tmp_path), backend=backend)
    assert controller.set_visible(False) == {'visible': False, 'running': True}
    assert backend.starts == 0
    with pytest.raises(DesktopControlError): controller.set_visible(True)
    assert backend.current == 'Default'
    backend.ready = True
    assert controller.set_visible(True)['visible'] is True
    assert backend.current == 'DshWeChatBot_test'
    assert controller.set_visible(False)['visible'] is False
    with pytest.raises(DesktopControlError): controller.set_visible('true')


def test_locked_or_unrelated_input_desktop_is_not_switched(tmp_path):
    from wechat_db.desktop_control import DesktopController, DesktopControlError
    backend = SimpleNamespace(input_desktop=lambda: 'Winlogon')
    with pytest.raises(DesktopControlError):
        DesktopController(spec_file(tmp_path), backend=backend).set_visible(True)


def test_lifecycle_state_confirms_default_instead_of_any_hidden_desktop(tmp_path):
    from wechat_db.desktop_control import DesktopController
    backend = SimpleNamespace(input_desktop=lambda: 'Winlogon', running=lambda: True)
    controller = DesktopController(spec_file(tmp_path), backend=backend)

    assert controller.lifecycle_state() == {
        'visible': False, 'returned': False, 'running': True,
    }


def test_existing_window_protocol_is_enabled_only_for_configured_controller():
    from wechat_db.adapter import Adapter
    from wechat_db.rpc import Server, ProtocolError
    import io
    events = []
    controller = SimpleNamespace(state=lambda: {'visible': False, 'running': True},
                                 set_visible=lambda value: events.append(value) or {'visible': value, 'running': True})
    sender = SimpleNamespace(desktop_control=controller)
    server = Server(io.BytesIO(), io.BytesIO())
    adapter = Adapter(server, lambda _: None, 'wxid_synthetic_bot', sender=sender)
    assert 'window/get' in server.handlers and 'window/set' in server.handlers
    assert adapter.on_window_get({}) == {'visible': False, 'running': True}
    assert adapter.on_window_set({'visible': True})['visible'] is True
    assert events == [True]
    with pytest.raises(ProtocolError): adapter.on_window_set({'visible': 'false'})
    disabled = Server(io.BytesIO(), io.BytesIO())
    Adapter(disabled, lambda _: None, 'wxid_synthetic_bot')
    assert 'window/set' not in disabled.handlers

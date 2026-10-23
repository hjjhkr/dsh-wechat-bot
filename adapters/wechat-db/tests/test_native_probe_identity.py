"""Prepared sessions keep exact process/window checks without global discovery."""
from __future__ import annotations

import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wechat_db.native_window_worker import NativeWindowRuntime


class RuntimeScopeError(RuntimeError):
    pass


class DbScopeError(RuntimeError):
    pass


def fixture_runtime(tmp_path, monkeypatch, *, is_group=True):
    root = tmp_path / "legacy"
    package = root / "dsh_wechat_bridge"
    package.mkdir(parents=True)
    (root / "worker.py").write_text("", encoding="utf-8")
    (package / "runtime.py").write_text("", encoding="utf-8")

    calls = {"base_probe": 0, "base_verify": 0, "binding": [], "db": [], "target": [], "members": []}
    binding = {
        "pid": 4321,
        "hwnd": 12345,
        "accountName": "account-A",
        "mainWindowTitle": "初号机",
    }
    config = {
        "preparedBinding": dict(binding),
        "botWxid": "wxid_bot",
        "botName": "初号机",
        "targetWxid": "123456@chatroom",
        "targetName": "△群",
    }

    class FakeDb:
        def get_self_info(self):
            return {"username": "wxid_bot", "remark": "初号机", "nick_name": "备用昵称"}

    def db_factory(current_config, account_name):
        calls["db"].append((current_config, account_name))
        if account_name != "account-A":
            raise DbScopeError("database account scope mismatch")
        return FakeDb()

    class WindowsRuntime:
        def __init__(self, binding_factory=None, db_factory_arg=None, sender_factory=None):
            self._binding_factory = binding_factory
            self._db_factory = db_factory_arg or db_factory
            self._binding = None
            self._db = None
            self._config = None

        def probe(self, current_config):
            calls["base_probe"] += 1
            return {"baseProbe": True, "config": current_config}

        def verify(self, current_config, session):
            calls["base_verify"] += 1

    def verify_target_contact(db, target_wxid, target_name):
        calls["target"].append((target_wxid, target_name))
        if target_wxid != "123456@chatroom" or target_name != "△群":
            raise DbScopeError("target contact scope mismatch")

    def verify_group_members(db, target_wxid, bot_wxid):
        calls["members"].append((target_wxid, bot_wxid))
        if calls.get("reject_members"):
            raise DbScopeError("group membership scope mismatch")
        if target_wxid != "123456@chatroom" or bot_wxid != "wxid_bot":
            raise DbScopeError("group membership scope mismatch")

    runtime_module = SimpleNamespace(
        WindowsRuntime=WindowsRuntime,
        RuntimeScopeError=RuntimeScopeError,
        DbScopeError=DbScopeError,
        verify_target_contact=verify_target_contact,
        is_group=lambda current_config: is_group,
        group_members=verify_group_members,
    )
    package_module = ModuleType("dsh_wechat_bridge")
    package_module.__path__ = []
    package_module.runtime = runtime_module
    package_module.gate = SimpleNamespace()
    monkeypatch.setitem(sys.modules, "dsh_wechat_bridge", package_module)
    monkeypatch.setitem(sys.modules, "dsh_wechat_bridge.runtime", runtime_module)
    monkeypatch.setitem(sys.modules, "dsh_wechat_bridge.gate", package_module.gate)

    import wechat_db.native_binding as native_binding

    def resolve(current_config, current_binding):
        calls["binding"].append((current_config, current_binding))
        if calls.get("binding_error"):
            raise native_binding.NativeBindingError(calls["binding_error"])
        if current_binding != current_config.get("preparedBinding"):
            raise native_binding.NativeBindingError("prepared binding changed")
        return dict(current_binding)

    monkeypatch.setattr(native_binding, "resolve_prepared_binding", resolve)
    facade = NativeWindowRuntime(legacy_root=root)
    runtime = facade._make_legacy_runtime(config)
    return runtime, config, calls, binding


def test_prepared_probe_and_verify_bypass_legacy_global_identity_methods(tmp_path, monkeypatch):
    runtime, config, calls, binding = fixture_runtime(tmp_path, monkeypatch)

    result = runtime.probe(config)
    runtime.verify(config, {"selfId": "wxid_bot"})

    assert result == {"selfId": "wxid_bot", "targetId": "123456@chatroom", "binding": binding}
    assert calls["base_probe"] == 0
    assert calls["base_verify"] == 0
    assert len(calls["binding"]) == 2
    assert calls["db"][0][1] == "account-A"
    assert calls["target"] == [("123456@chatroom", "△群")]
    assert calls["members"] == [("123456@chatroom", "wxid_bot")]


def test_prepared_probe_rejects_wrong_session_and_configuration(tmp_path, monkeypatch):
    runtime, config, calls, _ = fixture_runtime(tmp_path, monkeypatch)
    runtime.probe(config)

    with pytest.raises(RuntimeScopeError, match="runtime session identity changed"):
        runtime.verify(config, {"selfId": "wxid_someone_else"})
    changed = {**config, "targetWxid": "other@chatroom"}
    with pytest.raises(RuntimeScopeError, match="not bound to this configuration"):
        runtime.verify(changed, {"selfId": "wxid_bot"})
    assert calls["base_verify"] == 0


@pytest.mark.parametrize(
    ("mutation", "message", "expected_target_calls", "expected_member_calls"),
    [
        ("self-id", "configured bot wxid and exact display name do not match", 0, 0),
        ("self-name", "configured bot wxid and exact display name do not match", 0, 0),
        ("target", "target contact scope mismatch", 1, 0),
        ("membership", "group membership scope mismatch", 1, 1),
    ],
)
def test_prepared_probe_keeps_database_identity_target_and_group_checks(
    tmp_path, monkeypatch, mutation, message, expected_target_calls, expected_member_calls
):
    runtime, config, calls, _ = fixture_runtime(tmp_path, monkeypatch)
    if mutation == "self-id":
        runtime._db_factory = lambda current_config, account_name: SimpleNamespace(
            get_self_info=lambda: {"username": "wrong", "remark": "初号机"}
        )
    elif mutation == "self-name":
        runtime._db_factory = lambda current_config, account_name: SimpleNamespace(
            get_self_info=lambda: {"username": "wxid_bot", "remark": "错误名字"}
        )
    elif mutation == "target":
        config["targetName"] = "另一个群"
    elif mutation == "membership":
        calls["reject_members"] = True

    with pytest.raises(RuntimeScopeError, match=message):
        runtime.probe(config)

    assert len(calls["target"]) == expected_target_calls
    assert len(calls["members"]) == expected_member_calls
    assert calls["base_probe"] == 0


def test_prepared_binding_failure_does_not_fall_back_to_legacy_probe(tmp_path, monkeypatch):
    runtime, config, calls, _ = fixture_runtime(tmp_path, monkeypatch)
    calls["binding_error"] = "prepared window identity changed"
    with pytest.raises(RuntimeScopeError, match="prepared window identity changed"):
        runtime.probe(config)
    assert calls["db"] == []
    assert calls["base_probe"] == 0


def test_unprepared_runtime_keeps_legacy_discovery_path(tmp_path, monkeypatch):
    runtime, _, calls, _ = fixture_runtime(tmp_path, monkeypatch)

    result = runtime.probe({"botWxid": "wxid_bot"})
    runtime.verify({"botWxid": "wxid_bot"}, {"selfId": "wxid_bot"})

    assert result["baseProbe"] is True
    assert calls["base_probe"] == 1
    assert calls["base_verify"] == 1

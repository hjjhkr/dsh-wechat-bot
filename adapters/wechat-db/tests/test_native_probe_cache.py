"""Prepared native sends revalidate one bound PID instead of rediscovering all processes."""
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from wechat_db.native_window_worker import NativeWindowRuntime


def fixture_runtime(tmp_path, monkeypatch):
    root = tmp_path / "legacy"
    package = root / "dsh_wechat_bridge"
    package.mkdir(parents=True)
    (root / "worker.py").write_text("", encoding="utf-8")
    (package / "runtime.py").write_text("", encoding="utf-8")
    module = ModuleType("dsh_wechat_bridge")
    class WindowsRuntime:
        def __init__(self, binding_factory=None):
            self.binding_factory = binding_factory
    module.runtime = SimpleNamespace(WindowsRuntime=WindowsRuntime)
    module.gate = SimpleNamespace()
    monkeypatch.setitem(sys.modules, "dsh_wechat_bridge", module)
    return NativeWindowRuntime(legacy_root=root)


def test_prepared_snapshot_uses_live_bound_identity_validation(tmp_path, monkeypatch):
    import wechat_db.native_binding as identity
    runtime = fixture_runtime(tmp_path, monkeypatch)
    config = {"preparedBinding": {"pid": 4321, "hwnd": 12345}}
    calls = []
    def resolve(cfg, snapshot):
        calls.append((cfg, snapshot))
        return dict(snapshot)
    monkeypatch.setattr(identity, "resolve_prepared_binding", resolve, raising=False)
    bound = runtime._make_legacy_runtime(config)
    assert callable(bound.binding_factory), "prepared sends must not use the full-process discovery default"
    assert bound.binding_factory(config) == config["preparedBinding"]
    assert calls == [(config, config["preparedBinding"])]


def test_initial_preparation_keeps_legacy_discovery_and_stale_snapshot_never_falls_back(tmp_path, monkeypatch):
    import wechat_db.native_binding as identity
    runtime = fixture_runtime(tmp_path, monkeypatch)
    assert runtime._make_legacy_runtime({}).binding_factory is None
    def reject(*_args):
        raise RuntimeError("bound identity changed")
    monkeypatch.setattr(identity, "resolve_prepared_binding", reject, raising=False)
    bound = runtime._make_legacy_runtime({"preparedBinding": {"pid": 4321}})
    assert callable(bound.binding_factory)
    with pytest.raises(RuntimeError, match="bound identity changed"):
        bound.binding_factory({"preparedBinding": {"pid": 4321}})

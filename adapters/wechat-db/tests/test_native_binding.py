from copy import deepcopy
from types import SimpleNamespace

import pytest

from wechat_db.native_binding import (
    NativeBindingError,
    make_native_memory_factory,
    resolve_prepared_binding,
    validate_prepared_probe_binding,
    validate_native_lease_snapshot,
    verify_native_lease_identity,
)


LEASE = {
    "pid": 4321,
    "startedAt": 12345.67,
    "exePath": r"C:\Program Files\Tencent\Weixin\Weixin.exe",
    "version": "4.1.0.123",
    "hwnd": 0x123456,
    "mainWindowClass": "WeChatMainWndForPC",
    "mainWindowTitle": "Weixin",
    "modulePath": r"C:\Program Files\Tencent\Weixin\Weixin.dll",
    "moduleBase": 0x70000000,
    "moduleSize": 0x123000,
    "rva": 0x100,
}


def valid_snapshot():
    return {
        "process": {
            "pid": 4321,
            "exePath": r"C:\Program Files\Tencent\Weixin\Weixin.exe",
            "startedAt": 12345.675,
            "version": "4.1.0.123",
        },
        "windows": [
            {
                "hwnd": 0x123456,
                "pid": 4321,
                "ownerHwnd": 0,
                "className": "WeChatMainWndForPC",
                "title": "Weixin",
                "captionStyle": True,
                "toolWindow": False,
            }
        ],
        "module": {
            "path": r"C:\Program Files\Tencent\Weixin\Weixin.dll",
            "base": 0x70000000,
            "size": 0x123000,
        },
    }


def test_same_title_window_does_not_invalidate_the_bound_hwnd():
    snapshot = valid_snapshot()
    snapshot["windows"].append({
        "hwnd": 0x654321,
        "pid": 4321,
        "ownerHwnd": 0,
        "className": "WeChatMainWndForPC",
        "title": "Weixin",
        "captionStyle": True,
        "toolWindow": False,
    })

    validate_native_lease_snapshot(LEASE, snapshot)


@pytest.mark.parametrize(
    ("section", "field", "value"),
    [
        ("windows", "remove_bound", None),
        ("window", "pid", 9876),
        ("window", "ownerHwnd", 77),
        ("window", "className", "DifferentWindowClass"),
        ("window", "title", "Different title"),
        ("window", "captionStyle", False),
        ("window", "toolWindow", True),
        ("process", "startedAt", 12345.70),
        ("process", "exePath", r"C:\Other\Weixin.exe"),
        ("process", "version", "4.1.0.124"),
        ("module", "path", r"D:\Tencent\Weixin.dll"),
        ("module", "base", 0x70010000),
        ("module", "size", 0x124000),
    ],
)
def test_identity_drift_fails_closed(section, field, value):
    snapshot = deepcopy(valid_snapshot())
    if section == "windows" and field == "remove_bound":
        snapshot["windows"].clear()
    elif section == "window":
        snapshot["windows"][0][field] = value
    else:
        snapshot[section][field] = value

    with pytest.raises(NativeBindingError):
        validate_native_lease_snapshot(LEASE, snapshot)


def test_verifier_accepts_an_injected_snapshot_reader():
    calls = []

    def read_snapshot(lease):
        calls.append(lease["hwnd"])
        return valid_snapshot()

    verify_native_lease_identity(LEASE, snapshot_reader=read_snapshot)

    assert calls == [0x123456]


def test_memory_factory_subclass_uses_the_injected_identity_verifier():
    class BaseMemory:
        def verify_identity(self, lease):
            raise AssertionError("base verifier must be replaced")

    reads = []

    def read_snapshot(lease):
        reads.append(lease["pid"])
        return valid_snapshot()

    gate_module = SimpleNamespace(Win32ProcessMemory=BaseMemory)
    memory_type = make_native_memory_factory(gate_module, snapshot_reader=read_snapshot)
    memory = object.__new__(memory_type)

    assert isinstance(memory, BaseMemory)
    memory.verify_identity(LEASE)
    assert reads == [4321]


def prepared_probe(tmp_path):
    db_root = tmp_path / "db"
    account = db_root / "wxid_bot_1234"
    db_storage = account / "db_storage"
    db_storage.mkdir(parents=True)
    db_file = db_storage / "message.db"
    db_file.write_bytes(b"")
    exe = tmp_path / "Weixin.exe"
    exe.write_bytes(b"exe")
    module_path = tmp_path / "Weixin.dll"
    module_path.write_bytes(b"dll")

    config = {
        "dbRoot": str(db_root),
        "botWxid": "wxid_bot",
        "expectedExe": str(exe),
        "expectedVersion": "4.1.0.123",
        "mainWindowClass": "WeChatMainWndForPC",
        "mainWindowTitle": "目标群",
        "gateModule": str(module_path),
        "gateRva": "0x100",
    }
    binding = {
        "pid": 4321,
        "processStartedAt": 12345.67,
        "exePath": str(exe),
        "version": "4.1.0.123",
        "hwnd": 0x123456,
        "mainWindowClass": "WeChatMainWndForPC",
        "mainWindowTitle": "目标群",
        "modulePath": str(module_path),
        "moduleBase": 0x70000000,
        "moduleSize": 0x123000,
        "accountName": account.name,
        "accountPath": str(account),
    }

    def snapshot_reader(lease):
        return {
            "process": {
                "pid": binding["pid"],
                "exePath": binding["exePath"],
                "startedAt": binding["processStartedAt"],
                "version": binding["version"],
            },
            "windows": [{
                "hwnd": binding["hwnd"],
                "pid": binding["pid"],
                "ownerHwnd": 0,
                "className": binding["mainWindowClass"],
                "title": binding["mainWindowTitle"],
                "captionStyle": True,
                "toolWindow": False,
            }],
            "module": {
                "path": binding["modulePath"],
                "base": binding["moduleBase"],
                "size": binding["moduleSize"],
            },
        }

    def account_process_reader(pid):
        return {
            "pid": pid,
            "exePath": binding["exePath"],
            "startedAt": binding["processStartedAt"],
            "openFiles": [str(db_file)],
        }

    return config, binding, snapshot_reader, account_process_reader, db_root, account, db_storage, exe, module_path


def test_prepared_probe_reuses_one_binding_after_full_identity_and_account_verification(tmp_path):
    config, binding, read_snapshot, read_process, *_ = prepared_probe(tmp_path)
    visited = []

    def account_process_reader(pid):
        visited.append(pid)
        return read_process(pid)

    resolved = resolve_prepared_binding(
        config, binding,
        snapshot_reader=read_snapshot,
        account_process_reader=account_process_reader,
    )

    assert resolved == binding
    assert resolved is not binding, "worker config must own a detached binding snapshot"
    assert visited == [binding["pid"]], "prepared resolution checks only the bound PID"


def test_prepared_binding_resolution_rechecks_the_live_process_each_time(tmp_path):
    config, binding, read_snapshot, read_process, *_ = prepared_probe(tmp_path)
    snapshots = []
    processes = []

    def snapshot_reader(lease):
        snapshots.append(lease["pid"])
        return read_snapshot(lease)

    def account_process_reader(pid):
        processes.append(pid)
        return read_process(pid)

    resolve_prepared_binding(
        config, binding, snapshot_reader=snapshot_reader,
        account_process_reader=account_process_reader,
    )
    resolve_prepared_binding(
        config, binding, snapshot_reader=snapshot_reader,
        account_process_reader=account_process_reader,
    )

    assert snapshots == [binding["pid"], binding["pid"]]
    assert processes == [binding["pid"], binding["pid"]]


@pytest.mark.parametrize("drift", ["db_root", "account_directory", "bot_wxid"])
def test_prepared_probe_rejects_account_scope_drift(tmp_path, drift):
    config, binding, read_snapshot, read_process, db_root, account, *_ = prepared_probe(tmp_path)
    if drift == "db_root":
        other_root = tmp_path / "other-db"
        other_account = other_root / account.name
        (other_account / "db_storage").mkdir(parents=True)
        config["dbRoot"] = str(other_root)
    elif drift == "account_directory":
        other_account = db_root / "wxid_other_5678"
        (other_account / "db_storage").mkdir(parents=True)
        binding["accountName"] = other_account.name
        binding["accountPath"] = str(other_account)
    else:
        config["botWxid"] = "wxid_other"

    with pytest.raises(NativeBindingError):
        validate_prepared_probe_binding(
            config, binding, snapshot_reader=read_snapshot,
            account_process_reader=read_process,
        )


def test_prepared_probe_rejects_a_db_path_that_only_matches_by_string_prefix(tmp_path):
    config, binding, read_snapshot, read_process, _, _, db_storage, *_ = prepared_probe(tmp_path)
    prefixed = str(db_storage) + "-other/message.db"

    with pytest.raises(NativeBindingError):
        validate_prepared_probe_binding(
            config, binding, snapshot_reader=read_snapshot,
            account_process_reader=lambda pid: {
                "pid": pid,
                "exePath": binding["exePath"],
                "startedAt": binding["processStartedAt"],
                "openFiles": [prefixed],
            },
        )


@pytest.mark.parametrize("drift", ["pid", "start_time", "exe", "no_db_handle"])
def test_prepared_probe_rejects_pid_reuse_or_lost_account_handle(tmp_path, drift):
    config, binding, read_snapshot, read_process, *_ = prepared_probe(tmp_path)
    process_record = read_process(binding["pid"])
    if drift == "pid":
        process_record["pid"] = 9876
    elif drift == "start_time":
        process_record["startedAt"] += 2
    elif drift == "exe":
        process_record["exePath"] = str(tmp_path / "other.exe")
    else:
        process_record["openFiles"] = []

    with pytest.raises(NativeBindingError):
        validate_prepared_probe_binding(
            config, binding, snapshot_reader=read_snapshot,
            account_process_reader=lambda _pid: process_record,
        )

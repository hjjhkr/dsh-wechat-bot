"""Verify a bound WeChat process without reselecting its main window."""

from __future__ import annotations

import ctypes
import importlib
import math
import os
from ctypes import wintypes
from pathlib import Path, PureWindowsPath
from typing import Any, Callable, Mapping


class NativeBindingError(RuntimeError):
    """A native process lease no longer identifies the original WeChat instance."""


def _norm_path(path: str | os.PathLike[str]) -> str:
    return os.path.normcase(os.path.realpath(os.fspath(path)))


def _lease_fields(lease: Mapping[str, Any]) -> None:
    required = (
        "pid", "startedAt", "exePath", "version", "hwnd", "mainWindowClass",
        "mainWindowTitle", "modulePath", "moduleSize",
    )
    if not isinstance(lease, Mapping) or any(key not in lease for key in required):
        raise NativeBindingError("native process lease is incomplete")
    if type(lease["pid"]) is not int or lease["pid"] <= 0:
        raise NativeBindingError("native process lease has an invalid PID")
    if type(lease["hwnd"]) is not int or lease["hwnd"] <= 0:
        raise NativeBindingError("native process lease has an invalid HWND")
    if (not isinstance(lease["startedAt"], (int, float))
            or isinstance(lease["startedAt"], bool)
            or not math.isfinite(float(lease["startedAt"]))):
        raise NativeBindingError("native process lease has an invalid start time")
    for key in ("exePath", "version", "mainWindowClass", "mainWindowTitle", "modulePath"):
        if not isinstance(lease[key], str) or not lease[key].strip():
            raise NativeBindingError(f"native process lease has an invalid {key}")
    if type(lease["moduleSize"]) is not int or lease["moduleSize"] <= 0:
        raise NativeBindingError("native process lease has an invalid module size")


def validate_native_lease_snapshot(lease: Mapping[str, Any], snapshot: Mapping[str, Any]) -> None:
    """Validate process, exact bound HWND, and module facts from one OS snapshot.

    Other windows are deliberately ignored. A lease is tied to one HWND; finding
    another window with the same class and title must not invalidate that lease.
    """
    _lease_fields(lease)
    if not isinstance(snapshot, Mapping):
        raise NativeBindingError("native identity snapshot is invalid")

    process = snapshot.get("process")
    module = snapshot.get("module")
    windows = snapshot.get("windows")
    if not isinstance(process, Mapping) or not isinstance(module, Mapping) or not isinstance(windows, (list, tuple)):
        raise NativeBindingError("native identity snapshot is incomplete")

    if type(process.get("pid")) is not int or process["pid"] != lease["pid"]:
        raise NativeBindingError("bound Weixin process PID changed")
    try:
        process_exe = _norm_path(process["exePath"])
        lease_exe = _norm_path(lease["exePath"])
    except (KeyError, TypeError, OSError, ValueError) as exc:
        raise NativeBindingError("bound Weixin executable could not be verified") from exc
    if process_exe != lease_exe:
        raise NativeBindingError("bound Weixin executable changed")
    try:
        started_value = process["startedAt"]
    except (KeyError, TypeError, ValueError, OverflowError) as exc:
        raise NativeBindingError("bound Weixin start time could not be verified") from exc
    if (not isinstance(started_value, (int, float)) or isinstance(started_value, bool)
            or not math.isfinite(float(started_value))):
        raise NativeBindingError("bound Weixin start time could not be verified")
    started_at = float(started_value)
    if not math.isfinite(started_at) or abs(started_at - float(lease["startedAt"])) > 0.01:
        raise NativeBindingError("bound Weixin process start time changed")
    if process.get("version") != lease["version"]:
        raise NativeBindingError("bound Weixin version changed")

    bound_windows = [
        row for row in windows
        if isinstance(row, Mapping)
        and type(row.get("hwnd")) is int
        and row["hwnd"] == lease["hwnd"]
    ]
    if len(bound_windows) != 1:
        raise NativeBindingError("bound main window is missing or ambiguous")
    window = bound_windows[0]
    if type(window.get("pid")) is not int or window["pid"] != lease["pid"]:
        raise NativeBindingError("bound main-window owner changed")
    if type(window.get("ownerHwnd")) is not int or window["ownerHwnd"] != 0:
        raise NativeBindingError("bound main window is no longer unowned")
    if window.get("className") != lease["mainWindowClass"]:
        raise NativeBindingError("bound main-window class changed")
    if window.get("title") != lease["mainWindowTitle"]:
        raise NativeBindingError("bound main-window title changed")
    if window.get("captionStyle") is not True or window.get("toolWindow") is not False:
        raise NativeBindingError("bound main-window style changed")

    try:
        module_path = _norm_path(module["path"])
        lease_module_path = _norm_path(lease["modulePath"])
        module_size = module["size"]
    except (KeyError, TypeError, OSError, ValueError) as exc:
        raise NativeBindingError("bound Weixin.dll could not be verified") from exc
    if module_path != lease_module_path or type(module_size) is not int or module_size != lease["moduleSize"]:
        raise NativeBindingError("bound Weixin.dll identity changed")
    if "moduleBase" in lease and (
        type(module.get("base")) is not int or module["base"] != lease["moduleBase"]
    ):
        raise NativeBindingError("bound Weixin.dll base changed")
    if PureWindowsPath(str(lease["modulePath"])).name.casefold() != "weixin.dll":
        raise NativeBindingError("bound module is not Weixin.dll")


def _read_file_version(path: str) -> str:
    try:
        import win32api

        data = win32api.GetFileVersionInfo(path, "\\")
        ms, ls = int(data["FileVersionMS"]), int(data["FileVersionLS"])
        return f"{ms >> 16}.{ms & 0xffff}.{ls >> 16}.{ls & 0xffff}"
    except Exception as exc:
        raise NativeBindingError("Weixin executable version could not be verified") from exc


def _read_bound_window(hwnd_value: int) -> dict[str, Any] | None:
    """Read only the lease's HWND, never enumerate or reselect the process windows."""
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.IsWindow.argtypes = [wintypes.HWND]
    user32.IsWindow.restype = wintypes.BOOL
    hwnd = wintypes.HWND(hwnd_value)
    if not user32.IsWindow(hwnd):
        return None

    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    owner_pid = wintypes.DWORD()
    if not user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner_pid)):
        raise NativeBindingError("bound main-window owner could not be verified")

    user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
    user32.GetWindow.restype = wintypes.HWND
    owner_hwnd = int(user32.GetWindow(hwnd, 4) or 0)  # GW_OWNER

    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.restype = ctypes.c_int
    class_name = ctypes.create_unicode_buffer(256)
    if not user32.GetClassNameW(hwnd, class_name, len(class_name)):
        raise NativeBindingError("bound main-window class could not be verified")

    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int
    title_length = max(0, int(user32.GetWindowTextLengthW(hwnd)))
    title = ctypes.create_unicode_buffer(title_length + 1)
    user32.GetWindowTextW(hwnd, title, len(title))

    try:
        get_window_long_ptr = user32.GetWindowLongPtrW
    except AttributeError:
        get_window_long_ptr = user32.GetWindowLongW
    get_window_long_ptr.argtypes = [wintypes.HWND, ctypes.c_int]
    get_window_long_ptr.restype = ctypes.c_ssize_t
    style = int(get_window_long_ptr(hwnd, -16))
    extended_style = int(get_window_long_ptr(hwnd, -20))

    return {
        "hwnd": hwnd_value,
        "pid": int(owner_pid.value),
        "ownerHwnd": owner_hwnd,
        "className": class_name.value,
        "title": title.value,
        "captionStyle": (style & 0x00C00000) == 0x00C00000,  # WS_CAPTION
        "toolWindow": bool(extended_style & 0x00000080),  # WS_EX_TOOLWINDOW
    }


def _read_native_snapshot(lease: Mapping[str, Any], *, gate_module: Any = None) -> dict[str, Any]:
    if os.name != "nt":
        raise NativeBindingError("native process identity verification is Windows-only")
    _lease_fields(lease)
    try:
        import psutil

        process = psutil.Process(lease["pid"])
        process_record = {
            "pid": int(process.pid),
            "exePath": process.exe(),
            "startedAt": float(process.create_time()),
            "version": _read_file_version(lease["exePath"]),
        }
    except NativeBindingError:
        raise
    except Exception as exc:
        raise NativeBindingError("bound Weixin process is unavailable") from exc

    window = _read_bound_window(lease["hwnd"])
    if gate_module is None:
        vendor_name = "dsh_wechat_bridge.vendor"
    else:
        package = getattr(gate_module, "__package__", None)
        if not isinstance(package, str) or not package:
            raise NativeBindingError("legacy gate package cannot be resolved")
        vendor_name = f"{package}.vendor"
    try:
        vendor = importlib.import_module(vendor_name)
        loaded = vendor.load_db_module()._find_weixin_module(lease["pid"])
    except Exception as exc:
        raise NativeBindingError("bound Weixin.dll could not be rediscovered") from exc
    if not loaded:
        raise NativeBindingError("bound Weixin.dll could not be rediscovered")
    try:
        _base, size, path = loaded
        module = {"path": str(path), "base": int(_base), "size": int(size)}
    except (TypeError, ValueError, OverflowError) as exc:
        raise NativeBindingError("bound Weixin.dll identity could not be verified") from exc
    return {
        "process": process_record,
        "windows": [window] if window is not None else [],
        "module": module,
    }


def _account_candidates(db_root: str | os.PathLike[str], bot_wxid: str) -> list[Path]:
    """Mirror the legacy resolver's exact wxid[/_four-char-hash] directory rule."""
    root = Path(db_root).resolve(strict=True)
    matches = []
    for entry in root.iterdir():
        if not entry.is_dir() or not (entry / "db_storage").is_dir():
            continue
        if entry.name == bot_wxid or (
            entry.name.startswith(bot_wxid + "_")
            and len(entry.name) == len(bot_wxid) + 5
            and all(ch.isalnum() for ch in entry.name[-4:])
        ):
            matches.append(entry.resolve())
    return sorted(matches, key=lambda p: p.name.casefold())


def _read_bound_account_process(pid: int) -> dict[str, Any]:
    """Read one PID only; a prepared binding never triggers process_iter()."""
    try:
        import psutil

        process = psutil.Process(pid)
        return {
            "pid": int(process.pid),
            "exePath": process.exe(),
            "startedAt": float(process.create_time()),
            "openFiles": [row.path for row in process.open_files()],
        }
    except Exception as exc:
        raise NativeBindingError("bound Weixin account process could not be verified") from exc


def _path_is_child(path: str, root: str) -> bool:
    normalized_path, normalized_root = _norm_path(path), _norm_path(root)
    try:
        return normalized_path != normalized_root and os.path.commonpath(
            (normalized_path, normalized_root)
        ) == normalized_root
    except ValueError:
        return False


def validate_prepared_probe_binding(
    config: Mapping[str, Any],
    binding: Mapping[str, Any],
    *,
    snapshot_reader: Callable[[Mapping[str, Any]], Mapping[str, Any]] | None = None,
    account_process_reader: Callable[[int], Mapping[str, Any]] | None = None,
) -> None:
    """Validate a prepared account/window snapshot against config and the live OS.

    This path is for a previously prepared binding. It verifies the exact PID,
    HWND and module and reads only that PID's process record/open files; it never
    scans all Weixin processes or falls back to another account.
    """
    required = (
        "pid", "processStartedAt", "exePath", "version", "hwnd", "mainWindowClass",
        "mainWindowTitle", "modulePath", "moduleBase", "moduleSize", "accountName", "accountPath",
    )
    if not isinstance(config, Mapping) or not isinstance(binding, Mapping):
        raise NativeBindingError("prepared Weixin binding is invalid")
    if any(key not in binding for key in required):
        raise NativeBindingError("prepared Weixin binding is incomplete")
    if any(not isinstance(config.get(key), str) or not config[key].strip() for key in (
        "dbRoot", "botWxid", "expectedExe", "expectedVersion", "gateModule",
        "mainWindowClass", "mainWindowTitle",
    )):
        raise NativeBindingError("prepared Weixin config is incomplete")
    if (type(binding["moduleBase"]) is not int or binding["moduleBase"] <= 0
            or type(binding["moduleSize"]) is not int or binding["moduleSize"] <= 0):
        raise NativeBindingError("prepared Weixin module identity is invalid")
    lease = {
        "pid": binding["pid"],
        "startedAt": binding["processStartedAt"],
        "exePath": binding["exePath"],
        "version": binding["version"],
        "hwnd": binding["hwnd"],
        "mainWindowClass": binding["mainWindowClass"],
        "mainWindowTitle": binding["mainWindowTitle"],
        "modulePath": binding["modulePath"],
        "moduleSize": binding["moduleSize"],
        "moduleBase": binding["moduleBase"],
    }
    _lease_fields(lease)
    if (not isinstance(binding["accountName"], str) or not binding["accountName"]
            or not isinstance(binding["accountPath"], str) or not binding["accountPath"]):
        raise NativeBindingError("prepared Weixin account identity is invalid")

    try:
        expected_exe = str(Path(config["expectedExe"]).resolve(strict=True))
        expected_module = str(Path(config["gateModule"]).resolve(strict=True))
        db_root = Path(config["dbRoot"]).resolve(strict=True)
    except (OSError, TypeError, ValueError) as exc:
        raise NativeBindingError("prepared Weixin paths could not be verified") from exc
    if (_norm_path(binding["exePath"]) != _norm_path(expected_exe)
            or binding["version"] != config["expectedVersion"]):
        raise NativeBindingError("prepared Weixin process does not match configured executable")
    if (_norm_path(binding["modulePath"]) != _norm_path(expected_module)
            or binding["mainWindowClass"] != config["mainWindowClass"]
            or binding["mainWindowTitle"] != config["mainWindowTitle"]):
        raise NativeBindingError("prepared Weixin window or DLL does not match config")
    try:
        raw_rva = config.get("gateRva")
        if type(raw_rva) is bool:
            raise ValueError("boolean RVA")
        rva = int(raw_rva, 0) if isinstance(raw_rva, str) else int(raw_rva)
    except (TypeError, ValueError) as exc:
        raise NativeBindingError("prepared Weixin gate RVA is invalid") from exc
    if not 0 <= rva < binding["moduleSize"]:
        raise NativeBindingError("prepared Weixin gate RVA is outside the loaded DLL")

    try:
        account_path = Path(binding["accountPath"]).resolve(strict=True)
        candidates = _account_candidates(db_root, config["botWxid"])
    except (OSError, TypeError, ValueError) as exc:
        raise NativeBindingError("prepared Weixin account directory could not be verified") from exc
    if len(candidates) != 1:
        raise NativeBindingError("configured bot wxid does not resolve to one account directory")
    account = candidates[0]
    if binding["accountName"] != account.name or _norm_path(str(account_path)) != _norm_path(str(account)):
        raise NativeBindingError("prepared Weixin account directory does not match config")

    reader = snapshot_reader or _read_native_snapshot
    try:
        validate_native_lease_snapshot(lease, reader(lease))
    except NativeBindingError:
        raise
    except Exception as exc:
        raise NativeBindingError("prepared Weixin identity snapshot could not be verified") from exc

    account_reader = account_process_reader or _read_bound_account_process
    try:
        process = account_reader(binding["pid"])
    except NativeBindingError:
        raise
    except Exception as exc:
        raise NativeBindingError("prepared Weixin account handles could not be verified") from exc
    if not isinstance(process, Mapping):
        raise NativeBindingError("prepared Weixin account process record is invalid")
    if type(process.get("pid")) is not int or process["pid"] != binding["pid"]:
        raise NativeBindingError("prepared Weixin PID was reused")
    try:
        process_started_value = process["startedAt"]
        if (not isinstance(process_started_value, (int, float))
                or isinstance(process_started_value, bool)
                or not math.isfinite(float(process_started_value))):
            raise ValueError("invalid process start time")
        process_exe = _norm_path(process["exePath"])
        process_started = float(process_started_value)
    except (KeyError, TypeError, ValueError, OSError, OverflowError) as exc:
        raise NativeBindingError("prepared Weixin process identity could not be verified") from exc
    if (process_exe != _norm_path(binding["exePath"])
            or not math.isfinite(process_started)
            or abs(process_started - float(binding["processStartedAt"])) > 0.01):
        raise NativeBindingError("prepared Weixin process identity changed")
    opened = process.get("openFiles")
    if not isinstance(opened, (list, tuple)) or any(not isinstance(path, str) for path in opened):
        raise NativeBindingError("prepared Weixin database handles could not be verified")
    db_storage = str(account / "db_storage")
    if not any(_path_is_child(path, db_storage) for path in opened):
        raise NativeBindingError("prepared Weixin process no longer has the configured bot database open")


def resolve_prepared_binding(
    config: Mapping[str, Any],
    binding: Mapping[str, Any],
    *,
    snapshot_reader: Callable[[Mapping[str, Any]], Mapping[str, Any]] | None = None,
    account_process_reader: Callable[[int], Mapping[str, Any]] | None = None,
) -> dict[str, Any]:
    """Return an owned prepared snapshot only after full live identity checks."""
    validate_prepared_probe_binding(
        config,
        binding,
        snapshot_reader=snapshot_reader,
        account_process_reader=account_process_reader,
    )
    return dict(binding)


def verify_native_lease_identity(
    lease: Mapping[str, Any],
    *,
    snapshot_reader: Callable[[Mapping[str, Any]], Mapping[str, Any]] | None = None,
    gate_module: Any = None,
) -> None:
    """Fail closed unless the live process, exact bound HWND, and DLL still match."""
    reader = snapshot_reader
    if reader is None:
        reader = lambda current: _read_native_snapshot(current, gate_module=gate_module)
    validate_native_lease_snapshot(lease, reader(lease))


def make_native_memory_factory(
    gate_module: Any,
    *,
    snapshot_reader: Callable[[Mapping[str, Any]], Mapping[str, Any]] | None = None,
) -> type:
    """Return the legacy memory class with lease verification bound to this overlay."""
    base = getattr(gate_module, "Win32ProcessMemory", None)
    if not isinstance(base, type):
        raise TypeError("gate_module must expose Win32ProcessMemory")

    class NativeWin32ProcessMemory(base):
        def verify_identity(self, lease: Mapping[str, Any]) -> None:
            verify_native_lease_identity(
                lease,
                snapshot_reader=snapshot_reader,
                gate_module=gate_module,
            )

    NativeWin32ProcessMemory.__name__ = "NativeWin32ProcessMemory"
    return NativeWin32ProcessMemory

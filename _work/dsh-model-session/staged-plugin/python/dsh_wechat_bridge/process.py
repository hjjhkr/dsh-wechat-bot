"""Fail-closed binding to one configured Weixin process and account directory."""

from __future__ import annotations

import ctypes
import os
from ctypes import wintypes
from pathlib import Path
from typing import Any, Iterable


class ProcessBindingError(RuntimeError):
    pass


def _norm_path(path: str | Path) -> str:
    return os.path.normcase(os.path.realpath(os.fspath(path)))


def account_candidates(db_root: str | Path, bot_wxid: str) -> list[Path]:
    """Find the exact wxid directory (optionally followed by its four-char hash)."""
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


def select_process_record(
    records: Iterable[dict[str, Any]], expected_exe: str | Path, account_db: str | Path
) -> dict[str, Any]:
    """Require one exact executable whose open file proves the configured account."""
    exe_path = _norm_path(expected_exe)
    account_path = _norm_path(account_db)
    selected = []
    for record in records:
        try:
            if _norm_path(record["exePath"]) != exe_path:
                continue
            files = [_norm_path(path) for path in record["openFiles"]]
            if any(path.startswith(account_path.rstrip(os.sep) + os.sep) for path in files):
                selected.append(record)
        except (KeyError, TypeError, OSError):
            continue
    if len(selected) != 1:
        raise ProcessBindingError("configured account is not bound to exactly one Weixin process")
    return selected[0]


def _file_version(path: Path) -> str:
    try:
        import win32api

        data = win32api.GetFileVersionInfo(str(path), "\\")
        ms, ls = int(data["FileVersionMS"]), int(data["FileVersionLS"])
        return f"{ms >> 16}.{ms & 0xffff}.{ls >> 16}.{ls & 0xffff}"
    except Exception as exc:
        raise ProcessBindingError("Weixin executable version could not be verified") from exc


def _window_records(pid: int) -> list[dict[str, Any]]:
    if os.name != "nt":
        raise ProcessBindingError("Windows UIA binding is available only on Windows")
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.EnumWindows.argtypes = [ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM), wintypes.LPARAM]
    user32.EnumWindows.restype = wintypes.BOOL
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    user32.GetWindow.argtypes = [wintypes.HWND, wintypes.UINT]
    user32.GetWindow.restype = wintypes.HWND
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.restype = ctypes.c_int
    user32.GetWindowTextLengthW.argtypes = [wintypes.HWND]
    user32.GetWindowTextLengthW.restype = ctypes.c_int
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetWindowTextW.restype = ctypes.c_int
    try:
        get_window_long_ptr = user32.GetWindowLongPtrW
    except AttributeError:
        get_window_long_ptr = user32.GetWindowLongW
    get_window_long_ptr.argtypes = [wintypes.HWND, ctypes.c_int]
    get_window_long_ptr.restype = ctypes.c_ssize_t
    cb_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    rows: list[dict[str, Any]] = []

    @cb_type
    def callback(hwnd: int, _lparam: int) -> bool:
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
        if owner.value != pid:
            return True
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, len(cls))
        title_length = max(0, int(user32.GetWindowTextLengthW(hwnd)))
        title = ctypes.create_unicode_buffer(title_length + 1)
        user32.GetWindowTextW(hwnd, title, len(title))
        style = int(get_window_long_ptr(hwnd, -16))
        extended_style = int(get_window_long_ptr(hwnd, -20))
        owner_hwnd = int(user32.GetWindow(hwnd, 4) or 0)  # GW_OWNER
        rows.append({
            "hwnd": int(hwnd),
            "pid": pid,
            "visible": bool(user32.IsWindowVisible(hwnd)),
            "ownerHwnd": owner_hwnd,
            "className": cls.value,
            "title": title.value,
            "captionStyle": (style & 0x00C00000) == 0x00C00000,  # WS_CAPTION
            "toolWindow": bool(extended_style & 0x00000080),  # WS_EX_TOOLWINDOW
        })
        return True

    if not user32.EnumWindows(callback, 0):
        raise ProcessBindingError("Weixin windows could not be enumerated")
    return rows


def select_main_window(
    records: Iterable[dict[str, Any]], expected_pid: int, expected_class: str, expected_title: str
) -> dict[str, Any]:
    if not expected_class or not expected_title:
        raise ProcessBindingError("configured Weixin main-window class and title are required")
    selected = [
        row for row in records
        if isinstance(row, dict)
        and type(row.get("pid")) is int and row["pid"] == expected_pid
        and type(row.get("hwnd")) is int and row["hwnd"] > 0
        and row.get("ownerHwnd") == 0
        and row.get("captionStyle") is True
        and row.get("toolWindow") is False
        and row.get("className") == expected_class
        and row.get("title") == expected_title
    ]
    if len(selected) != 1:
        raise ProcessBindingError("Weixin process does not have exactly one configured unowned main window")
    return selected[0]


def find_binding(config: dict[str, Any]) -> dict[str, Any]:
    """Resolve a unique live process, open-file account, top-level chat window and DLL."""
    if os.name != "nt":
        raise ProcessBindingError("Weixin binding is Windows-only")
    import psutil

    expected_exe = Path(config["expectedExe"]).resolve(strict=True)
    db_root = Path(config["dbRoot"]).resolve(strict=True)
    module_expected = Path(config["gateModule"]).resolve(strict=True)
    if _file_version(expected_exe) != config["expectedVersion"]:
        raise ProcessBindingError("Weixin executable version does not match the configured version")
    accounts = account_candidates(db_root, config["botWxid"])
    if len(accounts) != 1:
        raise ProcessBindingError("configured bot wxid does not resolve to one account directory")
    account = accounts[0]
    account_db = account / "db_storage"

    records = []
    for proc in psutil.process_iter(attrs=["pid", "exe", "create_time"]):
        try:
            info = proc.info
            if _norm_path(info.get("exe") or proc.exe()) != _norm_path(expected_exe):
                continue
            open_files = [row.path for row in proc.open_files()]
            records.append({
                "pid": int(info["pid"]),
                "exePath": info.get("exe") or proc.exe(),
                "startedAt": float(info.get("create_time") or proc.create_time()),
                "openFiles": open_files,
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError):
            continue
    selected = select_process_record(records, expected_exe, account_db)
    main_window = select_main_window(
        _window_records(selected["pid"]),
        selected["pid"],
        config["mainWindowClass"],
        config["mainWindowTitle"],
    )

    from .vendor import load_db_module

    reader = load_db_module()
    module = reader._find_weixin_module(selected["pid"])
    if not module:
        raise ProcessBindingError("Weixin.dll could not be located in the bound process")
    module_base, module_size, module_path = module
    if _norm_path(module_path) != _norm_path(module_expected):
        raise ProcessBindingError("loaded Weixin.dll path does not match the configured module")
    rva = config.get("gateRva")
    try:
        rva = int(rva, 0) if isinstance(rva, str) else int(rva)
    except (TypeError, ValueError) as exc:
        raise ProcessBindingError("gate RVA is invalid") from exc
    if not 0 <= rva < module_size:
        raise ProcessBindingError("gate RVA is outside the loaded Weixin.dll")
    return {
        "pid": selected["pid"],
        "processStartedAt": selected["startedAt"],
        "exePath": str(expected_exe),
        "version": config["expectedVersion"],
        "hwnd": main_window["hwnd"],
        "mainWindowClass": main_window["className"],
        "mainWindowTitle": main_window["title"],
        "modulePath": str(module_expected),
        "moduleBase": int(module_base),
        "moduleSize": int(module_size),
        "accountName": account.name,
        "accountPath": str(account),
    }


def verify_lease_identity(lease: dict[str, Any]) -> None:
    """Re-resolve PID, executable, start time, window owner and module on each access."""
    if os.name != "nt":
        raise ProcessBindingError("process identity verification is Windows-only")
    import psutil

    try:
        proc = psutil.Process(lease["pid"])
        if _norm_path(proc.exe()) != _norm_path(lease["exePath"]):
            raise ProcessBindingError("bound process executable changed")
        if abs(proc.create_time() - float(lease["startedAt"])) > 0.01:
            raise ProcessBindingError("bound process start time changed")
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError) as exc:
        raise ProcessBindingError("bound Weixin process is unavailable") from exc
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.GetWindowThreadProcessId.restype = wintypes.DWORD
    owner = wintypes.DWORD()
    if not user32.GetWindowThreadProcessId(lease["hwnd"], ctypes.byref(owner)) or owner.value != lease["pid"]:
        raise ProcessBindingError("bound main-window owner changed")
    main_window = select_main_window(
        _window_records(lease["pid"]),
        lease["pid"],
        lease["mainWindowClass"],
        lease["mainWindowTitle"],
    )
    if main_window["hwnd"] != lease["hwnd"]:
        raise ProcessBindingError("bound main window changed")
    if _file_version(Path(lease["exePath"])) != lease["version"]:
        raise ProcessBindingError("bound Weixin version changed")
    from .vendor import load_db_module

    module = load_db_module()._find_weixin_module(lease["pid"])
    if not module:
        raise ProcessBindingError("bound Weixin.dll is unavailable")
    _, module_size, module_path = module
    if (
        _norm_path(module_path) != _norm_path(lease["modulePath"])
        or int(module_size) != int(lease["moduleSize"])
        or Path(lease["modulePath"]).name.casefold() != "weixin.dll"
    ):
        raise ProcessBindingError("bound Weixin.dll identity changed")


def verify_account_binding(config: dict[str, Any], binding: dict[str, Any]) -> None:
    """Revalidate the dynamic process lease and its currently opened bot DB files."""
    verify_lease_identity({
        "pid": binding["pid"],
        "startedAt": binding["processStartedAt"],
        "exePath": binding["exePath"],
        "version": binding["version"],
        "hwnd": binding["hwnd"],
        "mainWindowClass": binding["mainWindowClass"],
        "mainWindowTitle": binding["mainWindowTitle"],
        "modulePath": binding["modulePath"],
        "moduleSize": binding["moduleSize"],
    })
    import psutil

    try:
        proc = psutil.Process(binding["pid"])
        opened = [_norm_path(row.path) for row in proc.open_files()]
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError) as exc:
        raise ProcessBindingError("bound Weixin database handles could not be verified") from exc
    account_db = _norm_path(Path(binding["accountPath"]) / "db_storage")
    if not any(path.startswith(account_db.rstrip(os.sep) + os.sep) for path in opened):
        raise ProcessBindingError("bound process no longer has the configured bot database open")
    if binding["accountName"] not in Path(binding["accountPath"]).parts:
        raise ProcessBindingError("bound bot account directory changed")
    if _norm_path(config["expectedExe"]) != _norm_path(binding["exePath"]):
        raise ProcessBindingError("configured executable changed after probe")
    if _norm_path(config["gateModule"]) != _norm_path(binding["modulePath"]):
        raise ProcessBindingError("configured Weixin.dll changed after probe")


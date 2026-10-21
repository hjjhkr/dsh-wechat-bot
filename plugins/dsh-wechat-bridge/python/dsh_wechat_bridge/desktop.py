"""Desktop identity and JSONL child transport; never switch the input desktop."""
from __future__ import annotations

import ctypes
from ctypes import wintypes as w
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
import uuid


def validate_desktop(value):
    if not isinstance(value, str) or not re.fullmatch(r"DshWeChatBot_[A-Za-z0-9_-]{1,64}", value):
        raise ValueError("invalid isolated desktop name")
    return value


def _desktop_api():
    user = ctypes.WinDLL("user32", use_last_error=True)
    user.GetThreadDesktop.argtypes, user.GetThreadDesktop.restype = [w.DWORD], w.HANDLE
    user.OpenInputDesktop.argtypes, user.OpenInputDesktop.restype = [w.DWORD, w.BOOL, w.DWORD], w.HANDLE
    user.OpenDesktopW.argtypes = [w.LPCWSTR, w.DWORD, w.BOOL, w.DWORD]
    user.OpenDesktopW.restype = w.HANDLE
    user.CloseDesktop.argtypes, user.CloseDesktop.restype = [w.HANDLE], w.BOOL
    user.GetUserObjectInformationW.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD)]
    user.GetUserObjectInformationW.restype = w.BOOL

    return user


def _desktop_name(user, handle):
    buf, needed = ctypes.create_unicode_buffer(256), w.DWORD()
    if not handle or not user.GetUserObjectInformationW(handle, 2, buf, ctypes.sizeof(buf), ctypes.byref(needed)):
        raise RuntimeError("desktop identity unavailable")
    return buf.value


def thread_desktop_name(thread_id=None):
    user = _desktop_api()
    if thread_id is None:
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.GetCurrentThreadId.restype = w.DWORD
        thread_id = kernel.GetCurrentThreadId()
    # GetThreadDesktop returns a borrowed handle, which must not be closed.
    return _desktop_name(user, user.GetThreadDesktop(thread_id))


def input_desktop_name():
    user = _desktop_api()
    handle = user.OpenInputDesktop(0, False, 1)
    if not handle:
        raise RuntimeError("input desktop unavailable")
    try:
        return _desktop_name(user, handle)
    finally:
        if not user.CloseDesktop(handle):
            raise RuntimeError("input desktop handle close failed")


def desktop_names():
    return thread_desktop_name(), input_desktop_name()


def desktop_available():
    try:
        return desktop_names() == ("Default", "Default")
    except Exception:
        return False


def require_window_desktop(binding, desktop):
    """Check the exact bound HWND's owner and thread desktop, without activating it."""
    user = _desktop_api()
    user.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
    user.GetWindowThreadProcessId.restype = w.DWORD
    # A foreign-desktop HWND is not accessible to the Default controller until
    # it has enumerated that desktop. Open read-only; never switch desktops.
    handle = user.OpenDesktopW(validate_desktop(desktop), 0, False, 0x0001)
    if not handle:
        raise RuntimeError("bound window desktop unavailable")
    try:
        if _desktop_name(user, handle) != desktop:
            raise RuntimeError("bound window desktop changed")
        matches = []
        callback_type = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
        user.EnumDesktopWindows.argtypes = [w.HANDLE, callback_type, w.LPARAM]
        user.EnumDesktopWindows.restype = w.BOOL

        @callback_type
        def visit(hwnd, _param):
            if hwnd == binding["hwnd"]:
                matches.append(hwnd)
            return True

        if not user.EnumDesktopWindows(handle, visit, 0):
            raise RuntimeError("bound window desktop enumeration failed")
        if len(matches) != 1:
            raise RuntimeError("bound window absent from configured desktop")
        owner = w.DWORD()
        thread_id = user.GetWindowThreadProcessId(binding["hwnd"], ctypes.byref(owner))
        if not thread_id or owner.value != binding["pid"]:
            raise RuntimeError("bound window owner changed")
    finally:
        if not user.CloseDesktop(handle):
            raise RuntimeError("bound window desktop handle close failed")


class DesktopChild:
    """One child on an existing desktop, with private inherited stdio pipes."""

    def __init__(self, desktop):
        import msvcrt
        import pywintypes
        import win32api
        import win32con
        import win32pipe
        import win32process

        validate_desktop(desktop)
        if thread_desktop_name() != "Default":
            raise RuntimeError("controller must run on the default desktop")
        self.process = None
        self.streams = []
        self.replies = queue.Queue()
        self.issued = set()
        security = pywintypes.SECURITY_ATTRIBUTES()
        security.bInheritHandle = True
        handles = []
        try:
            stdin_read, stdin_write = win32pipe.CreatePipe(security, 0)
            handles.extend([stdin_read, stdin_write])
            stdout_read, stdout_write = win32pipe.CreatePipe(security, 0)
            handles.extend([stdout_read, stdout_write])
            stderr_read, stderr_write = win32pipe.CreatePipe(security, 0)
            handles.extend([stderr_read, stderr_write])
            for handle in (stdin_write, stdout_read, stderr_read):
                win32api.SetHandleInformation(handle, win32con.HANDLE_FLAG_INHERIT, 0)
            si = win32process.STARTUPINFO()
            si.lpDesktop = "WinSta0\\" + desktop
            si.dwFlags = win32con.STARTF_USESTDHANDLES | 0x80
            si.hStdInput, si.hStdOutput, si.hStdError = stdin_read, stdout_write, stderr_write
            script = Path(__file__).resolve().parent.parent / "isolated_worker.py"
            argv = [sys.executable, "-u", "-B", "-X", "utf8", str(script), desktop]
            self.process, thread, self.pid, _ = win32process.CreateProcess(
                sys.executable, subprocess.list2cmdline(argv), None, None, True,
                win32con.CREATE_NO_WINDOW, None, str(script.parent), si)
            thread.Close()
            for handle in (stdin_read, stdout_write, stderr_write):
                handle.Close()
                handles.remove(handle)
            for handle, mode, flags in (
                (stdin_write, "w", os.O_WRONLY),
                (stdout_read, "r", os.O_RDONLY),
                (stderr_read, "r", os.O_RDONLY),
            ):
                fd = msvcrt.open_osfhandle(handle.Detach(), flags | os.O_BINARY)
                handles.remove(handle)
                self.streams.append(os.fdopen(fd, mode, encoding="utf-8", buffering=1))
            self.stdin, self.stdout, self.stderr = self.streams
            self.reader = threading.Thread(target=self._read, daemon=True, name="wechat-desktop-rpc")
            self.drainer = threading.Thread(target=self._drain, daemon=True, name="wechat-desktop-stderr")
            self.reader.start()
            self.drainer.start()
        except Exception:
            for handle in handles:
                handle.Close()
            for stream in self.streams:
                stream.close()
            if self.process is not None:
                self.process.Close()
            raise

    def alive(self):
        import win32event
        return self.process is not None and win32event.WaitForSingleObject(self.process, 0) == win32event.WAIT_TIMEOUT

    def _read(self):
        try:
            for line in self.stdout:
                self.replies.put(json.loads(line))
        except Exception:
            self.replies.put({"transportError": True})
        finally:
            self.replies.put({"eof": True})

    def _drain(self):
        try:
            while self.stderr.read(8192):
                pass  # Library errors may contain private text; never expose them.
        except (OSError, ValueError):
            return

    def request(self, method, params, timeout=30):
        if not self.alive():
            raise RuntimeError("isolated worker unavailable")
        request_id = uuid.uuid4().hex
        self.issued.add(request_id)
        self.stdin.write(json.dumps({"id": request_id, "method": method, "params": params}, ensure_ascii=False) + "\n")
        self.stdin.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                response = self.replies.get(timeout=max(0.001, deadline - time.monotonic()))
            except queue.Empty:
                raise RuntimeError("isolated worker result unknown") from None
            if response.get("id") not in self.issued:
                raise RuntimeError("isolated worker protocol ended or invalid")
            self.issued.remove(response["id"])
            if response["id"] == request_id:
                if "error" in response or not isinstance(response.get("result"), dict):
                    raise RuntimeError("isolated worker request failed")
                return response["result"]
            if time.monotonic() >= deadline:
                raise RuntimeError("isolated worker result unknown")

    def close(self):
        import win32event
        result = None
        try:
            result = self.request("close", {}, timeout=30)
        except Exception:
            # Still close our pipe and wait for the child's finally cleanup.
            # Absence of its explicit gate readback must remain a failure.
            result = None
        finally:
            # EOF also makes the inner worker restore its gate after a failed RPC.
            self.stdin.close()
        exited = win32event.WaitForSingleObject(self.process, 3000) == win32event.WAIT_OBJECT_0
        if not exited:
            raise RuntimeError("isolated worker exit unconfirmed")
        self.reader.join(1)
        self.drainer.join(1)
        self.stdout.close()
        self.stderr.close()
        self.process.Close()
        self.process = None
        if not isinstance(result, dict) or result.get("closed") is not True or result.get("gateActive") is not False or result.get("gateRestored") is not True:
            raise RuntimeError("isolated worker gate cleanup unconfirmed")
        return result

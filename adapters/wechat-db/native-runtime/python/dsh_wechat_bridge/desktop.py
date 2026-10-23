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


class ForceCloseError(RuntimeError):
    """A safe force-stop refusal with a stable worker-facing error code."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


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
        import win32event
        import win32job
        import win32pipe
        import win32process

        validate_desktop(desktop)
        if thread_desktop_name() != "Default":
            raise RuntimeError("controller must run on the default desktop")
        self.process = None
        self.job = None
        self.pid = None
        self.streams = []
        self._member_processes = {}
        self.replies = queue.Queue()
        self.issued = set()
        self._close_ack = None
        self._close_started = False
        self._stdin_closed = False
        self._resources_closed = False
        self._tree_exit_confirmed = False
        security = pywintypes.SECURITY_ATTRIBUTES()
        security.bInheritHandle = True
        handles = []
        thread = None
        try:
            self.job = win32job.CreateJobObject(None, "")
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
                win32con.CREATE_NO_WINDOW | win32con.CREATE_SUSPENDED,
                None, str(script.parent), si)
            win32job.AssignProcessToJobObject(self.job, self.process)
            self._member_processes[self.pid] = self.process
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
            if win32process.ResumeThread(thread) == 0xFFFFFFFF:
                raise RuntimeError("isolated worker resume failed")
            try:
                thread.Close()
            except Exception:
                pass
            thread = None
        except Exception:
            if thread is not None:
                try:
                    thread.Close()
                except Exception:
                    pass
            if self.process is not None:
                try:
                    # The child has not resumed yet: only this owned root can exist.
                    win32process.TerminateProcess(self.process, 1)
                    win32event.WaitForSingleObject(self.process, 3000)
                except Exception:
                    pass
            for handle in handles:
                try:
                    handle.Close()
                except Exception:
                    pass
            for stream in self.streams:
                try:
                    stream.close()
                except Exception:
                    pass
            for reader in (getattr(self, "reader", None), getattr(self, "drainer", None)):
                if reader is not None:
                    try:
                        reader.join(1)
                    except Exception:
                        pass
            if self.process is not None:
                try:
                    self.process.Close()
                except Exception:
                    pass
            if self.job is not None:
                try:
                    self.job.Close()
                except Exception:
                    pass
            raise

    def alive(self):
        return self.process is not None and not self._wait_for_tree_exit(0)

    def _wait_for_tree_exit(self, timeout_ms):
        if self.job is None:
            return self._tree_exit_confirmed
        import win32api
        import win32con
        import win32event
        import win32job

        deadline = time.monotonic() + max(0, timeout_ms) / 1000
        while True:
            try:
                pids = self._capture_job_members(win32api, win32con, win32job)
                accounting = win32job.QueryInformationJobObject(
                    self.job, win32job.JobObjectBasicAccountingInformation
                )
                active = int(accounting["ActiveProcesses"])
                handles = list(self._member_processes.values())
                if self.process is not None and all(self.process is not handle for handle in handles):
                    handles.append(self.process)
                all_signaled = all(
                    win32event.WaitForSingleObject(handle, 0) == win32event.WAIT_OBJECT_0
                    for handle in handles
                )
            except Exception:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                time.sleep(min(0.025, remaining))
                continue
            if active == 0 and not pids and all_signaled:
                self._tree_exit_confirmed = True
                return True
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            time.sleep(min(0.025, remaining))

    def _capture_job_members(self, win32api=None, win32con=None, win32job=None):
        """Retain and verify handles for every process currently owned by this job."""
        if win32api is None:
            import win32api
        if win32con is None:
            import win32con
        import win32event
        if win32job is None:
            import win32job

        pids = {int(pid) for pid in win32job.QueryInformationJobObject(
            self.job, win32job.JobObjectBasicProcessIdList
        )}
        accounting = win32job.QueryInformationJobObject(
            self.job, win32job.JobObjectBasicAccountingInformation
        )
        if len(pids) < int(accounting["ActiveProcesses"]):
            raise RuntimeError("owned process membership is incomplete")

        access = win32con.PROCESS_QUERY_LIMITED_INFORMATION | win32con.SYNCHRONIZE
        for pid, old_handle in list(self._member_processes.items()):
            signaled = win32event.WaitForSingleObject(old_handle, 0) == win32event.WAIT_OBJECT_0
            if pid not in pids:
                if not signaled:
                    raise RuntimeError("owned process disappeared from the active job list")
                if old_handle is self.process:
                    del self._member_processes[pid]
                else:
                    old_handle.Close()
                    del self._member_processes[pid]
                continue
            if not signaled:
                if not win32job.IsProcessInJob(old_handle, self.job):
                    raise RuntimeError("owned process membership changed")
                continue
            # The PID is still in this job's live list, so the old signaled
            # handle refers to an exited process and may have been reused.
            # Keep the original root handle separately for exit confirmation.
            if old_handle is not self.process:
                old_handle.Close()
            del self._member_processes[pid]

        for pid in pids:
            if pid in self._member_processes:
                continue
            handle = win32api.OpenProcess(access, False, pid)
            try:
                if not win32job.IsProcessInJob(handle, self.job):
                    raise RuntimeError("owned process membership could not be verified")
            except Exception:
                handle.Close()
                raise
            self._member_processes[pid] = handle

        confirmed_pids = {int(pid) for pid in win32job.QueryInformationJobObject(
            self.job, win32job.JobObjectBasicProcessIdList
        )}
        confirmed_accounting = win32job.QueryInformationJobObject(
            self.job, win32job.JobObjectBasicAccountingInformation
        )
        if (
            confirmed_pids != pids
            or len(confirmed_pids) < int(confirmed_accounting["ActiveProcesses"])
        ):
            raise RuntimeError("owned process membership changed during verification")
        return confirmed_pids

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
        if self._stdin_closed or not self.alive():
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

    @staticmethod
    def _verified_close_result(result):
        if (
            not isinstance(result, dict)
            or result.get("closed") is not True
            or result.get("gateActive") is not False
            or result.get("gateRestored") is not True
        ):
            return None
        return {"closed": True, "gateActive": False, "gateRestored": True}

    def _close_stdin_once(self):
        if self._stdin_closed:
            return
        self._stdin_closed = True
        self.stdin.close()

    def _finish(self):
        if self._resources_closed:
            return
        failed = False
        for thread in (self.reader, self.drainer):
            try:
                thread.join(1)
            except Exception:
                failed = True
        for stream in (self.stdout, self.stderr):
            try:
                stream.close()
            except Exception:
                failed = True

        handles = list(self._member_processes.values())
        if self.process is not None and all(self.process is not handle for handle in handles):
            handles.append(self.process)
        closed = set()
        for handle in handles:
            if id(handle) in closed:
                continue
            try:
                handle.Close()
            except Exception:
                failed = True
            else:
                closed.add(id(handle))
        self._member_processes = {
            pid: handle for pid, handle in self._member_processes.items()
            if id(handle) not in closed
        }
        if self.process is not None and id(self.process) in closed:
            self.process = None
        if self.job is not None:
            try:
                self.job.Close()
            except Exception:
                failed = True
            else:
                self.job = None
        if failed:
            raise RuntimeError("isolated worker handle cleanup is incomplete") from None
        self._resources_closed = True

    def close(self):
        if self._resources_closed:
            if self._close_ack is None:
                raise RuntimeError("isolated worker gate cleanup unconfirmed")
            return self._close_ack

        if not self._close_started:
            self._close_started = True
            try:
                result = self.request("close", {}, timeout=30)
            except Exception:
                result = None
            verified = self._verified_close_result(result)
            if verified is not None:
                self._close_ack = verified
            try:
                self._close_stdin_once()
            except Exception:
                pass

        if not self._wait_for_tree_exit(3000):
            raise RuntimeError("isolated worker exit unconfirmed")
        self._finish()
        if self._close_ack is None:
            raise RuntimeError("isolated worker gate cleanup unconfirmed")
        return self._close_ack

    def force_close(self):
        if self._close_ack is None:
            raise ForceCloseError(
                "force_stop_ack_required",
                "force stop requires a verified gate-restored close acknowledgement",
            )
        if self._resources_closed:
            return self._close_ack
        if not self._close_started or not self._stdin_closed:
            raise ForceCloseError("force_stop_not_ready", "a failed normal close is required before force stop")
        if self._wait_for_tree_exit(0):
            self._finish()
            return self._close_ack

        import win32job

        if self.job is None:
            raise ForceCloseError("force_stop_unavailable", "owned worker job is unavailable")
        try:
            pids = self._capture_job_members(win32job=win32job)
            accounting = win32job.QueryInformationJobObject(
                self.job, win32job.JobObjectBasicAccountingInformation
            )
            active = int(accounting["ActiveProcesses"])
            if len(pids) < active:
                raise RuntimeError("owned process membership is incomplete")
        except Exception:
            raise ForceCloseError(
                "force_stop_failed",
                "owned process membership could not be verified; force stop was not attempted",
            ) from None
        if active == 0:
            if self._wait_for_tree_exit(1000):
                self._finish()
                return self._close_ack
            raise ForceCloseError("force_stop_failed", "owned worker exit could not be confirmed")
        try:
            win32job.TerminateJobObject(self.job, 1)
        except Exception:
            raise ForceCloseError("force_stop_failed", "owned worker force termination failed") from None
        if not self._wait_for_tree_exit(5000):
            raise ForceCloseError("force_stop_failed", "owned worker process tree exit is unconfirmed")
        self._finish()
        return self._close_ack

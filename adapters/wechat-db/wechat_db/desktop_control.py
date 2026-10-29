"""Explicit window/get,set control for the bot's named Windows desktop.

The sender never switches desktops. Only a user's window/set or login action
enters this module. A separate return toolbar remains on the bot desktop.
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes as w
from dataclasses import dataclass
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid


class DesktopControlError(RuntimeError):
    pass


@dataclass(frozen=True)
class DesktopSpec:
    config: Path
    exe: Path
    desktop: str
    bot_id: str
    bot_name: str
    root: Path


def load_spec(path):
    config = Path(path).resolve(strict=True)
    worker = json.loads(config.read_text(encoding='utf-8'))['worker']
    desktop = worker['desktopName']
    exe = Path(worker['expectedExe'])
    root = Path(worker['stateRoot'])
    if (not isinstance(desktop, str) or not re.fullmatch(r'DshWeChatBot_[A-Za-z0-9_-]{1,64}', desktop)
            or not exe.is_absolute() or not exe.is_file() or not root.is_absolute()
            or not worker.get('botWxid') or not worker.get('botName')):
        raise DesktopControlError('invalid bot desktop configuration')
    return DesktopSpec(config, exe.resolve(), desktop, worker['botWxid'], worker['botName'], root / 'desktop-control')


def _process(pid):
    import psutil
    try:
        process = psutil.Process(pid)
        return {'exe': process.exe(), 'start': process.create_time(), 'args': process.cmdline()}
    except psutil.NoSuchProcess:
        return None


def session_running(spec, session, process_reader=_process):
    if session.get('desktop') != spec.desktop or session.get('botWxid') != spec.bot_id:
        raise DesktopControlError('desktop session does not belong to this bot')
    if type(session.get('pid')) is not int or not isinstance(session.get('startedAt'), (int, float)):
        return False
    current = process_reader(session['pid'])
    if current is None:
        return False
    # A different creation time means the recorded instance exited and its PID
    # was reused. It is not our process, even if it is another WeChat instance.
    if abs(current['start'] - session['startedAt']) > 0.01:
        return False
    if os.path.normcase(os.path.realpath(current['exe'])) != os.path.normcase(os.path.realpath(spec.exe)):
        raise DesktopControlError('bot process identity changed; refusing to adopt another process')
    return True


def session_identity(spec, session, process_reader=_process):
    """Return the verified process instance recorded for this bot, if it is running."""
    if session is None:
        return None
    if (not isinstance(session, dict)
            or type(session.get('pid')) is not int or session['pid'] <= 0
            or not isinstance(session.get('startedAt'), (int, float))
            or isinstance(session.get('startedAt'), bool)
            or not math.isfinite(session['startedAt'])):
        raise DesktopControlError('bot session process identity is invalid')
    if not session_running(spec, session, process_reader):
        return None
    return {'pid': session['pid'], 'startedAt': float(session['startedAt'])}


def _publish(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
    os.replace(temporary, path)


def _read(path):
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding='utf-8'))


def _user():
    user = ctypes.WinDLL('user32', use_last_error=True)
    user.OpenInputDesktop.argtypes, user.OpenInputDesktop.restype = [w.DWORD, w.BOOL, w.DWORD], w.HANDLE
    user.OpenDesktopW.argtypes, user.OpenDesktopW.restype = [w.LPCWSTR, w.DWORD, w.BOOL, w.DWORD], w.HANDLE
    user.CreateDesktopW.argtypes = [w.LPCWSTR, w.LPCWSTR, ctypes.c_void_p, w.DWORD, w.DWORD, ctypes.c_void_p]
    user.CreateDesktopW.restype = w.HANDLE
    user.CloseDesktop.argtypes, user.CloseDesktop.restype = [w.HANDLE], w.BOOL
    user.SwitchDesktop.argtypes, user.SwitchDesktop.restype = [w.HANDLE], w.BOOL
    user.SetThreadDesktop.argtypes, user.SetThreadDesktop.restype = [w.HANDLE], w.BOOL
    user.GetThreadDesktop.argtypes, user.GetThreadDesktop.restype = [w.DWORD], w.HANDLE
    user.GetUserObjectInformationW.argtypes = [w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD)]
    user.GetUserObjectInformationW.restype = w.BOOL
    return user


def _input_desktop():
    user = _user()
    handle = user.OpenInputDesktop(0, False, 1)
    if not handle:
        raise DesktopControlError('input desktop unavailable; unlock Windows first')
    try:
        name, needed = ctypes.create_unicode_buffer(256), w.DWORD()
        if not user.GetUserObjectInformationW(handle, 2, name, ctypes.sizeof(name), ctypes.byref(needed)):
            raise DesktopControlError('input desktop identity unavailable')
        return name.value
    finally:
        user.CloseDesktop(handle)


def _switch(desktop):
    user = _user()
    handle = user.OpenDesktopW(desktop, 0, False, 0x0100)
    if not handle:
        raise DesktopControlError('requested desktop is unavailable')
    try:
        if not user.SwitchDesktop(handle):
            raise DesktopControlError('desktop switch was refused')
    finally:
        user.CloseDesktop(handle)


class _WindowsBackend:
    def __init__(self, spec, python):
        self.spec, self.python = spec, python

    input_desktop = staticmethod(_input_desktop)
    switch = staticmethod(_switch)

    def running(self):
        session = _read(self.spec.root / 'session.json')
        return session_running(self.spec, session) if session else False

    def process_identity(self):
        return session_identity(self.spec, _read(self.spec.root / 'session.json'))

    def _toolbar_ready(self):
        toolbar = _read(self.spec.root / 'toolbar.json')
        if not toolbar or toolbar.get('desktop') != self.spec.desktop:
            return False
        current = _process(toolbar['pid'])
        # Windows venv executables are redirectors: Process.exe() reports the
        # base interpreter. Require that interpreter plus this exact helper/config.
        base = Path(sys._base_executable)
        interpreters = {os.path.normcase(os.path.realpath(path)) for path in
                        (self.python, base, base.with_name('python.exe'), base.with_name('pythonw.exe'))}
        args = current.get('args', []) if current else []
        return bool(current and abs(current['start'] - toolbar['startedAt']) < 0.01
                    and os.path.normcase(os.path.realpath(current['exe'])) in interpreters
                    and str(Path(__file__).resolve()) in args and str(self.spec.config) in args
                    and args[-1] == 'toolbar')

    def ensure_started(self):
        if self.running() and self._toolbar_ready():
            return True
        # The keeper takes an exclusive Windows file lock before launching WeChat.
        # Concurrent UI requests cannot create two bot processes.
        self.spec.root.mkdir(parents=True, exist_ok=True)
        subprocess.Popen([self.python, '-B', str(Path(__file__).resolve()), '--sender-config', str(self.spec.config), 'keeper'],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         close_fds=True, creationflags=0x08000000, cwd=str(self.spec.root))
        until = time.monotonic() + 12
        while time.monotonic() < until:
            if self.running() and self._toolbar_ready():
                return True
            error = _read(self.spec.root / 'error.json')
            if error and time.time() - error['at'] < 15:
                raise DesktopControlError(error['code'])
            time.sleep(0.1)
        raise DesktopControlError('bot login window or return toolbar did not become ready')


class DesktopController:
    def __init__(self, config_path, *, python_command=None, backend=None):
        self.spec = load_spec(config_path)
        self.backend = backend or _WindowsBackend(self.spec, python_command or sys.executable)

    def state(self):
        lifecycle = self.lifecycle_state()
        return {'visible': lifecycle['visible'], 'running': lifecycle['running']}

    def lifecycle_state(self):
        current = self.backend.input_desktop()
        return {
            'visible': current == self.spec.desktop,
            'returned': current == 'Default',
            'running': self.backend.running(),
        }

    def process_identity(self):
        return self.backend.process_identity()

    def set_visible(self, visible):
        if type(visible) is not bool:
            raise DesktopControlError('visible must be a boolean')
        if self.backend.input_desktop() not in ('Default', self.spec.desktop):
            raise DesktopControlError('unlock Windows and return to the normal desktop first')
        if visible and not self.backend.ensure_started():
            raise DesktopControlError('return toolbar is not ready')
        if self.backend.input_desktop() not in ('Default', self.spec.desktop):
            raise DesktopControlError('input desktop changed while preparing the bot window')
        self.backend.switch(self.spec.desktop if visible else 'Default')
        return self.state()


def _spawn_on_desktop(spec, executable, arguments):
    import win32api
    import win32con
    import win32process
    startup = win32process.STARTUPINFO()
    startup.lpDesktop = 'WinSta0\\' + spec.desktop
    startup.dwFlags = 0x80
    process, thread, pid, _ = win32process.CreateProcess(
        executable, subprocess.list2cmdline(arguments), None, None, False,
        win32con.CREATE_NO_WINDOW, None, str(spec.root), startup)
    win32api.CloseHandle(thread)
    win32api.CloseHandle(process)
    return pid


def _keeper(spec):
    import psutil
    import win32api
    import win32con
    import win32file
    lock = None
    desktop = None
    spec.root.mkdir(parents=True, exist_ok=True)
    try:
        lock = win32file.CreateFile(str(spec.root / 'keeper.lock'), win32con.GENERIC_READ | win32con.GENERIC_WRITE,
                                   0, None, win32con.OPEN_ALWAYS, 0, None)
        old = _read(spec.root / 'session.json')
        already_running = session_running(spec, old) if old else False
        user = _user()
        original = user.GetThreadDesktop(win32api.GetCurrentThreadId())
        desktop = user.CreateDesktopW(spec.desktop, None, None, 0, 0x01FF, None)
        if not desktop or not user.SetThreadDesktop(original):
            raise DesktopControlError('bot desktop creation failed')
        if already_running:
            session = old
        else:
            # A login window need not hold account DBs yet. Inspect only this
            # named desktop before launch, so an untracked login is never duplicated.
            windows = []
            inspection_errors = []
            callback_type = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)
            user.EnumDesktopWindows.argtypes = [w.HANDLE, callback_type, w.LPARAM]
            user.EnumDesktopWindows.restype = w.BOOL
            user.GetWindowThreadProcessId.argtypes = [w.HWND, ctypes.POINTER(w.DWORD)]
            user.GetWindowThreadProcessId.restype = w.DWORD
            @callback_type
            def inspect(hwnd, _):
                try:
                    owner = w.DWORD()
                    user.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
                    current = _process(owner.value)
                    if current and os.path.normcase(os.path.realpath(current['exe'])) == os.path.normcase(str(spec.exe)):
                        windows.append(hwnd)
                    return True
                except Exception as error:
                    inspection_errors.append(type(error).__name__)
                    return False
            ctypes.set_last_error(0)
            enumerated = user.EnumDesktopWindows(desktop, inspect, 0)
            # A newly created empty desktop returns FALSE with last-error 0.
            # This was reproduced without WeChat; actual errors still stop launch.
            if inspection_errors or (not enumerated and ctypes.get_last_error() != 0):
                raise DesktopControlError('bot desktop windows could not be verified')
            if windows:
                raise DesktopControlError('untracked WeChat window already exists on the bot desktop')
            pid = _spawn_on_desktop(spec, str(spec.exe), [str(spec.exe)])
            process = psutil.Process(pid)
            session = {'desktop': spec.desktop, 'botWxid': spec.bot_id,
                       'pid': pid, 'startedAt': process.create_time()}
            _publish(spec.root / 'session.json', session)
        if not _WindowsBackend(spec, sys.executable)._toolbar_ready():
            _spawn_on_desktop(spec, sys.executable, [sys.executable, '-B', str(Path(__file__).resolve()),
                              '--sender-config', str(spec.config), 'toolbar'])
        while session_running(spec, session):
            time.sleep(1)
    except Exception as error:
        # Never terminate WeChat, alter account data, or adopt a reused PID.
        _publish(spec.root / 'error.json', {'at': time.time(), 'code': type(error).__name__ + ': ' + str(error)})
        raise
    finally:
        if desktop:
            _user().CloseDesktop(desktop)
        if lock:
            win32api.CloseHandle(lock)


def _toolbar(spec):
    import psutil
    import win32api
    import win32con
    import win32gui
    def handle(hwnd, message, wp, lp):
        if message == win32con.WM_COMMAND and (wp & 0xffff) == 1:
            _switch('Default')
            return 0
        if message == win32con.WM_CLOSE:
            _switch('Default')
            return 0
        if message == win32con.WM_DESTROY:
            if _input_desktop() == spec.desktop:
                _switch('Default')
            win32gui.PostQuitMessage(0)
            return 0
        return win32gui.DefWindowProc(hwnd, message, wp, lp)
    cls = win32gui.WNDCLASS()
    cls.hInstance = win32api.GetModuleHandle(None)
    cls.lpszClassName = 'DshWeChatReturn_' + str(os.getpid())
    cls.lpfnWndProc = handle
    cls.hbrBackground = win32con.COLOR_WINDOW + 1
    atom = win32gui.RegisterClass(cls)
    hwnd = win32gui.CreateWindowEx(win32con.WS_EX_TOPMOST, atom, f'{spec.bot_name} · 小号微信',
                                  win32con.WS_CAPTION | win32con.WS_VISIBLE, 20, 20, 430, 100, 0, 0, cls.hInstance, None)
    win32gui.CreateWindow('BUTTON', '返回主桌面（微信继续在后台运行）',
                         win32con.WS_CHILD | win32con.WS_VISIBLE | win32con.BS_PUSHBUTTON,
                         12, 10, 390, 42, hwnd, 1, cls.hInstance, None)
    current = psutil.Process()
    _publish(spec.root / 'toolbar.json', {'desktop': spec.desktop, 'pid': os.getpid(),
                                        'startedAt': current.create_time(), 'hwnd': hwnd})
    win32gui.PumpMessages()


def main():
    parser = argparse.ArgumentParser(description='Bot-only WeChat desktop control')
    parser.add_argument('--sender-config', required=True)
    parser.add_argument('action', choices=['status', 'show', 'hide', 'keeper', 'toolbar', 'start'])
    options = parser.parse_args()
    spec = load_spec(options.sender_config)
    if options.action == 'keeper':
        _keeper(spec)
    elif options.action == 'toolbar':
        _toolbar(spec)
    elif options.action == 'start':
        print(json.dumps({'ready': _WindowsBackend(spec, sys.executable).ensure_started()}))
    else:
        controller = DesktopController(options.sender_config)
        result = controller.state() if options.action == 'status' else controller.set_visible(options.action == 'show')
        print(json.dumps(result))


if __name__ == '__main__':
    main()

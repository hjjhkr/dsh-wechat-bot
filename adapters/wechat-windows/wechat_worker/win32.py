"""Thin ctypes bindings for the handful of Win32 calls the worker needs."""
from __future__ import annotations

import ctypes
from ctypes import wintypes as w

user32 = ctypes.WinDLL("user32", use_last_error=True)
kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
gdi32 = ctypes.WinDLL("gdi32", use_last_error=True)

DESKTOP_ALL_ACCESS = 0x01FF
GENERIC_ALL = 0x10000000
UOI_NAME = 2
PW_RENDERFULLCONTENT = 2
WM_MOUSEMOVE, WM_LBUTTONDOWN, WM_LBUTTONUP = 0x0200, 0x0201, 0x0202
MK_LBUTTON = 0x0001

WNDENUMPROC = ctypes.WINFUNCTYPE(w.BOOL, w.HWND, w.LPARAM)


def _sig(fn, restype, *argtypes):
    fn.restype, fn.argtypes = restype, list(argtypes)


_sig(user32.CreateDesktopW, w.HANDLE, w.LPCWSTR, w.LPCWSTR, ctypes.c_void_p, w.DWORD, w.DWORD, ctypes.c_void_p)
_sig(user32.OpenDesktopW, w.HANDLE, w.LPCWSTR, w.DWORD, w.BOOL, w.DWORD)
_sig(user32.OpenInputDesktop, w.HANDLE, w.DWORD, w.BOOL, w.DWORD)
_sig(user32.CloseDesktop, w.BOOL, w.HANDLE)
_sig(user32.SetThreadDesktop, w.BOOL, w.HANDLE)
_sig(user32.SwitchDesktop, w.BOOL, w.HANDLE)
_sig(user32.GetUserObjectInformationW, w.BOOL, w.HANDLE, ctypes.c_int, ctypes.c_void_p, w.DWORD, ctypes.POINTER(w.DWORD))
_sig(user32.EnumDesktopWindows, w.BOOL, w.HANDLE, WNDENUMPROC, w.LPARAM)
_sig(user32.GetWindowThreadProcessId, w.DWORD, w.HWND, ctypes.POINTER(w.DWORD))
_sig(user32.GetClassNameW, ctypes.c_int, w.HWND, w.LPWSTR, ctypes.c_int)
_sig(user32.GetWindowTextW, ctypes.c_int, w.HWND, w.LPWSTR, ctypes.c_int)
_sig(user32.IsWindowVisible, w.BOOL, w.HWND)
_sig(user32.IsIconic, w.BOOL, w.HWND)
_sig(user32.GetWindowRect, w.BOOL, w.HWND, ctypes.POINTER(w.RECT))
_sig(user32.PrintWindow, w.BOOL, w.HWND, w.HDC, w.UINT)
_sig(user32.PostMessageW, w.BOOL, w.HWND, w.UINT, w.WPARAM, w.LPARAM)
_sig(user32.ShowWindow, w.BOOL, w.HWND, ctypes.c_int)
_sig(user32.GetDC, w.HDC, w.HWND)
_sig(user32.ReleaseDC, ctypes.c_int, w.HWND, w.HDC)
_sig(user32.SetThreadDpiAwarenessContext, w.HANDLE, w.HANDLE)
_sig(gdi32.CreateCompatibleDC, w.HDC, w.HDC)
_sig(gdi32.CreateCompatibleBitmap, w.HBITMAP, w.HDC, ctypes.c_int, ctypes.c_int)
_sig(gdi32.SelectObject, w.HGDIOBJ, w.HDC, w.HGDIOBJ)
_sig(gdi32.DeleteObject, w.BOOL, w.HGDIOBJ)
_sig(gdi32.DeleteDC, w.BOOL, w.HDC)
_sig(gdi32.GetDIBits, ctypes.c_int, w.HDC, w.HBITMAP, w.UINT, w.UINT, ctypes.c_void_p, ctypes.c_void_p, w.UINT)
_sig(kernel32.CreateProcessW, w.BOOL, w.LPCWSTR, w.LPWSTR, ctypes.c_void_p, ctypes.c_void_p, w.BOOL, w.DWORD,
     ctypes.c_void_p, w.LPCWSTR, ctypes.c_void_p, ctypes.c_void_p)
_sig(kernel32.CloseHandle, w.BOOL, w.HANDLE)


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [("cb", w.DWORD), ("lpReserved", w.LPWSTR), ("lpDesktop", w.LPWSTR), ("lpTitle", w.LPWSTR),
                ("dwX", w.DWORD), ("dwY", w.DWORD), ("dwXSize", w.DWORD), ("dwYSize", w.DWORD),
                ("dwXCountChars", w.DWORD), ("dwYCountChars", w.DWORD), ("dwFillAttribute", w.DWORD),
                ("dwFlags", w.DWORD), ("wShowWindow", w.WORD), ("cbReserved2", w.WORD),
                ("lpReserved2", ctypes.c_void_p), ("hStdInput", w.HANDLE), ("hStdOutput", w.HANDLE),
                ("hStdError", w.HANDLE)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE), ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]


class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [("biSize", w.DWORD), ("biWidth", w.LONG), ("biHeight", w.LONG), ("biPlanes", w.WORD),
                ("biBitCount", w.WORD), ("biCompression", w.DWORD), ("biSizeImage", w.DWORD),
                ("biXPelsPerMeter", w.LONG), ("biYPelsPerMeter", w.LONG), ("biClrUsed", w.DWORD),
                ("biClrImportant", w.DWORD)]


def per_monitor_dpi_aware() -> None:
    """Make window geometry physical pixels for this thread (matches PrintWindow output)."""
    user32.SetThreadDpiAwarenessContext(w.HANDLE(-4))


def window_text(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    user32.GetWindowTextW(hwnd, buf, 256)
    return buf.value


def class_name(hwnd: int) -> str:
    buf = ctypes.create_unicode_buffer(256)
    user32.GetClassNameW(hwnd, buf, 256)
    return buf.value


def window_pid(hwnd: int) -> int:
    pid = w.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    return pid.value


def window_rect(hwnd: int) -> tuple[int, int, int, int]:
    rect = w.RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rect))
    return rect.left, rect.top, rect.right, rect.bottom

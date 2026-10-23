"""Short-lived, identity-bound byte gate with an independent recovery watchdog."""

from __future__ import annotations

import ctypes
import json
import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Callable

from .diagnostics import safe_reason_code, safe_send_attempted


class GateError(RuntimeError):
    pass


class GateExecutionError(GateError):
    def __init__(
        self,
        state: dict[str, Any],
        reason_code: str = "gate_preflight",
        send_attempted: bool | None = False,
    ):
        super().__init__("temporary gate execution or restoration failed")
        self.state = state
        self.reason_code = safe_reason_code(reason_code)
        self.send_attempted = safe_send_attempted(send_attempted)


def restore_original_byte(memory: Any, lease: dict[str, Any]) -> dict[str, Any]:
    """Restore only when identity and current byte still match the lease."""
    memory.verify_identity(lease)
    current = memory.read_byte(lease)
    original = lease["originalByte"]
    enabled = lease["enabledByte"]
    if current == original:
        return {"gateActive": False, "gateRestored": True}
    if current != enabled:
        raise GateError("gate byte changed to an unexpected value")
    memory.write_byte(lease, original)
    if memory.read_byte(lease) != original:
        raise GateError("gate restore readback failed")
    return {"gateActive": False, "gateRestored": True}


def watchdog_recover(
    memory: Any,
    lease: dict[str, Any],
    stop_requested: Callable[[], bool],
    now: Callable[[], float] = time.time,
    sleep: Callable[[float], None] = time.sleep,
) -> dict[str, Any]:
    """Wait through the enable window, then restore only the expected byte.

    The byte is initially original after the watchdog is armed. Seeing that
    value is not a reason to exit: the owner may still be between readiness
    acknowledgement and the enable write.
    """
    deadline = float(lease["deadlineEpoch"])
    while now() < deadline:
        if stop_requested():
            break
        memory.verify_identity(lease)
        current = memory.read_byte(lease)
        if current not in (lease["originalByte"], lease["enabledByte"]):
            raise GateError("gate byte changed to an unexpected value")
        sleep(0.05)
    return restore_original_byte(memory, lease)


def ensure_no_unresolved_leases(state_root: str | Path) -> None:
    """Block a fresh enable while any earlier lease lacks verified restoration."""
    lease_dir = Path(state_root) / "gate-leases"
    if not lease_dir.exists():
        return
    for lease_path in lease_dir.glob("*.json"):
        if lease_path.name.endswith((".ready.json", ".status.json")):
            continue
        status_path = lease_path.with_suffix(".status.json")
        try:
            status = json.loads(status_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            raise GateError("an earlier gate lease has no verified restoration")
        if not isinstance(status, dict) or status.get("gateActive") is not False or status.get("gateRestored") is not True:
            raise GateError("an earlier gate lease has no verified restoration")
        for path in (
            lease_path,
            lease_path.with_suffix(".ready.json"),
            status_path,
            lease_path.with_suffix(".stop"),
        ):
            try:
                path.unlink(missing_ok=True)
            except OSError as exc:
                raise GateError("a verified gate lease could not be cleaned") from exc


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + ".tmp-" + uuid.uuid4().hex)
    payload = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    fd = os.open(str(temp), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    except BaseException:
        try:
            temp.unlink(missing_ok=True)
        finally:
            raise


def _create_marker(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(value, separators=(",", ":")).encode("utf-8")
    fd = os.open(str(path), os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "wb") as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())


class ProcessWatchdog:
    """Independent, windowless child; no account keys are included in its command or lease."""

    def __init__(self, lease_path: Path):
        self.lease_path = lease_path
        self.ready_path = lease_path.with_suffix(".ready.json")
        self.status_path = lease_path.with_suffix(".status.json")
        self.stop_path = lease_path.with_suffix(".stop")
        self.process: subprocess.Popen[bytes] | None = None

    def start(self) -> None:
        watchdog_script = Path(__file__).with_name("watchdog.py")
        executable = Path(sys.executable)
        if os.name == "nt":
            executable = executable.with_name("pythonw.exe")
            if not executable.is_file():
                raise GateError("windowless Python executable is missing")
        safe_env = {
            key: os.environ[key]
            for key in ("SystemRoot", "WINDIR", "PATH", "TEMP", "TMP")
            if os.environ.get(key)
        }
        safe_env["PYTHONDONTWRITEBYTECODE"] = "1"
        # Windows ignores CREATE_NO_WINDOW when DETACHED_PROCESS is also set.
        # A new process group is independent without that conflicting flag.
        flags = 0x00000200 | 0x08000000
        try:
            self.process = subprocess.Popen(
                [str(executable), "-u", str(watchdog_script), str(self.lease_path)],
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
                creationflags=flags if os.name == "nt" else 0,
                env=safe_env,
            )
        except Exception as exc:
            raise GateError("recovery watchdog could not start") from exc

    def wait_ready(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.ready_path.is_file():
                try:
                    ready = json.loads(self.ready_path.read_text(encoding="utf-8"))
                    return ready.get("ready") is True
                except (OSError, json.JSONDecodeError):
                    return False
            if self.process is not None and self.process.poll() is not None:
                return False
            time.sleep(0.025)
        return False

    def request_stop(self) -> None:
        try:
            _create_marker(self.stop_path, {"stop": True})
        except FileExistsError:
            pass

    def wait_exit(self, timeout: float) -> bool:
        if self.process is None:
            return False
        try:
            self.process.wait(timeout=max(0.0, timeout))
            return True
        except subprocess.TimeoutExpired:
            return False

    def status(self) -> dict[str, Any] | None:
        try:
            value = json.loads(self.status_path.read_text(encoding="utf-8"))
            return value if isinstance(value, dict) else None
        except (OSError, json.JSONDecodeError):
            return None


class TemporaryByteGate:
    """Own one temporary enable window and keep its watchdog alive until verified."""

    def __init__(
        self,
        lease: dict[str, Any],
        state_root: str | Path,
        memory_factory: Callable[[dict[str, Any]], Any] | None = None,
        watchdog_factory: Callable[[Path], Any] = ProcessWatchdog,
    ):
        self.lease = dict(lease)
        self.state_root = Path(state_root)
        self.memory_factory = memory_factory or Win32ProcessMemory
        self.watchdog_factory = watchdog_factory
        self.lease_path: Path | None = None
        self.memory: Any = None
        self.watchdog: Any = None
        self._active = False
        self._last_state: dict[str, Any] = {"gateActive": False, "gateRestored": True}

    def run(self, action: Callable[[Callable[[], None]], Any]) -> tuple[Any, dict[str, Any]]:
        if self.watchdog is not None:
            raise GateError("a gate lease is already in flight")
        timeout = self.lease["timeoutSeconds"]
        self.lease["deadlineEpoch"] = time.time() + timeout
        lease_dir = self.state_root / "gate-leases"
        lease_dir.mkdir(parents=True, exist_ok=True)
        self.lease_path = lease_dir / (uuid.uuid4().hex + ".json")
        self.memory = self.memory_factory(self.lease)
        action_started = False
        action_value = None
        try:
            self.memory.verify_identity(self.lease)
            if self.memory.read_byte(self.lease) != self.lease["originalByte"]:
                raise GateError("gate byte does not match the expected original value")
            _create_marker(self.lease_path, self.lease)
            self.watchdog = self.watchdog_factory(self.lease_path)
            self.watchdog.start()
            if not self.watchdog.wait_ready(min(5.0, timeout / 3)):
                raise GateError("recovery watchdog did not verify the binding")
            self.memory.verify_identity(self.lease)
            if self.memory.read_byte(self.lease) != self.lease["originalByte"]:
                raise GateError("gate byte changed before enable")
            self.memory.write_byte(self.lease, self.lease["enabledByte"])
            if self.memory.read_byte(self.lease) != self.lease["enabledByte"]:
                raise GateError("gate enable readback failed")
            self._active = True
            self._last_state = {"gateActive": True, "gateRestored": False}
            action_started = True
            action_value = action(self.assert_active)
        except BaseException as exc:
            reason_code = safe_reason_code(getattr(exc, "reason_code", None))
            send_attempted = safe_send_attempted(getattr(exc, "send_attempted", False))
            try:
                self.close()
            except Exception:
                self._last_state = {"gateActive": None, "gateRestored": False}
            if self._last_state.get("gateActive") is not False or self._last_state.get("gateRestored") is not True:
                reason_code = "gate_restore"
            elif not action_started:
                reason_code = "gate_preflight"
                send_attempted = False
            raise GateExecutionError(dict(self._last_state), reason_code, send_attempted) from exc
        try:
            self._last_state = self._restore_and_join()
        except Exception as exc:
            self._last_state = {"gateActive": None, "gateRestored": False}
            send_attempted = safe_send_attempted(
                action_value.get("sendAttempted") if isinstance(action_value, dict) else None
            )
            raise GateExecutionError(dict(self._last_state), "gate_restore", send_attempted) from exc
        if self._last_state != {"gateActive": False, "gateRestored": True}:
            send_attempted = safe_send_attempted(
                action_value.get("sendAttempted") if isinstance(action_value, dict) else None
            )
            raise GateExecutionError(dict(self._last_state), "gate_restore", send_attempted)
        return action_value, dict(self._last_state)

    def assert_active(self) -> None:
        if not self._active or self.memory is None:
            raise GateError("gate is no longer active")
        self.memory.verify_identity(self.lease)
        if self.memory.read_byte(self.lease) != self.lease["enabledByte"]:
            raise GateError("gate expired before the send action")

    def _restore_and_join(self) -> dict[str, Any]:
        if self.memory is None or self.watchdog is None:
            return {"gateActive": False, "gateRestored": True}
        restored = restore_original_byte(self.memory, self.lease)
        self._active = False
        if getattr(self.watchdog, "process", object()) is None:
            # Popen never returned a child process, so there is no independent
            # watchdog to join. The parent still verified the exact original byte.
            self._forget_lease_files()
            self._close_memory()
            self.watchdog = None
            return restored
        self.watchdog.request_stop()
        if not self.watchdog.wait_exit(3.0):
            remaining = max(0.0, self.lease["deadlineEpoch"] - time.time())
            if not self.watchdog.wait_exit(remaining + 1.0):
                raise GateError("recovery watchdog did not exit")
        status = self.watchdog.status()
        if status is None or status.get("gateActive") is not False or status.get("gateRestored") is not True:
            raise GateError("recovery watchdog did not confirm restoration")
        self._last_state = restored
        self._forget_lease_files()
        self._close_memory()
        return restored

    def close(self) -> dict[str, Any]:
        if self.watchdog is None:
            self._close_memory()
            return {"gateActive": False, "gateRestored": True}
        state = self._restore_and_join()
        if state["gateActive"] is not False or state["gateRestored"] is not True:
            raise GateError("gate closure is unconfirmed")
        return state

    def _forget_lease_files(self) -> None:
        if self.lease_path is None:
            return
        for path in (
            self.lease_path,
            self.lease_path.with_suffix(".ready.json"),
            self.lease_path.with_suffix(".status.json"),
            self.lease_path.with_suffix(".stop"),
        ):
            try:
                path.unlink(missing_ok=True)
            except OSError:
                pass

    def _close_memory(self) -> None:
        if self.memory is not None:
            close = getattr(self.memory, "close", None)
            if callable(close):
                close()
            self.memory = None


class Win32ProcessMemory:
    """One-byte Win32 reader/writer; every access revalidates PID/module identity."""

    PROCESS_VM_OPERATION = 0x0008
    PROCESS_VM_READ = 0x0010
    PROCESS_VM_WRITE = 0x0020
    PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

    def __init__(self, lease: dict[str, Any]):
        if os.name != "nt":
            raise GateError("temporary memory gate is Windows-only")
        self.lease = lease
        self._kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self._kernel.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
        self._kernel.OpenProcess.restype = ctypes.c_void_p
        self._kernel.ReadProcessMemory.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_size_t),
        ]
        self._kernel.ReadProcessMemory.restype = ctypes.c_int
        self._kernel.WriteProcessMemory.argtypes = [
            ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_size_t,
            ctypes.POINTER(ctypes.c_size_t),
        ]
        self._kernel.WriteProcessMemory.restype = ctypes.c_int
        self._kernel.CloseHandle.argtypes = [ctypes.c_void_p]
        self._kernel.CloseHandle.restype = ctypes.c_int
        self.verify_identity(lease)
        self._handle = self._kernel.OpenProcess(
            self.PROCESS_VM_OPERATION | self.PROCESS_VM_READ | self.PROCESS_VM_WRITE
            | self.PROCESS_QUERY_LIMITED_INFORMATION,
            0,
            lease["pid"],
        )
        if not self._handle:
            raise GateError("bound process memory could not be opened")

    def verify_identity(self, lease: dict[str, Any]) -> None:
        from .process import verify_lease_identity

        verify_lease_identity(lease)

    def read_byte(self, lease: dict[str, Any]) -> int:
        address = self._address(lease)
        value = ctypes.c_ubyte()
        count = ctypes.c_size_t()
        ok = self._kernel.ReadProcessMemory(
            self._handle,
            ctypes.c_void_p(address),
            ctypes.byref(value),
            1,
            ctypes.byref(count),
        )
        if not ok or count.value != 1:
            raise GateError("gate byte read failed")
        return value.value

    def write_byte(self, lease: dict[str, Any], value: int) -> None:
        address = self._address(lease)
        payload = ctypes.c_ubyte(value)
        count = ctypes.c_size_t()
        ok = self._kernel.WriteProcessMemory(
            self._handle,
            ctypes.c_void_p(address),
            ctypes.byref(payload),
            1,
            ctypes.byref(count),
        )
        if not ok or count.value != 1:
            raise GateError("single-byte gate write failed")

    def close(self) -> None:
        handle = getattr(self, "_handle", None)
        if handle:
            self._kernel.CloseHandle(handle)
            self._handle = None

    def _address(self, lease: dict[str, Any]) -> int:
        self.verify_identity(lease)
        from .vendor import load_db_module

        module = load_db_module()._find_weixin_module(lease["pid"])
        if not module:
            raise GateError("bound Weixin.dll could not be rediscovered")
        base, size, path = module
        from .process import _norm_path

        if (
            _norm_path(path) != _norm_path(lease["modulePath"])
            or int(size) != int(lease["moduleSize"])
            or not 0 <= lease["rva"] < int(size)
        ):
            raise GateError("gate module identity changed")
        return int(base) + int(lease["rva"])


def watchdog_main(lease_path: str) -> int:
    """Recovery entry used only by a separate, hidden Python process."""
    path = Path(lease_path)
    ready_path = path.with_suffix(".ready.json")
    status_path = path.with_suffix(".status.json")
    stop_path = path.with_suffix(".stop")
    memory = None
    lease: dict[str, Any] = {}
    try:
        lease = json.loads(path.read_text(encoding="utf-8"))
        memory = Win32ProcessMemory(lease)
        if memory.read_byte(lease) != lease["originalByte"]:
            raise GateError("gate was not original when watchdog armed")
        _atomic_json(ready_path, {"ready": True})
        restored = watchdog_recover(memory, lease, stop_path.exists)
        _atomic_json(status_path, restored)
        return 0
    except Exception:
        try:
            _atomic_json(status_path, {"gateActive": None, "gateRestored": False})
        except Exception:
            pass
        return 2
    finally:
        if memory is not None:
            memory.close()


def _lease_from_config(config: dict[str, Any], session: dict[str, Any]) -> dict[str, Any]:
    binding = session.get("binding")
    if not isinstance(binding, dict):
        raise GateError("process binding is missing")
    from .process import _norm_path

    if _norm_path(config["gateModule"]) != _norm_path(binding.get("modulePath", "")):
        raise GateError("configured gate module does not match the bound Weixin.dll")
    if (
        config["mainWindowClass"] != binding.get("mainWindowClass")
        or config["mainWindowTitle"] != binding.get("mainWindowTitle")
    ):
        raise GateError("configured main window does not match the bound native window")
    rva = config["gateRva"]
    try:
        rva = int(rva, 0) if isinstance(rva, str) else int(rva)
    except (TypeError, ValueError) as exc:
        raise GateError("gate RVA is invalid") from exc
    if rva < 0 or rva >= binding["moduleSize"]:
        raise GateError("gate RVA is outside the bound module")
    return {
        "pid": binding["pid"],
        "startedAt": binding["processStartedAt"],
        "exePath": binding["exePath"],
        "version": binding["version"],
        "hwnd": binding["hwnd"],
        "mainWindowClass": binding["mainWindowClass"],
        "mainWindowTitle": binding["mainWindowTitle"],
        "modulePath": binding["modulePath"],
        "moduleBase": binding["moduleBase"],
        "moduleSize": binding["moduleSize"],
        "rva": rva,
        "originalByte": config["gateExpectedOriginalByte"],
        "enabledByte": config["gateEnabledByte"],
        "timeoutSeconds": config["gateTimeoutSeconds"],
    }


def make_gate(config: dict[str, Any], session: dict[str, Any]) -> TemporaryByteGate:
    ensure_no_unresolved_leases(config["stateRoot"])
    lease = _lease_from_config(config, session)
    return TemporaryByteGate(lease, config["stateRoot"])

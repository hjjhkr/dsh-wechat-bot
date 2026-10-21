"""Default-desktop controller and isolated-desktop runtime, with no send fallback."""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
import threading
import time
import uuid

from .desktop import (DesktopChild, desktop_names, desktop_available, input_desktop_name,
                      require_window_desktop, thread_desktop_name, validate_desktop)
from .runtime import WindowsRuntime
from .uia_send import _FocusMonitor, UiaSendError


def validate_monitor_lease(value, *, nonce, binding, desktop, now):
    stamp = value.get("at")
    if (
        value.get("nonce") != nonce or value.get("botPid") != binding["pid"]
        or value.get("botStartedAt") != binding["processStartedAt"]
        or value.get("desktop") != desktop or value.get("safe") is not True
        or type(stamp) not in (int, float) or not 0 <= now - stamp <= 2
    ):
        raise UiaSendError("default desktop monitor lease invalid", "foreground_guard", False)


def focus_checked_result(result, safe):
    if safe:
        return result
    return {**result, "status": "ambiguous", "reasonCode": "foreground_guard"}


def blocked_send_result():
    return {"status": "blocked", "reasonCode": "desktop_unavailable", "sendAttempted": False,
            "gateActive": False, "gateRestored": True}


class MonitorLease:
    """Short-lived permission refreshed only by a live Default-desktop monitor."""

    def __init__(self, config, binding):
        self.desktop = validate_desktop(config["desktopName"])
        self.binding = binding
        self.nonce = uuid.uuid4().hex
        root = Path(config["stateRoot"]) / "desktop-leases"
        root.mkdir(parents=True, exist_ok=True)
        self.path = root / (self.nonce + ".json")
        self.monitor = _FocusMonitor(binding["pid"])
        self.stop = threading.Event()
        self.thread = None
        self.failed = False

    def _publish(self, safe):
        value = {"nonce": self.nonce, "botPid": self.binding["pid"],
                 "botStartedAt": self.binding["processStartedAt"], "desktop": self.desktop,
                 "at": time.time(), "safe": safe}
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps(value), encoding="utf-8")
        os.replace(temp, self.path)

    def safe(self):
        try:
            if self.failed or not desktop_available():
                return False
            require_window_desktop(self.binding, self.desktop)
            return self.monitor.safe(self.before, allow_transient_zero=True)
        except Exception:
            self.failed = True
            return False

    def diagnostic(self):
        # Counts and fixed error identifiers only; never window titles or chat text.
        try:
            default_desktop = desktop_names() == ("Default", "Default")
        except Exception:
            default_desktop = False
        foregrounds, owners = self.monitor.sample_snapshot()
        return {"safe": self.safe(), "monitorFailed": self.failed,
                "defaultDesktop": default_desktop, "samples": len(foregrounds),
                "zeroForegrounds": foregrounds.count(0),
                "unknownOwners": owners.count(0),
                "botForegrounds": owners.count(self.binding["pid"]),
                "botFocusEvents": len(self.monitor.events),
                "failureReasons": getattr(self.monitor, "last_failure", []) +
                    (["input_desktop_changed"] if not default_desktop else []),
                "errors": sorted(set(e for e in self.monitor.errors if re.fullmatch(r"[A-Za-z_]{1,64}", e)))[:8]}

    def _run(self):
        while not self.stop.wait(0.1):
            try:
                safe = self.safe()
                if not safe:
                    self.failed = True
                self._publish(safe)
            except Exception:
                self.failed = True
                return  # The last successful lease expires within two seconds.

    def start(self):
        if desktop_names() != ("Default", "Default"):
            raise UiaSendError("default input desktop required", "foreground_guard", False)
        self.monitor.start()
        self.before = self.monitor.foreground()
        time.sleep(0.05)
        if not self.safe():
            raise UiaSendError("default focus monitor unavailable", "monitor_start", False)
        self._publish(True)
        self.thread = threading.Thread(target=self._run, daemon=True, name="wechat-monitor-lease")
        self.thread.start()
        return {"path": str(self.path), "nonce": self.nonce}

    def close(self):
        self.stop.set()
        if self.thread:
            self.thread.join(2)
            if self.thread.is_alive():
                self.failed = True
                raise RuntimeError("monitor lease thread close unconfirmed")
        try:
            self._publish(False)
        finally:
            self.monitor.close()

    def remove(self):
        # Only after the child has returned: a removed lease can never authorize it.
        self.path.unlink(missing_ok=True)
        self.path.with_suffix(".tmp").unlink(missing_ok=True)


class IsolatedRuntime:
    """Facade used by the existing Worker, preserving its attempt/dedup contract."""

    def __init__(self, child_factory=DesktopChild, lease_factory=MonitorLease,
                 availability=desktop_available):
        self.child_factory, self.lease_factory = child_factory, lease_factory
        self.availability = availability
        self.child = None
        self.config = None
        self.session = None
        self.leases = []
        self.close_result = None

    def probe(self, config):
        if self.child is not None:
            raise RuntimeError("isolated worker already bound")
        self.child = self.child_factory(config["desktopName"])
        result = self.child.request("probe", {"config": config})
        if result.get("desktopName") != config["desktopName"]:
            raise RuntimeError("isolated worker desktop mismatch")
        self.config, self.session = dict(config), result
        return result

    def verify(self, config, session):
        if self.config != config or self.session != session or self.child is None or not self.child.alive():
            raise RuntimeError("isolated worker session changed")
        # The inner Worker revalidates the real account/process for every RPC.

    def baseline(self, config, session):
        self.verify(config, session)
        return self.child.request("baseline", {"config": config})

    def poll(self, config, session, cursor, overlap_seq, max_items):
        self.verify(config, session)
        result = self.child.request("poll", {"config": config, "cursor": cursor,
                                            "overlapSeq": overlap_seq, "maxItems": max_items})
        return {**result, "desktopAvailable": self.availability() is True}

    def conversations(self, config, session):
        self.verify(config, session)
        return self.child.request("conversations", {"config": config})

    def select(self, config, session, params):
        self.verify(config, session)
        if self.availability() is not True:
            return {"selected": False, "reasonCode": "desktop_unavailable",
                    "gateActive": False, "gateRestored": True}
        lease = self.lease_factory(config, session["binding"])
        self.leases.append(lease)
        try:
            monitor = lease.start()
            result = self.child.request("select", {**params, "config": config, "monitor": monitor}, timeout=40)
        finally:
            lease.close()
        result = {**result, "focusDiagnostic": lease.diagnostic()}
        if not lease.safe():
            result["selected"] = False
            result["reasonCode"] = "foreground_guard"
        if result.get("gateRestored") is True:
            lease.remove()
            self.leases.remove(lease)
        return result

    def send(self, config, session, params):
        self.verify(config, session)
        if self.availability() is not True:
            return blocked_send_result()
        lease = self.lease_factory(config, session["binding"])
        self.leases.append(lease)
        requested = False
        try:
            monitor = lease.start()
            requested = True
            result = self.child.request("send", {**params, "config": config, "monitor": monitor}, timeout=45)
        except Exception as exc:
            if not requested and self.availability() is not True:
                result = blocked_send_result()
            else:
                result = {"status": "ambiguous",
                          "reasonCode": "send_unknown" if requested else getattr(exc, "reason_code", "monitor_start"),
                          "sendAttempted": None if requested else False,
                          "gateActive": None if requested else False, "gateRestored": not requested}
        finally:
            lease.close()
        # No child send request means no draft, gate or click can have occurred.
        # Once requested, even a reply claiming blocked cannot authorize a retry.
        if requested:
            result = focus_checked_result(result, lease.safe())
            if result.get("status") == "blocked":
                result = {**result, "status": "ambiguous", "reasonCode": "send_unknown"}
        result["focusDiagnostic"] = lease.diagnostic()
        # Keep the revoked file until close if the child outcome is unknown.
        if result.get("gateRestored") is True:
            lease.remove()
            self.leases.remove(lease)
        return result

    def close(self):
        if self.close_result is not None:
            return self.close_result
        for lease in self.leases:
            lease.close()
        result = self.child.close() if self.child else {"closed": True, "gateActive": False, "gateRestored": True}
        for lease in self.leases:
            lease.remove()
        self.leases.clear()
        self.child = None
        self.close_result = result
        return result


class IsolatedWindowsRuntime(WindowsRuntime):
    """The inner runtime may read and click only on its configured hidden desktop."""

    def __init__(self, desktop):
        from .isolated_send import IsolatedUISender
        self.desktop = validate_desktop(desktop)
        self.monitor = None
        super().__init__(sender_factory=lambda config, binding: IsolatedUISender(config, binding, self.require_monitor))

    def require_desktop(self):
        if thread_desktop_name() != self.desktop:
            raise UiaSendError("isolated desktop precondition failed", "foreground_guard", False)
        if self._binding is not None:
            require_window_desktop(self._binding, self.desktop)

    def probe(self, config):
        if config.get("desktopName") != self.desktop:
            raise RuntimeError("desktop config changed")
        self.require_desktop()
        result = super().probe(config)
        self.require_desktop()
        return {**result, "desktopName": self.desktop}

    def verify(self, config, session):
        self.require_desktop()
        super().verify(config, session)

    def require_monitor(self):
        self.require_desktop()
        if input_desktop_name() != "Default":
            raise UiaSendError("input desktop unavailable", "desktop_unavailable", False)
        if not isinstance(self.monitor, dict):
            raise UiaSendError("monitor required", "monitor_start", False)
        nonce = self.monitor.get("nonce")
        if not isinstance(nonce, str) or len(nonce) != 32 or any(c not in "0123456789abcdef" for c in nonce):
            raise UiaSendError("invalid monitor nonce", "monitor_start", False)
        expected = (Path(self._config["stateRoot"]) / "desktop-leases" / (nonce + ".json")).resolve()
        if Path(self.monitor["path"]).resolve() != expected:
            raise UiaSendError("invalid monitor path", "monitor_start", False)
        value = json.loads(expected.read_text(encoding="utf-8"))
        validate_monitor_lease(value, nonce=nonce, binding=self._binding, desktop=self.desktop, now=time.time())
        return True

    def send(self, config, session, params):
        self.monitor = params.get("monitor")
        try:
            self.require_monitor()
            return super().send(config, session, params)
        finally:
            self.monitor = None

    def select(self, config, session, params):
        self.monitor = params.get("monitor")
        self.verify(config, session)
        self.require_monitor()
        from .conversations import select_session
        from .gate import make_gate
        try:
            self._gate = make_gate(config, session)
            return select_session(config, self._binding, self._db, self._gate, self.require_monitor)
        finally:
            if self._gate is not None:
                state = self._gate.close()
                if state.get("gateActive") is False and state.get("gateRestored") is True:
                    self._gate = None
            self.monitor = None

"""Synchronous delivery with durable clientId deduplication.

The pending record is fsynced before a sender can touch WeChat. A crash between
that record and a durable outcome leaves an uncertain attempt, never a retry.
Only one adapter process may own a journal at a time.
"""
from __future__ import annotations

import hashlib
import json
import os
import threading
from pathlib import Path

from .rpc import ProtocolError


class Delivery:
    def __init__(self, path: str | Path, sender, *, scope: str):
        self.path, self.sender, self.scope = Path(path), sender, scope
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._entries = {}
        self._needs_newline = False
        self._fault = False
        self._quarantined = False
        self._closed = False
        self._lease = self.path.with_suffix(self.path.suffix + ".lock").open("a+b")
        try:
            self._acquire()
            self._load()
        except BaseException:
            self._lease.close()
            raise

    def _acquire(self):
        if os.name == "nt":
            import msvcrt
            self._lease.seek(0, os.SEEK_END)
            if self._lease.tell() == 0:
                self._lease.write(b"\0")
                self._lease.flush()
            self._lease.seek(0)
            msvcrt.locking(self._lease.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(self._lease, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def _load(self):
        if not self.path.exists():
            return
        try:
            data = self.path.read_text(encoding="utf-8")
            self._needs_newline = bool(data and not data.endswith("\n"))
            for line in data.splitlines():
                entry = json.loads(line)
                if (not isinstance(entry, dict) or not isinstance(entry.get("clientId"), str)
                        or not isinstance(entry.get("requestHash"), str)
                        or entry.get("state") not in ("pending", "confirmed", "send_uncertain", "retryable")
                        or (entry["state"] == "confirmed" and not isinstance(entry.get("messageId"), str))):
                    raise ValueError("invalid entry")
                self._entries[entry["clientId"]] = entry
                self._quarantined = self._quarantined or entry.get("recoveryRequired") is True
            # A killed adapter cannot confirm that its old worker stopped or
            # restored the gate. Terminal uncertain outcomes with safe cleanup
            # only suppress that clientId; an unfinished attempt blocks all new
            # sends until recovery is verified.
            self._quarantined = self._quarantined or any(
                entry["state"] == "pending" for entry in self._entries.values())
        except (ValueError, UnicodeError) as error:
            raise ValueError(f"delivery journal is corrupt: {self.path}; preserve it for reconciliation") from error

    def _append(self, entry):
        try:
            with self.path.open("a", encoding="utf-8", newline="\n") as stream:
                if self._needs_newline:
                    stream.write("\n")
                stream.write(json.dumps(entry, ensure_ascii=False) + "\n")
                stream.flush()
                os.fsync(stream.fileno())
        except OSError:
            self._fault = True
            raise
        self._entries[entry["clientId"]] = entry
        self._quarantined = self._quarantined or entry.get("recoveryRequired") is True
        self._needs_newline = False

    def available(self) -> bool:
        return not (self._closed or self._fault or self._quarantined) and self.sender.available()

    def _outcome(self, entry, state, **fields):
        return {**entry, "state": state, **fields,
                "recoveryRequired": getattr(self.sender, "recovery_required", False) is True}

    def send(self, chat_id: str, content: dict, client_id: str) -> str:
        request_hash = hashlib.sha256(json.dumps(
            [self.scope, chat_id, content], ensure_ascii=False, sort_keys=True,
            separators=(",", ":")).encode("utf-8")).hexdigest()
        with self._lock:
            if self._closed or self._fault:
                raise ProtocolError("unavailable", "delivery journal is closed or has a write failure")
            previous = self._entries.get(client_id)
            if previous:
                if previous["requestHash"] != request_hash:
                    raise ProtocolError("invalid_params", "clientId already belongs to a different account, chat or content")
                if previous["state"] == "confirmed":
                    return previous["messageId"]
                if previous["state"] in ("pending", "send_uncertain"):
                    raise ProtocolError("send_uncertain", "send_uncertain: previous attempt has no certain outcome; never resend")
            if not self.available():
                reason = "worker recovery must be verified; preserve the journal" if self._quarantined else "sender desktop is unavailable"
                raise ProtocolError("unavailable", f"{reason}; nothing was sent")
            entry = {"clientId": client_id, "requestHash": request_hash, "state": "pending"}
            self._append(entry)
            try:
                message_id = self.sender.send(chat_id, content, client_id)
                if not isinstance(message_id, str) or not message_id:
                    raise ProtocolError("send_uncertain", "sender returned no message id")
            except Exception as error:
                code = error.code if isinstance(error, ProtocolError) else "send_uncertain"
                retryable = code in ("send_failed", "unavailable", "unsupported", "invalid_params", "not_found")
                self._append(self._outcome(entry, "retryable" if retryable else "send_uncertain"))
                if retryable:
                    raise
                raise ProtocolError("send_uncertain", "send_uncertain: sender did not prove delivery or non-delivery") from error
            self._append(self._outcome(entry, "confirmed", messageId=message_id))
            return message_id

    def close(self):
        with self._lock:
            if self._closed:
                return
            # Keep the lease if cleanup fails: the old worker may still own a
            # window/gate, so another adapter must not take over blindly.
            self.sender.close()
            self._closed = True
            self._lease.close()

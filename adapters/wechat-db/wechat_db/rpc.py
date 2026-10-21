"""JSON-RPC 2.0 over JSON Lines on stdin/stdout (the adapter side of docs/protocol.md)."""
from __future__ import annotations

import json
import sys
import threading
import traceback


class ProtocolError(Exception):
    def __init__(self, code: str, message: str | None = None):
        super().__init__(message or code)
        self.code = code


class Server:
    def __init__(self, stdin=None, stdout=None, log=None):
        self.stdin = stdin or sys.stdin.buffer
        self.stdout = stdout or sys.stdout.buffer
        self.log = log or (lambda text: print(text, file=sys.stderr, flush=True))
        self.handlers = {}
        self._write_lock = threading.Lock()
        self.closing = threading.Event()

    def method(self, name):
        def register(handler):
            self.handlers[name] = handler
            return handler
        return register

    def _write(self, frame: dict):
        data = (json.dumps(frame, ensure_ascii=False) + "\n").encode("utf-8")
        with self._write_lock:
            self.stdout.write(data)
            self.stdout.flush()

    def notify(self, method: str, params: dict):
        if not self.closing.is_set():
            self._write({"jsonrpc": "2.0", "method": method, "params": params})

    def serve(self):
        for raw in self.stdin:
            if self.closing.is_set():
                break
            line = raw.decode("utf-8").strip()
            if not line:
                continue
            try:
                frame = json.loads(line)
            except json.JSONDecodeError:
                self.log(f"ignored non-JSON line: {line[:200]}")
                continue
            self._dispatch(frame)
            if self.closing.is_set():
                break
        self.closing.set()

    def _dispatch(self, frame: dict):
        request_id = frame.get("id")
        handler = self.handlers.get(frame.get("method"))
        try:
            if handler is None:
                raise ProtocolError("method_not_found", f"unknown method {frame.get('method')}")
            result = handler(frame.get("params") or {})
            if request_id is not None:
                self._write({"jsonrpc": "2.0", "id": request_id, "result": result if result is not None else {}})
        except Exception as error:  # every failure becomes a protocol error, never a crash
            code = error.code if isinstance(error, ProtocolError) else "internal_error"
            if not isinstance(error, ProtocolError):
                self.log(traceback.format_exc())
            if request_id is not None:
                self._write({"jsonrpc": "2.0", "id": request_id, "error": {
                    "code": -32601 if code == "method_not_found" else -32000,
                    "message": str(error), "data": {"code": code}}})

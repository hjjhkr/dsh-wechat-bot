"""Outgoing messages as JSON lines. How they reach WeChat is someone else's job:
a consumer tails this file and types/pastes each entry into the right chat."""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path


class Outbox:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()
        self._written: dict[str, str] = {}
        if self.path.exists():
            data = self.path.read_bytes()
            for line in data.decode("utf-8", "replace").splitlines():
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue  # e.g. a line torn by a crash mid-write
                if isinstance(entry, dict) and isinstance(entry.get("clientId"), str) and isinstance(entry.get("id"), str):
                    self._written[entry["clientId"]] = entry["id"]
            if data and not data.endswith(b"\n"):
                # Start the next entry on its own line instead of gluing it onto a torn one.
                with self.path.open("ab") as stream:
                    stream.write(b"\n")

    def put(self, chat: dict, client_id: str, content: dict) -> str:
        """Appends one message; the same clientId is written only once. Returns its id."""
        with self._lock:
            if client_id in self._written:
                return self._written[client_id]
            entry = {
                "id": f"out:{client_id}",
                "clientId": client_id,
                "chatId": chat["id"],
                "chatName": chat.get("name", chat["id"]),
                "content": content,
                "createdAt": int(time.time() * 1000),
            }
            with self.path.open("a", encoding="utf-8") as stream:
                stream.write(json.dumps(entry, ensure_ascii=False) + "\n")
                stream.flush()
            self._written[client_id] = entry["id"]
            return entry["id"]

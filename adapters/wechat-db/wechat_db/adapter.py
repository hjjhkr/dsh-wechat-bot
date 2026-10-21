"""Protocol v1 adapter backed by WeChat's local databases.

Receiving: polls the watched chat's message tables and emits event/message.
Sending:   writes the content JSON to an outbox file (see outbox.py); delivering
           it into WeChat is out of scope for this adapter.
"""
from __future__ import annotations

import threading
import time
from pathlib import Path

from .outbox import Outbox
from .reader import Reader
from .rpc import ProtocolError, Server

PROTOCOL_VERSION = 1
RETRY_OPEN_S = 5.0


class Adapter:
    def __init__(self, server: Server, open_source, self_id: str, *, poll_ms: int = 1000,
                 outbox_path: str | None = None, chat_names: dict | None = None):
        self.server = server
        self.open_source = open_source  # (data_dir) -> source; may raise until WeChat is logged in
        self.self_id = self_id
        self.poll_s = poll_ms / 1000
        self.outbox_path = outbox_path
        self.chat_names = chat_names or {}
        self.data_dir = Path(".")
        self.reader: Reader | None = None
        self.outbox: Outbox | None = None
        self.open_error = None
        self.cursors: dict[str, int] = {}
        self.lock = threading.RLock()
        self.poller = None
        self.opener = None
        self.healthy = True
        for name in ("initialize", "account/status", "account/login", "chats/list", "chats/members",
                     "chats/history", "watch/set", "message/send", "shutdown"):
            server.method(name)(getattr(self, "on_" + name.replace("/", "_")))

    # ── lifecycle ───────────────────────────────────────────────────────

    def on_initialize(self, params):
        if params.get("protocolVersion") != PROTOCOL_VERSION:
            raise ProtocolError("invalid_params", f"protocol {params.get('protocolVersion')} not supported")
        self.data_dir = Path(params.get("dataDir") or ".")
        self.outbox = Outbox(self.outbox_path or self.data_dir / "wechat-outbox.jsonl")
        self._try_open()
        return {
            "protocolVersion": PROTOCOL_VERSION,
            "adapter": {"name": "wechat-db", "version": "0.1.0"},
            "capabilities": {"receive": ["text", "image", "sticker", "voice", "video", "link", "system", "other"],
                             "send": ["text", "image", "sticker"], "history": True},
        }

    def on_shutdown(self, _params):
        self.server.closing.set()
        return {}

    def _try_open(self) -> bool:
        if self.reader:
            return True
        try:
            reader = Reader(self.open_source(self.data_dir), self.self_id)
            reader.names()  # proves the databases can actually be read
        except Exception as error:
            self.open_error = str(error)
            return False
        with self.lock:
            self.reader = reader
            self.open_error = None
        return True

    def _account(self) -> dict:
        if self.reader:
            return {"state": "ready", "self": self.reader.self_info()}
        return {"state": "login_required",
                "instructions": f"读不到微信数据库：{self.open_error}。请在这台电脑上登录微信小号并保持运行，登录后会自动连接。"}

    def on_account_status(self, _params):
        self._try_open()
        return self._account()

    def on_account_login(self, _params):
        if not self._try_open() and not (self.opener and self.opener.is_alive()):
            self.opener = threading.Thread(target=self._keep_opening, daemon=True)
            self.opener.start()
        return self._account()

    def _keep_opening(self):
        while not self.server.closing.is_set():
            if self._try_open():
                self.server.notify("event/account", self._account())
                self.server.notify("event/status", {"connection": "connected", "canSend": True})
                return
            time.sleep(RETRY_OPEN_S)

    def _require(self) -> Reader:
        if not self.reader:
            raise ProtocolError("not_ready", self.open_error or "not ready")
        return self.reader

    # ── chats ───────────────────────────────────────────────────────────

    def _chat(self, chat_id: str) -> dict:
        if chat_id in self.cursors:
            with self.lock:
                name = self._require().names().get(chat_id, chat_id)
            return {"id": chat_id, "name": self.chat_names.get(chat_id, name)}
        for chat in self.on_chats_list({})["chats"]:
            if chat["id"] == chat_id:
                return chat
        raise ProtocolError("not_found", f"unknown chat {chat_id}")

    def on_chats_list(self, params):
        with self.lock:
            chats = self._require().chats()
        for chat in chats:
            chat["name"] = self.chat_names.get(chat["id"], chat["name"])
        query = params.get("query")
        return {"chats": [c for c in chats if not query or query in c["name"]]}

    def on_chats_members(self, params):
        with self.lock:
            return {"members": self._require().members(params["chatId"])}

    def on_chats_history(self, params):
        with self.lock:
            return {"messages": self._require().history(params["chatId"], int(params.get("limit", 20)))}

    # ── receiving ───────────────────────────────────────────────────────

    def on_watch_set(self, params):
        chat_ids = params.get("chatIds") or []
        with self.lock:
            reader = self._require()
            # Baseline: only messages that arrive from now on are new.
            self.cursors = {chat_id: self.cursors.get(chat_id) or reader.latest_seq(chat_id) for chat_id in chat_ids}
        if self.cursors and not (self.poller and self.poller.is_alive()):
            self.poller = threading.Thread(target=self._poll, daemon=True)
            self.poller.start()
        return {"watching": list(self.cursors)}

    def _poll(self):
        while not self.server.closing.is_set() and self.cursors:
            try:
                with self.lock:
                    batches = [(chat_id, self.reader.after(chat_id, seq)) for chat_id, seq in list(self.cursors.items())]
                for chat_id, found in batches:
                    for seq, message in found:
                        self.server.notify("event/message", {"message": message})
                        self.cursors[chat_id] = seq
                if not self.healthy:
                    self.healthy = True
                    self.server.notify("event/status", {"connection": "connected", "canSend": True})
            except Exception as error:  # a bad read is retried next poll, never fatal
                if self.healthy:
                    self.healthy = False
                    self.server.notify("event/status", {"connection": "degraded", "canSend": True, "reason": "db_read_failed", "detail": str(error)[:200]})
                    self.server.notify("event/log", {"level": "warn", "message": f"读取数据库失败，稍后重试：{error}"})
            self.server.closing.wait(self.poll_s)

    # ── sending: content JSON to the outbox ─────────────────────────────

    def on_message_send(self, params):
        content = params.get("content") or {}
        kind = content.get("kind")
        if kind == "text" and not content.get("text"):
            raise ProtocolError("invalid_params", "content.text")
        if kind in ("image", "sticker") and not (content.get("path") or content.get("stickerId")):
            raise ProtocolError("invalid_params", "content.path")
        if kind not in ("text", "image", "sticker"):
            raise ProtocolError("invalid_params", "content.kind")
        if not params.get("clientId"):
            raise ProtocolError("invalid_params", "clientId")
        chat = self._chat(params.get("chatId"))
        return {"messageId": self.outbox.put(chat, params["clientId"], content)}

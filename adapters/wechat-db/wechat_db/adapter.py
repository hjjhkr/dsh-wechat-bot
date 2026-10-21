"""Protocol v1 adapter backed by WeChat's local databases.

Receiving: polls the watched chat's message tables and emits event/message.
Sending:   writes the content JSON to an outbox file (see outbox.py); delivering
           it into WeChat is out of scope for this adapter.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from .outbox import Outbox
from .reader import Reader
from .rpc import ProtocolError, Server

PROTOCOL_VERSION = 1
RETRY_OPEN_S = 5.0
# After a restart within this window, polling resumes where it left off (nothing is missed);
# after a longer outage it starts from "now" instead of replaying stale messages as new.
RESUME_WINDOW_S = 10 * 60


class Cursor:
    """Position in one chat: the highest sort_seq delivered and the ids delivered at it.

    Keeping the ids makes `sort_seq >= cursor` queries safe when several rows share a
    sort_seq (across shards, or split by a LIMIT) — each is delivered exactly once.
    """

    def __init__(self, seq: int, ids=None):
        self.seq = seq
        # None = a baseline: everything at `seq` already counts as seen.
        self.ids = None if ids is None else set(ids)

    def accepts(self, seq: int, message_id: str) -> bool:
        if seq != self.seq:
            return seq > self.seq
        return self.ids is not None and message_id not in self.ids

    def advance(self, seq: int, message_id: str):
        if seq > self.seq:
            self.seq, self.ids = seq, {message_id}
        elif self.ids is not None:
            self.ids.add(message_id)

    def to_json(self):
        return {"seq": self.seq, "ids": None if self.ids is None else sorted(self.ids), "at": time.time()}


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
        self.cursors: dict[str, Cursor | None] = {}  # None = baseline not established yet
        self.state_lock = threading.RLock()  # cursors
        self.db_lock = threading.RLock()  # database reads (the vendored decryptor is not documented as thread-safe)
        self.save_lock = threading.Lock()  # the poller and shutdown both save cursors
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
        self._save_cursors()
        self.server.closing.set()
        return {}

    def _try_open(self) -> bool:
        if self.reader:
            return True
        try:
            reader = Reader(self.open_source(self.data_dir), self.self_id)
            with self.db_lock:
                reader.names()  # proves the databases can actually be read
        except Exception as error:
            self.open_error = str(error)
            return False
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

    def _name(self, chat_id: str) -> str:
        """Display name for the outbox; best-effort, never a reason to fail a send."""
        if chat_id in self.chat_names:
            return self.chat_names[chat_id]
        try:
            with self.db_lock:
                return self._require().names().get(chat_id, chat_id)
        except Exception:
            return chat_id

    def on_chats_list(self, params):
        with self.db_lock:
            chats = self._require().chats()
        for chat in chats:
            chat["name"] = self.chat_names.get(chat["id"], chat["name"])
        query = params.get("query")
        return {"chats": [c for c in chats if not query or query in c["name"]]}

    def on_chats_members(self, params):
        with self.db_lock:
            return {"members": self._require().members(params["chatId"])}

    def on_chats_history(self, params):
        with self.db_lock:
            return {"messages": self._require().history(params["chatId"], int(params.get("limit", 20)))}

    # ── receiving ───────────────────────────────────────────────────────

    def _cursor_file(self) -> Path:
        return self.data_dir / "wechat-db" / "cursors.json"

    def _saved_cursors(self) -> dict:
        try:
            return json.loads(self._cursor_file().read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}

    def _save_cursors(self):
        with self.state_lock:
            data = {chat_id: c.to_json() for chat_id, c in self.cursors.items() if c}
        if not data:
            return
        path = self._cursor_file()
        try:
            with self.save_lock:
                path.parent.mkdir(parents=True, exist_ok=True)
                tmp = path.with_name(f"{path.name}.{threading.get_ident()}.tmp")
                tmp.write_text(json.dumps(data), encoding="utf-8")
                tmp.replace(path)
        except OSError as error:
            self.server.notify("event/log", {"level": "warn", "message": f"保存读取位置失败：{error}"})

    def _baseline(self, chat_id: str) -> Cursor | None:
        """Where to start: a recent saved position (resume), else the newest message (only new ones count)."""
        saved = self._saved_cursors().get(chat_id)
        if saved and time.time() - saved.get("at", 0) <= RESUME_WINDOW_S:
            return Cursor(int(saved["seq"]), saved.get("ids"))
        try:
            with self.db_lock:
                return Cursor(self._require().latest_seq(chat_id))
        except ProtocolError:
            raise
        except Exception as error:  # slow or locked databases: establish it on a later poll
            self.server.notify("event/log", {"level": "warn", "message": f"暂时读不到「{chat_id}」的最新位置，稍后再试：{error}"})
            return None

    def on_watch_set(self, params):
        chat_ids = list(dict.fromkeys(params.get("chatIds") or []))
        self._require()
        with self.state_lock:
            kept = {chat_id: self.cursors.get(chat_id) for chat_id in chat_ids if self.cursors.get(chat_id)}
        cursors = {chat_id: kept.get(chat_id) or self._baseline(chat_id) for chat_id in chat_ids}
        with self.state_lock:
            self.cursors = cursors
        if cursors and not (self.poller and self.poller.is_alive()):
            self.poller = threading.Thread(target=self._poll, daemon=True)
            self.poller.start()
        return {"watching": chat_ids}

    def _poll_chat(self, chat_id: str, cursor: Cursor | None) -> bool:
        """Emits new messages of one chat; returns whether its cursor moved."""
        if cursor is None:
            fresh = self._baseline(chat_id)
            with self.state_lock:
                if fresh and chat_id in self.cursors and self.cursors[chat_id] is None:
                    self.cursors[chat_id] = fresh
            return False
        with self.db_lock:
            found = self.reader.after(chat_id, cursor.seq)
        moved = False
        for seq, message in found:
            with self.state_lock:
                if self.cursors.get(chat_id) is not cursor:
                    return moved  # unwatched or replaced meanwhile: stop, never resurrect it
                if not cursor.accepts(seq, message["id"]):
                    continue
                cursor.advance(seq, message["id"])
            self.server.notify("event/message", {"message": message})
            moved = True
        return moved

    def _poll(self):
        while not self.server.closing.is_set():
            with self.state_lock:
                targets = list(self.cursors.items())
            if not targets:
                break
            try:
                moved = [self._poll_chat(chat_id, cursor) for chat_id, cursor in targets]
                if any(moved):
                    self._save_cursors()
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
        if kind not in ("text", "image", "sticker"):
            raise ProtocolError("invalid_params", "content.kind")
        if kind == "text" and not content.get("text"):
            raise ProtocolError("invalid_params", "content.text")
        if kind in ("image", "sticker") and not (content.get("path") or content.get("stickerId")):
            raise ProtocolError("invalid_params", "content.path")
        if not params.get("clientId"):
            raise ProtocolError("invalid_params", "clientId")
        chat_id = params.get("chatId")
        if chat_id not in self.cursors:
            known = {c["id"] for c in self.on_chats_list({})["chats"]}
            if chat_id not in known:
                raise ProtocolError("not_found", f"unknown chat {chat_id}")
        return {"messageId": self.outbox.put({"id": chat_id, "name": self._name(chat_id)}, params["clientId"], content)}

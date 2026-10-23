"""Protocol v1 adapter backed by WeChat's local databases.

Receiving: polls the watched chat's message tables and emits event/message.
Sending:   writes content JSON to an outbox by default, or synchronously delivers
           through an explicitly configured sender with a durable attempt log.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path

from .outbox import Outbox
from .delivery import Delivery
from .reader import Reader
from .rpc import ProtocolError, Server

PROTOCOL_VERSION = 1
RETRY_OPEN_S = 5.0
# After a restart within this window, polling resumes where it left off (nothing is missed);
# after a longer outage it starts from "now" instead of replaying stale messages as new.
RESUME_WINDOW_S = 10 * 60
_UNSET_IDENTITY = object()


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
                 outbox_path: str | None = None, chat_names: dict | None = None, sender=None):
        self.server = server
        self.open_source = open_source  # (data_dir) -> source; may raise until WeChat is logged in
        self.self_id = self_id
        self.poll_s = poll_ms / 1000
        self.outbox_path = outbox_path
        self.sender = sender
        self.desktop_control = getattr(sender, 'desktop_control', None)
        self.delivery: Delivery | None = None
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
        self.status_thread = None
        self.status_lock = threading.Lock()
        self.last_status = None
        self.last_sender_error = None
        self.desktop_lifecycle_lock = threading.RLock()
        self.desktop_process_identity = None
        self.desktop_identity_initialized = False
        self.desktop_reprepare_generation = 0
        self.desktop_reprepare_pending = None
        self.desktop_lifecycle_error = None
        self.last_desktop_lifecycle_error = None
        if self.sender is not None:
            set_callback = getattr(self.sender, "set_state_callback", None)
            if callable(set_callback):
                set_callback(self._sender_state_changed)
        for name in ("initialize", "account/status", "account/login", "chats/list", "chats/members",
                     "chats/history", "watch/set", "message/send", "shutdown"):
            server.method(name)(getattr(self, "on_" + name.replace("/", "_")))
        if self.desktop_control is not None:
            server.method('window/get')(self.on_window_get)
            server.method('window/set')(self.on_window_set)

    # ── lifecycle ───────────────────────────────────────────────────────

    def on_initialize(self, params):
        if params.get("protocolVersion") != PROTOCOL_VERSION:
            raise ProtocolError("invalid_params", f"protocol {params.get('protocolVersion')} not supported")
        self.data_dir = Path(params.get("dataDir") or ".")
        if self.sender is not None:
            if self.outbox_path:
                raise ProtocolError("invalid_params", "--outbox and --sender-config are mutually exclusive")
            self.delivery = Delivery(self.data_dir / "wechat-db" / "delivery.jsonl", self.sender, scope=self.self_id)
        else:
            self.outbox = Outbox(self.outbox_path or self.data_dir / "wechat-outbox.jsonl")
        self._try_open()
        if self.sender is not None:
            self._initialize_desktop_identity()
            self._publish_status()
            self.status_thread = threading.Thread(target=self._monitor_status, daemon=True)
            self.status_thread.start()
        result = {
            "protocolVersion": PROTOCOL_VERSION,
            "adapter": {"name": "wechat-db", "version": "0.1.0"},
            "capabilities": {"receive": ["text", "image", "sticker", "voice", "video", "link", "system", "other"],
                             "send": ["text"] if self.sender is not None else ["text", "image", "sticker"], "history": True},
        }
        if self.desktop_control is not None:
            result['capabilities']['window'] = True
        return result

    def on_shutdown(self, _params):
        self.server.closing.set()
        if self.status_thread:
            self.status_thread.join(timeout=1)
        self._save_cursors()
        if self.delivery:
            self.delivery.close()
        return {}

    def _publish_status(self):
        """Database health must never turn a locked sender back on."""
        with self.desktop_lifecycle_lock:
            lifecycle_pending = self.desktop_reprepare_pending is not None
            lifecycle_error = self.desktop_lifecycle_error
        can_send = (self.reader is not None and not lifecycle_pending and lifecycle_error is None
                    and (self.delivery is None or self.delivery.available()))
        sender_error = getattr(self.sender, "preparation_error", None) if self.sender is not None else None
        status = {"connection": "connected" if self.healthy and self.reader else "degraded",
                  "canSend": can_send}
        if not self.reader:
            status["reason"] = "login_required"
        elif not self.healthy:
            status["reason"] = "db_read_failed"
        elif not can_send:
            status["reason"] = "sender_unavailable"
            preparation = getattr(self.sender, "preparation_status", None)
            if lifecycle_error is not None:
                status["reason"] = "sender_recovery_required"
                status["detail"] = lifecycle_error["detail"]
            elif isinstance(preparation, dict):
                if preparation["recoveryRequired"] is True:
                    status["reason"] = "sender_recovery_required"
                    status["detail"] = preparation["error"] or "窗口控制资源恢复尚未确认，发送已暂停。"
                elif lifecycle_pending:
                    status["reason"] = "sender_preparing"
                    status["detail"] = "小号微信窗口身份已变化，等待返回主桌面后重新打开当前会话独立窗口。"
                elif preparation["state"] == "preparing":
                    status["reason"] = "sender_preparing"
                    status["detail"] = "正在打开并绑定微信独立窗口，完成后即可发送。"
                elif preparation["state"] == "failed":
                    status["reason"] = "sender_prepare_failed"
                    status["detail"] = preparation["error"] or "独立窗口准备失败，可重新准备。"
            elif lifecycle_pending:
                status["reason"] = "sender_preparing"
                status["detail"] = "小号微信窗口身份已变化，等待返回主桌面后重新打开当前会话独立窗口。"
        with self.status_lock:
            if status != self.last_status:
                self.server.notify("event/status", status)
                self.last_status = status
            if sender_error:
                report_error = sender_error != self.last_sender_error
                self.last_sender_error = sender_error
            else:
                report_error = False
                self.last_sender_error = None
        if report_error:
            self.server.notify("event/log", {"level": "warn", "message": sender_error})

    def _sender_state_changed(self, level=None, message=None):
        if message:
            with self.status_lock:
                should_log = message != self.last_sender_error
                self.last_sender_error = message
            if should_log:
                self.server.notify("event/log", {"level": level or "warn", "message": message})
        self._publish_status()

    def _monitor_status(self):
        while not self.server.closing.wait(self.poll_s):
            try:
                self._observe_desktop_lifecycle()
            except Exception as error:
                self._record_desktop_lifecycle_error(error, permanent=False)
            self._publish_status()

    def _dynamic_desktop_sender(self) -> bool:
        return (self.desktop_control is not None and self.sender is not None
                and self._dynamic_sender_target())

    def _read_desktop_identity(self):
        identity = self.desktop_control.process_identity()
        if identity is None:
            return None
        started_at = identity.get("startedAt") if isinstance(identity, dict) else None
        pid = identity.get("pid") if isinstance(identity, dict) else None
        if (type(pid) is not int or pid <= 0
                or not isinstance(started_at, (int, float)) or isinstance(started_at, bool)):
            raise ProtocolError("unavailable", "无法确认小号微信进程身份，发送已暂停")
        return pid, float(started_at)

    def _initialize_desktop_identity(self):
        if not self._dynamic_desktop_sender():
            return
        identity = self._read_desktop_identity()
        with self.desktop_lifecycle_lock:
            self.desktop_process_identity = identity
            self.desktop_identity_initialized = True

    def _desktop_reprepare_is_pending(self) -> bool:
        with self.desktop_lifecycle_lock:
            return self.desktop_reprepare_pending is not None

    def _record_desktop_lifecycle_error(self, error, *, permanent):
        detail = f"无法确认或重新绑定小号微信窗口，发送已暂停：{error}"
        with self.desktop_lifecycle_lock:
            previous = self.desktop_lifecycle_error
            # A successful read can clear transient observation failures, but a
            # failed rebind remains visible until a new explicit lifecycle event.
            if (previous is not None and previous["permanent"] and not permanent):
                return
            self.desktop_lifecycle_error = {"detail": detail, "permanent": permanent}
        with self.status_lock:
            should_log = detail != self.last_desktop_lifecycle_error
            self.last_desktop_lifecycle_error = detail
        if should_log:
            self.server.notify("event/log", {"level": "error", "message": detail})

    def _clear_transient_desktop_lifecycle_error(self):
        cleared = False
        with self.desktop_lifecycle_lock:
            if (self.desktop_lifecycle_error is not None
                    and not self.desktop_lifecycle_error["permanent"]):
                self.desktop_lifecycle_error = None
                cleared = True
        if cleared:
            with self.status_lock:
                self.last_desktop_lifecycle_error = None

    def _arm_desktop_reprepare(self, *, visible, identity=_UNSET_IDENTITY):
        if not self._dynamic_desktop_sender():
            return
        if identity is _UNSET_IDENTITY:
            identity = self._read_desktop_identity()
        with self.desktop_lifecycle_lock:
            self.desktop_lifecycle_error = None
            self.desktop_reprepare_generation += 1
            self.desktop_reprepare_pending = {
                "generation": self.desktop_reprepare_generation,
                "identity": identity,
                "saw_visible": visible is True,
                "attempting": False,
            }
        with self.status_lock:
            self.last_desktop_lifecycle_error = None

    def _observe_desktop_lifecycle(self):
        """Wait for a user-visible lifecycle cycle before rebinding the watched target."""
        if not self._dynamic_desktop_sender():
            return
        try:
            identity = self._read_desktop_identity()
            state = self.desktop_control.lifecycle_state()
            if (not isinstance(state, dict)
                    or type(state.get("visible")) is not bool
                    or type(state.get("returned")) is not bool
                    or type(state.get("running")) is not bool):
                raise ProtocolError("unavailable", "小号微信桌面状态无效，发送已暂停")
        except Exception as error:
            self._record_desktop_lifecycle_error(error, permanent=False)
            raise
        visible = state["visible"]
        returned = state["returned"]
        running = state["running"]
        self._clear_transient_desktop_lifecycle_error()

        generation = None
        with self.desktop_lifecycle_lock:
            if not self.desktop_identity_initialized:
                self.desktop_process_identity = identity
                self.desktop_identity_initialized = True
            elif identity != self.desktop_process_identity:
                self.desktop_process_identity = identity
                self.desktop_reprepare_generation += 1
                self.desktop_reprepare_pending = {
                    "generation": self.desktop_reprepare_generation,
                    "identity": identity,
                    "saw_visible": visible is True,
                    "attempting": False,
                }
                self.desktop_lifecycle_error = None

            pending = self.desktop_reprepare_pending
            if pending is None:
                return
            if identity != pending["identity"]:
                pending["identity"] = identity
                pending["saw_visible"] = visible is True
            if visible is True:
                pending["saw_visible"] = True
            if (returned is True and pending["saw_visible"] and identity is not None
                    and running is True and not pending["attempting"]):
                pending["attempting"] = True
                generation = pending["generation"]

        if generation is not None:
            self._attempt_desktop_reprepare(generation)

    def _attempt_desktop_reprepare(self, generation):
        # A return to Default is not enough if the account reader is not ready.
        # account/status re-enters this check after confirming the logged-in DB.
        if self.reader is None:
            self._defer_desktop_reprepare(generation)
            return
        with self.state_lock:
            target_ids = list(self.cursors)
        if len(target_ids) != 1:
            self._defer_desktop_reprepare(generation)
            return
        chat_id = target_ids[0]
        try:
            if self.sender.target_id != chat_id:
                raise ProtocolError("invalid_params", "watched chat differs from the configured sender target")
            outcome = self.sender.reprepare_target(chat_id)
        except Exception as error:
            self._record_desktop_lifecycle_error(error, permanent=True)
            raise
        if outcome == "deferred":
            self._defer_desktop_reprepare(generation)
            return
        if outcome not in ("started", "blocked"):
            error = ProtocolError("unavailable", f"unexpected lifecycle reprepare result: {outcome!r}")
            self._record_desktop_lifecycle_error(error, permanent=True)
            raise error

        with self.desktop_lifecycle_lock:
            pending = self.desktop_reprepare_pending
            if pending is not None and pending["generation"] == generation:
                self.desktop_reprepare_pending = None
        self._publish_status()

    def _defer_desktop_reprepare(self, generation):
        with self.desktop_lifecycle_lock:
            pending = self.desktop_reprepare_pending
            if pending is not None and pending["generation"] == generation:
                pending["attempting"] = False

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
        if self._try_open():
            self._observe_desktop_lifecycle()
            self._publish_status()
        return self._account()

    def on_account_login(self, _params):
        if self.desktop_control is not None:
            state = self.on_window_set({'visible': True})
            self._arm_desktop_reprepare(visible=state.get('visible') is True)
            self._publish_status()
            with self.state_lock:
                has_watched_target = len(self.cursors) == 1
            if has_watched_target:
                instructions = '已显示小号微信。请在小号桌面扫码或确认登录，再点“返回主桌面”；系统会自动重新打开当前监听会话的独立窗口。'
            else:
                instructions = '已显示小号微信。请在小号桌面扫码或确认登录，再点“返回主桌面”，然后选择要监听的服务会话；系统会自动打开该会话的独立窗口。'
            return {'state': 'login_required', 'instructions': instructions}
        if not self._try_open() and not (self.opener and self.opener.is_alive()):
            self.opener = threading.Thread(target=self._keep_opening, daemon=True)
            self.opener.start()
        return self._account()

    def on_window_get(self, _params):
        from .desktop_control import DesktopControlError
        try:
            return self.desktop_control.state()
        except DesktopControlError as error:
            raise ProtocolError('unavailable', str(error)) from error

    def on_window_set(self, params):
        from .desktop_control import DesktopControlError
        if type(params.get('visible')) is not bool:
            raise ProtocolError('invalid_params', 'visible must be a boolean')
        try:
            state = self.desktop_control.set_visible(params['visible'])
            self._observe_desktop_lifecycle()
            self._publish_status()
            return state
        except DesktopControlError as error:
            raise ProtocolError('unavailable', str(error)) from error

    def _keep_opening(self):
        while not self.server.closing.is_set():
            if self._try_open():
                self.server.notify("event/account", self._account())
                self._publish_status()
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

    def _dynamic_sender_target(self) -> bool:
        return self.sender is not None and getattr(self.sender, "detached_window", False) is True

    def _chats(self) -> list[dict]:
        with self.db_lock:
            chats = self._require().chats()
        for chat in chats:
            chat["name"] = self.chat_names.get(chat["id"], chat["name"])
        return chats

    def _known_chat(self, chat_id: str) -> dict:
        for chat in self._chats():
            if chat["id"] == chat_id:
                return chat
        raise ProtocolError("not_found", f"unknown chat {chat_id}")

    def on_chats_list(self, params):
        chats = self._chats()
        if self.sender is not None and not self._dynamic_sender_target():
            chats = [chat for chat in chats if chat["id"] == self.sender.target_id]
        query = params.get("query")
        return {"chats": [c for c in chats if not query or query in c["name"]]}

    def on_chats_members(self, params):
        self._check_target(params["chatId"])
        with self.db_lock:
            return {"members": self._require().members(params["chatId"])}

    def on_chats_history(self, params):
        self._check_target(params["chatId"])
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
        dynamic_target = self._dynamic_sender_target()
        selected_chat = None
        if dynamic_target:
            if len(chat_ids) > 1:
                raise ProtocolError("invalid_params", "watch/set accepts at most one active chat for live delivery")
            if chat_ids:
                selected_chat = self._known_chat(chat_ids[0])
        else:
            for chat_id in chat_ids:
                self._check_target(chat_id)
        self._require()
        if dynamic_target and selected_chat is not None:
            self.sender.select_target(selected_chat)
        with self.state_lock:
            kept = {chat_id: self.cursors.get(chat_id) for chat_id in chat_ids if self.cursors.get(chat_id)}
        cursors = {chat_id: kept.get(chat_id) or self._baseline(chat_id) for chat_id in chat_ids}
        with self.state_lock:
            self.cursors = cursors
        if dynamic_target:
            if chat_ids:
                if not self._desktop_reprepare_is_pending():
                    self.sender.prepare_target(chat_ids[0])
            else:
                self.sender.invalidate_target()
            self._observe_desktop_lifecycle()
            self._publish_status()
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
                    self._publish_status()
            except Exception as error:  # a bad read is retried next poll, never fatal
                if self.healthy:
                    self.healthy = False
                    self._publish_status()
                    self.server.notify("event/log", {"level": "warn", "message": f"读取数据库失败，稍后重试：{error}"})
            self.server.closing.wait(self.poll_s)

    # ── sending: explicit live delivery or content JSON to the outbox ────

    def _check_target(self, chat_id, *, sending: bool = False):
        if self.sender is None:
            return
        if self._dynamic_sender_target():
            if sending:
                if chat_id != self.sender.target_id:
                    raise ProtocolError("invalid_params", "chat is outside the selected sender target")
            else:
                self._known_chat(chat_id)
            return
        if chat_id != self.sender.target_id:
            raise ProtocolError("invalid_params", "chat is outside the configured sender target")

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
        with self.desktop_lifecycle_lock:
            lifecycle_pending = (self.desktop_reprepare_pending is not None
                                 or self.desktop_lifecycle_error is not None)
        if lifecycle_pending:
            raise ProtocolError(
                "unavailable",
                "小号微信窗口正在重新绑定；完成独立会话准备前不会发送任何内容",
            )
        chat_id = params.get("chatId")
        self._check_target(chat_id, sending=True)
        if chat_id not in self.cursors:
            known = {c["id"] for c in self.on_chats_list({})["chats"]}
            if chat_id not in known:
                raise ProtocolError("not_found", f"unknown chat {chat_id}")
        if self.delivery is not None:
            try:
                return {"messageId": self.delivery.send(chat_id, content, params["clientId"])}
            finally:
                self._publish_status()
        return {"messageId": self.outbox.put({"id": chat_id, "name": self._name(chat_id)}, params["clientId"], content)}

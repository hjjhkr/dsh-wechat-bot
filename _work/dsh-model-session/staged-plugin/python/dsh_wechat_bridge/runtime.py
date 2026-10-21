"""Windows runtime for one exact Weixin account and one direct conversation."""

from __future__ import annotations

import time
from typing import Any

from .diagnostics import safe_reason_code, safe_send_attempted
from .db_reader import DbScopeError, create_scoped_database, verify_target_contact
from .gate import GateExecutionError, GateError, make_gate
from .process import ProcessBindingError, find_binding, verify_account_binding
from .uia_send import BackgroundUISender
from .group import group_members, group_rows, is_group


class RuntimeScopeError(RuntimeError):
    pass


def normalize_poll_rows(rows: list[dict[str, Any]], bot: str, target: str, group: bool = False) -> list[dict[str, Any]]:
    """Map only the two participants of the configured direct conversation."""
    output = []
    for row in rows:
        sender = row.get("sender_username")
        if (group and row.get("is_group_member") is not True) or (not group and sender not in (bot, target)):
            raise RuntimeScopeError("message sender is outside the configured direct conversation")
        shard = row.get("shard")
        local_id = row.get("local_id")
        sort_seq = row.get("sort_seq")
        timestamp = row.get("create_time")
        text = row.get("content")
        if (
            not isinstance(shard, str) or not shard
            or type(local_id) is not int or local_id < 0
            or type(sort_seq) is not int or sort_seq < 0
            or type(timestamp) is not int
            or not isinstance(text, str)
        ):
            raise RuntimeScopeError("database returned an incomplete message row")
        output.append({
            "bot": bot,
            "target": target,
            "shard": shard,
            "local_id": local_id,
            "sort_seq": sort_seq,
            "senderId": sender,
            "text": text,
            "timestamp": timestamp,
            "isSelf": sender == bot,
        })
        if group:
            output[-1].update({"isGroupMember": True, "mentionedBot": row["mentioned_bot"],
                               "senderName": row["sender_name"]})
    return output


def match_outgoing_row(
    db: Any,
    target: str,
    bot: str,
    text: str,
    since_seq: int,
    started_at: float,
) -> dict[str, Any] | None:
    """Return one complete exact outgoing proof, or None for absent/ambiguous proof."""
    rows = db.get_new_messages(target, since_seq=since_seq, limit=200)
    matches = [
        row for row in rows
        if row.get("sender_username") == bot
        and (row.get("content") == text or
             (target.endswith("@chatroom") and row.get("content") == bot + ":\n" + text))
        and type(row.get("sort_seq")) is int
        and row["sort_seq"] > since_seq
        and type(row.get("create_time")) is int
        and row["create_time"] >= int(started_at) - 2
    ]
    if len(matches) != 1:
        return None
    message = matches[0]
    detail = db.get_message_row(target, message["local_id"], shard=message["shard"])
    if not isinstance(detail, dict):
        return None
    server_id = detail.get("server_id")
    if type(server_id) is not int or server_id <= 0:
        return None
    return {
        "target": target,
        "senderId": bot,
        "text": text,
        # Keep server IDs as decimal text on the wire: JavaScript Number cannot
        # exactly represent every WeChat server_id value.
        "serverId": str(server_id),
        "localId": message["local_id"],
        "shard": message["shard"],
        "sortSeq": message["sort_seq"],
    }


class WindowsRuntime:
    """Own the live process binding and read-only database reader for one session."""

    def __init__(self, binding_factory=find_binding, db_factory=create_scoped_database, sender_factory=None):
        self._binding_factory = binding_factory
        self._db_factory = db_factory
        self._binding: dict[str, Any] | None = None
        self._db: Any = None
        self._config: dict[str, Any] | None = None
        self._gate: Any = None
        self._sender_factory = sender_factory

    def probe(self, config: dict[str, Any]) -> dict[str, Any]:
        if self._binding is not None or self._db is not None:
            raise RuntimeScopeError("runtime already owns a process binding")
        try:
            binding = self._binding_factory(config)
            db = self._db_factory(config, binding["accountName"])
            verify_account_binding(config, binding)
            self_info = db.get_self_info()
            self_name = self_info.get("remark") or self_info.get("nick_name") or ""
            if self_info.get("username") != config["botWxid"] or self_name != config["botName"]:
                raise RuntimeScopeError("configured bot wxid and exact display name do not match")
            verify_target_contact(db, config["targetWxid"], config["targetName"])
            if is_group(config):
                group_members(db, config["targetWxid"], config["botWxid"])
        except (ProcessBindingError, DbScopeError) as exc:
            raise RuntimeScopeError(str(exc)) from exc
        self._binding = binding
        self._db = db
        self._config = dict(config)
        return {
            "selfId": config["botWxid"],
            "targetId": config["targetWxid"],
            "binding": dict(binding),
        }

    def verify(self, config: dict[str, Any], session: dict[str, Any]) -> None:
        if self._binding is None or self._db is None or self._config != config:
            raise RuntimeScopeError("runtime session is not bound to this configuration")
        if not isinstance(session, dict) or session.get("selfId") != config["botWxid"]:
            raise RuntimeScopeError("runtime session identity changed")
        try:
            verify_account_binding(config, self._binding)
        except ProcessBindingError as exc:
            raise RuntimeScopeError(str(exc)) from exc

    def baseline(self, config: dict[str, Any], session: dict[str, Any]) -> dict[str, Any]:
        self.verify(config, session)
        latest = self._db.get_messages(config["targetWxid"], limit=1)
        if latest:
            high_water = latest[0].get("sort_seq")
            if type(high_water) is not int or high_water < 0:
                raise RuntimeScopeError("database baseline cursor is invalid")
        else:
            high_water = 0
        return {
            "selfId": config["botWxid"],
            "targetId": config["targetWxid"],
            "cursor": {"sortSeq": high_water},
        }

    def conversations(self, config, session):
        self.verify(config, session)
        from .conversations import catalog
        return {"selfId": config["botWxid"], "conversations": catalog(self._db, config["botWxid"])}

    def poll(
        self,
        config: dict[str, Any],
        session: dict[str, Any],
        cursor: dict[str, Any],
        overlap_seq: int,
        max_items: int,
    ) -> dict[str, Any]:
        self.verify(config, session)
        if not isinstance(cursor, dict) or type(cursor.get("sortSeq")) is not int or cursor["sortSeq"] < 0:
            raise RuntimeScopeError("poll cursor is invalid")
        if type(overlap_seq) is not int or overlap_seq < 0 or type(max_items) is not int or max_items < 1:
            raise RuntimeScopeError("poll limits are invalid")
        since_seq = max(0, cursor["sortSeq"] - overlap_seq)
        rows = self._db.get_new_messages(config["targetWxid"], since_seq=since_seq, limit=max_items)
        normalized = group_rows(self._db, rows, config["targetWxid"], config["botWxid"]) if is_group(config) else rows
        messages = normalize_poll_rows(normalized, config["botWxid"], config["targetWxid"], is_group(config))
        latest = max((item["sort_seq"] for item in rows), default=cursor["sortSeq"])
        return {
            "messages": messages,
            "nextCursor": {"sortSeq": max(cursor["sortSeq"], latest)},
            "complete": len(rows) < max_items,
        }

    def send(self, config: dict[str, Any], session: dict[str, Any], params: dict[str, Any]) -> dict[str, Any]:
        self.verify(config, session)
        if params.get("enableSend") is not True or params.get("allowTemporaryGate") is not True:
            raise RuntimeScopeError("both send permissions are required")
        if params.get("target") != config["targetWxid"] or params.get("expectedSelfId") != config["botWxid"]:
            raise RuntimeScopeError("send identity is outside the configured scope")
        text = params.get("text")
        if not isinstance(text, str) or not text or len(text) > 4096:
            raise RuntimeScopeError("send text is invalid")
        try:
            latest = self._db.get_messages(config["targetWxid"], limit=1)
            if latest:
                since_seq = latest[0].get("sort_seq")
                if type(since_seq) is not int or since_seq < 0:
                    raise RuntimeScopeError("database send cursor is invalid")
            else:
                since_seq = 0
        except Exception:
            return {
                "status": "ambiguous", "reasonCode": "db_verify", "sendAttempted": False,
                "gateActive": False, "gateRestored": True,
            }
        attempt_started = time.time()
        try:
            gate = make_gate(config, session)
        except Exception:
            return {
                "status": "ambiguous", "reasonCode": "gate_preflight", "sendAttempted": False,
                "gateActive": False, "gateRestored": True,
            }
        self._gate = gate
        try:
            sender = (self._sender_factory or BackgroundUISender)(config, self._binding)
            ui_result, gate_state = sender.send(text, config["targetName"], gate)
        except GateExecutionError as exc:
            if exc.state.get("gateActive") is False and exc.state.get("gateRestored") is True:
                self._gate = None
            restored = exc.state.get("gateActive") is False and exc.state.get("gateRestored") is True
            return {
                "status": "ambiguous",
                "reasonCode": "gate_restore" if not restored else safe_reason_code(exc.reason_code),
                "sendAttempted": safe_send_attempted(exc.send_attempted),
                "gateActive": exc.state.get("gateActive"),
                "gateRestored": exc.state.get("gateRestored") is True,
            }
        except Exception as exc:
            try:
                gate_state = gate.close()
            except Exception:
                gate_state = {"gateActive": None, "gateRestored": False}
            if gate_state.get("gateActive") is False and gate_state.get("gateRestored") is True:
                self._gate = None
            restored = gate_state.get("gateActive") is False and gate_state.get("gateRestored") is True
            attempted = safe_send_attempted(getattr(exc, "send_attempted", None))
            if attempted is None and isinstance(exc, (GateError, RuntimeScopeError)):
                attempted = False
            return {
                "status": "ambiguous",
                "reasonCode": (
                    "gate_restore" if not restored else
                    "gate_preflight" if isinstance(exc, GateError) else
                    safe_reason_code(getattr(exc, "reason_code", None))
                ),
                "sendAttempted": attempted,
                "gateActive": gate_state.get("gateActive"),
                "gateRestored": gate_state.get("gateRestored") is True,
            }
        if gate_state.get("gateActive") is not False or gate_state.get("gateRestored") is not True:
            return {
                "status": "ambiguous", "reasonCode": "gate_restore",
                "sendAttempted": safe_send_attempted(ui_result.get("sendAttempted")),
                "gateActive": gate_state.get("gateActive"), "gateRestored": False,
            }
        self._gate = None
        send_attempted = safe_send_attempted(ui_result.get("sendAttempted"))
        if ui_result.get("noBotFocusObserved") is not True:
            reason_code = "monitor_start" if ui_result.get("monitorErrors") else (
                "targeted_return" if send_attempted is True else "uia_draft"
            )
            return {
                "status": "ambiguous", "reasonCode": reason_code,
                "sendAttempted": send_attempted, "gateActive": False, "gateRestored": True,
            }
        if send_attempted is not True:
            return {
                "status": "ambiguous", "reasonCode": "send_unknown",
                "sendAttempted": send_attempted, "gateActive": False, "gateRestored": True,
            }
        deadline = time.monotonic() + 4.0
        outgoing = None
        try:
            while time.monotonic() < deadline:
                self.verify(config, session)
                outgoing = match_outgoing_row(
                    self._db, config["targetWxid"], config["botWxid"], text,
                    since_seq, attempt_started,
                )
                if outgoing:
                    break
                time.sleep(0.15)
        except Exception:
            return {
                "status": "ambiguous", "reasonCode": "db_verify", "sendAttempted": True,
                "gateActive": False, "gateRestored": True,
            }
        if outgoing is None:
            return {
                "status": "ambiguous", "reasonCode": "db_verify", "sendAttempted": True,
                "gateActive": False, "gateRestored": True,
            }
        return {"status": "confirmed", "outgoing": outgoing,
                "sendAttempted": True, "gateActive": False, "gateRestored": True}

    def close(self) -> dict[str, Any]:
        gate_state = {"gateActive": False, "gateRestored": True}
        if self._gate is not None:
            gate_state = self._gate.close()
        self._db = None
        self._binding = None
        self._config = None
        return {
            "closed": True,
            "gateActive": gate_state.get("gateActive"),
            "gateRestored": gate_state.get("gateRestored") is True,
        }


"""Read chats, members and messages of one WeChat 4.x account, as protocol objects.

Schema facts this relies on (WeChat 4.x, db_storage/):
  contact/contact.db   contact(id, username, alias, nick_name, remark, …),
                       chat_room(id, username, owner, ext_buffer), chatroom_member(room_id, member_id)

Identity is always the wxid (contact.username, which never changes). Names are
looked up fresh (cached for NAME_TTL seconds) and attached to it: `name` is what
the person shows in that chat — group nickname, else the account's remark for
them, else their nickname — and `aliases` lists every other name they go by,
including their WeChat ID (contact.alias).
  message/message_N.db Msg_<md5(chat username)>(local_id, server_id, local_type, sort_seq,
                       real_sender_id, create_time, source, message_content, compress_content)
                       Name2Id(user_name) — real_sender_id is a rowid of *this shard's* Name2Id.
A chat's table may be split over several shards; local_id is only unique per shard.
"""
from __future__ import annotations

import hashlib
import time

from . import content as c
from .roomdata import group_nicknames

SPECIAL = {"weixin", "newsapp", "fmessage", "medianote", "floatbottle", "filehelper", "notifymessage"}
NAME_TTL = 10.0  # renames show up within this long


def table_of(chat_id: str) -> str:
    return "Msg_" + hashlib.md5(chat_id.encode()).hexdigest()


def is_group(chat_id: str) -> bool:
    return chat_id.endswith("@chatroom")


class Reader:
    def __init__(self, source, self_id: str):
        self.source = source
        self.self_id = self_id
        self._contacts: dict[str, dict] = {}
        self._contacts_at = 0.0
        self._rooms: dict[str, tuple[float, dict[str, str]]] = {}

    # ── contacts ────────────────────────────────────────────────────────

    def contacts(self) -> dict[str, dict]:
        """wxid → {nick, remark, alias}, cached briefly."""
        if time.monotonic() - self._contacts_at > NAME_TTL:
            conn = self.source.contact()
            try:
                try:
                    rows = conn.execute("SELECT username, nick_name, remark, alias FROM contact").fetchall()
                except Exception:  # an older schema without `alias`
                    rows = conn.execute("SELECT username, nick_name, remark, '' AS alias FROM contact").fetchall()
            finally:
                conn.close()
            self._contacts = {r["username"]: {"nick": r["nick_name"] or "", "remark": r["remark"] or "", "alias": r["alias"] or ""}
                              for r in rows if r["username"]}
            self._contacts_at = time.monotonic()
        return self._contacts

    def names(self) -> dict[str, str]:
        """wxid → display name outside any group (remark, else nickname)."""
        return {wxid: (x["remark"] or x["nick"] or wxid) for wxid, x in self.contacts().items()}

    def group_nicknames(self, chat_id: str) -> dict[str, str]:
        """wxid → group nickname in this group, cached briefly; empty when unreadable."""
        if not is_group(chat_id):
            return {}
        cached = self._rooms.get(chat_id)
        if cached and time.monotonic() - cached[0] <= NAME_TTL:
            return cached[1]
        nicknames: dict[str, str] = {}
        try:
            conn = self.source.contact()
            try:
                row = conn.execute("SELECT ext_buffer FROM chat_room WHERE username = ?", (chat_id,)).fetchone()
            finally:
                conn.close()
            nicknames = group_nicknames(row["ext_buffer"] if row else None)
        except Exception:
            pass  # no group nicknames is fine; names fall back to remark/nickname
        self._rooms[chat_id] = (time.monotonic(), nicknames)
        return nicknames

    def person(self, chat_id: str, wxid: str) -> dict:
        """{id, name, aliases?} of someone as seen in this chat. The id is the key; names are labels."""
        contact = self.contacts().get(wxid, {})
        names = [self.group_nicknames(chat_id).get(wxid), contact.get("remark"), contact.get("nick"), contact.get("alias")]
        unique = list(dict.fromkeys(n.strip() for n in names if n and n.strip()))
        person = {"id": wxid, "name": unique[0] if unique else wxid}
        if len(unique) > 1:
            person["aliases"] = unique[1:]
        return person

    def self_info(self) -> dict:
        return {"id": self.self_id, "name": self.names().get(self.self_id, self.self_id)}

    def _tables(self) -> set[str]:
        tables = set()
        for _, open_shard in self.source.shards():
            conn = open_shard()
            try:
                tables.update(r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"))
            finally:
                conn.close()
        return tables

    def chats(self) -> list[dict]:
        """Chats that have messages: groups first, then direct chats, by name."""
        conn = self.source.contact()
        try:
            rows = conn.execute("SELECT username, nick_name, remark FROM contact").fetchall()
            counts = dict(conn.execute(
                "SELECT r.username, COUNT(m.member_id) FROM chat_room r LEFT JOIN chatroom_member m ON m.room_id = r.id GROUP BY r.id"
            ).fetchall())
        finally:
            conn.close()
        tables = self._tables()
        result = []
        for r in rows:
            chat_id = r["username"]
            if not chat_id or chat_id == self.self_id or chat_id in SPECIAL or chat_id.startswith("gh_"):
                continue
            if table_of(chat_id) not in tables:
                continue
            chat = {"id": chat_id, "name": r["remark"] or r["nick_name"] or chat_id, "kind": "group" if is_group(chat_id) else "direct"}
            if chat_id in counts:
                chat["memberCount"] = counts[chat_id]
            result.append(chat)
        return sorted(result, key=lambda x: (x["kind"] != "group", x["name"], x["id"]))

    def members(self, chat_id: str) -> list[dict]:
        if not is_group(chat_id):
            return [self.person(chat_id, chat_id), self.person(chat_id, self.self_id)]
        conn = self.source.contact()
        try:
            rows = conn.execute(
                "SELECT c.username FROM chat_room r "
                "JOIN chatroom_member m ON m.room_id = r.id JOIN contact c ON c.id = m.member_id "
                "WHERE r.username = ?", (chat_id,)).fetchall()
        finally:
            conn.close()
        self._rooms.pop(chat_id, None)  # a member lookup (e.g. /attack) always sees the latest names
        self._contacts_at = 0.0
        return [self.person(chat_id, r["username"]) for r in rows if r["username"]]

    # ── messages ────────────────────────────────────────────────────────

    def _rows(self, chat_id: str, where: str, params: tuple, order: str, limit: int):
        """Rows of a chat across shards, each with its shard's sender map applied."""
        table = table_of(chat_id)
        found = []
        for label, open_shard in self.source.shards():
            conn = open_shard()
            try:
                exists = conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (table,)).fetchone()
                if not exists:
                    continue
                senders = {int(rid): name for rid, name in conn.execute("SELECT rowid, user_name FROM Name2Id")}
                rows = conn.execute(
                    f"SELECT local_id, server_id, local_type, sort_seq, real_sender_id, create_time, source, "
                    f"message_content, compress_content FROM {table} {where} {order} LIMIT ?", params + (limit,)).fetchall()
            finally:
                conn.close()
            found += [(label, senders, row) for row in rows]
        return found

    def latest_seq(self, chat_id: str) -> int:
        rows = self._rows(chat_id, "", (), "ORDER BY sort_seq DESC", 1)
        return max((row["sort_seq"] for _, _, row in rows), default=0)

    def after(self, chat_id: str, seq: int, limit: int = 200) -> list[tuple[int, dict]]:
        """Messages with sort_seq >= seq (inclusive: the caller de-duplicates the boundary), oldest first."""
        rows = self._rows(chat_id, "WHERE sort_seq >= ?", (seq,), "ORDER BY sort_seq ASC, local_id ASC", limit)
        rows.sort(key=lambda item: (item[2]["sort_seq"], item[0], item[2]["local_id"]))
        return [(row["sort_seq"], self.parse(chat_id, label, senders, row)) for label, senders, row in rows[:limit]]

    def history(self, chat_id: str, limit: int) -> list[dict]:
        rows = self._rows(chat_id, "", (), "ORDER BY sort_seq DESC", limit)
        rows.sort(key=lambda item: (item[2]["sort_seq"], item[0], item[2]["local_id"]))
        return [self.parse(chat_id, label, senders, row) for label, senders, row in rows[-limit:]]

    def parse(self, chat_id: str, shard: str, senders: dict[int, str], row) -> dict:
        base, sub = c.split_type(row["local_type"])
        kind = c.KINDS.get(base, "other")
        body = c.decode(row["message_content"])
        if not body and row["compress_content"]:
            body = c.decode(row["compress_content"])
        prefix, body = c.strip_sender(body) if is_group(chat_id) else (None, body)
        sender_id = senders.get(row["real_sender_id"] or -1) or prefix or (chat_id if not is_group(chat_id) else "")
        message = {
            "id": str(row["server_id"]) if row["server_id"] else f"{shard}:{row['local_id']}",
            "chatId": chat_id,
            "time": int(row["create_time"] or 0) * 1000,
            "kind": kind,
            "text": "",
            "sender": self.person(chat_id, sender_id) if sender_id else {"id": "unknown", "name": "unknown"},
            "fromSelf": sender_id == self.self_id,
            "mentions": c.mentions(row["source"]),
        }
        if kind == "text" or kind == "system":
            message["text"] = body
        elif base == 49:
            app = c.appmsg(body) or {}
            if app.get("type") == c.APPMSG_QUOTE or sub == c.APPMSG_QUOTE:
                message["kind"] = "text"
                message["text"] = app.get("title", "")
                if app.get("quote"):
                    message["quote"] = app["quote"]
            else:
                message["text"] = app.get("title", "")
                if app.get("description"):
                    message["media"] = {"description": app["description"]}
        elif kind == "sticker":
            info = c.emoji(body)
            message["media"] = {"mime": "image/gif", **({"description": info["desc"]} if info.get("desc") else {})}
        elif kind == "image":
            message["media"] = {"mime": "image/jpeg"}
        if message["kind"] == "text" and not message["text"]:
            message["kind"] = "other"
        return message

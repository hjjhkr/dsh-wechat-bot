"""Builds unencrypted databases with WeChat 4.x's schema, for tests."""
from __future__ import annotations

import hashlib
import sqlite3
from pathlib import Path

import zstandard

BOT = "wxid_bot"
GROUP = "12345678@chatroom"
MEMBERS = {"wxid_alice": "阿离", "wxid_bob": "老鲍", BOT: "小鲸鱼"}
QUOTE_TYPE = (57 << 32) | 49


def zstd(text: str) -> bytes:
    return zstandard.ZstdCompressor().compress(text.encode("utf-8"))


def at_source(*wxids: str) -> bytes:
    return zstd(f"<msgsource><atuserlist><![CDATA[{','.join(wxids)}]]></atuserlist><silence>0</silence></msgsource>")


class Account:
    """A fake db_storage/ directory. Messages can be appended while an adapter is watching."""

    def __init__(self, root: Path, shards: int = 2):
        self.root = Path(root)
        (self.root / "contact").mkdir(parents=True, exist_ok=True)
        (self.root / "message").mkdir(parents=True, exist_ok=True)
        self.seq = 1000
        self.server_id = 9_000_000
        self.shards = [self.root / "message" / f"message_{i}.db" for i in range(shards)]
        self._contacts()
        for path in self.shards:
            with sqlite3.connect(path) as conn:
                conn.execute("CREATE TABLE Name2Id (user_name TEXT UNIQUE)")

    def _contacts(self):
        with sqlite3.connect(self.root / "contact" / "contact.db") as conn:
            conn.executescript("""
                CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, alias TEXT, remark TEXT, nick_name TEXT);
                CREATE TABLE chat_room (id INTEGER PRIMARY KEY, username TEXT, owner TEXT, ext_buffer BLOB);
                CREATE TABLE chatroom_member (room_id INTEGER, member_id INTEGER);
            """)
            ids = {}
            for wxid, name in [*MEMBERS.items(), ("wxid_friend", "老朋友"), ("gh_news", "某公众号"), ("filehelper", "文件传输助手")]:
                ids[wxid] = conn.execute("INSERT INTO contact (username, nick_name, remark) VALUES (?, ?, ?)",
                                         (wxid, name, "")).lastrowid
            conn.execute("UPDATE contact SET remark = '鲍哥' WHERE username = 'wxid_bob'")
            ids[GROUP] = conn.execute("INSERT INTO contact (username, nick_name) VALUES (?, '测试群')", (GROUP,)).lastrowid
            room = conn.execute("INSERT INTO chat_room (username, owner) VALUES (?, 'wxid_alice')", (GROUP,)).lastrowid
            for wxid in MEMBERS:
                conn.execute("INSERT INTO chatroom_member VALUES (?, ?)", (room, ids[wxid]))

    def add(self, chat: str, sender: str, body, *, local_type: int = 1, source=None, shard: int = 0,
            compress: bool = False, server_id: int | None = None, prefix: bool | None = None) -> str:
        """Appends one message row the way WeChat stores it; returns its protocol id."""
        table = "Msg_" + hashlib.md5(chat.encode()).hexdigest()
        if prefix is None:
            prefix = chat.endswith("@chatroom") and sender != BOT
        text = f"{sender}:\n{body}" if prefix and isinstance(body, str) else body
        content = zstd(text) if compress and isinstance(text, str) else text
        self.seq += 1
        server_id = self.server_id + self.seq if server_id is None else server_id
        with sqlite3.connect(self.shards[shard]) as conn:
            conn.execute(f"""CREATE TABLE IF NOT EXISTS {table} (local_id INTEGER PRIMARY KEY AUTOINCREMENT,
                server_id INTEGER, local_type INTEGER, sort_seq INTEGER, real_sender_id INTEGER, create_time INTEGER,
                status INTEGER, source BLOB, message_content TEXT, compress_content BLOB, packed_info_data BLOB)""")
            conn.execute("INSERT OR IGNORE INTO Name2Id (user_name) VALUES (?)", (sender,))
            sender_row = conn.execute("SELECT rowid FROM Name2Id WHERE user_name = ?", (sender,)).fetchone()[0]
            cursor = conn.execute(
                f"INSERT INTO {table} (server_id, local_type, sort_seq, real_sender_id, create_time, status, source, message_content) "
                "VALUES (?, ?, ?, ?, ?, 2, ?, ?)",
                (server_id, local_type, self.seq, sender_row, 1_792_600_000 + self.seq, source, content))
            local_id = cursor.lastrowid
        return str(server_id) if server_id else f"message_{shard}.db:{local_id}"

    def quote(self, chat, sender, reply, quoted_id, quoted_sender, quoted_name, quoted_text, **kw):
        xml = (f"<msg><appmsg appid=\"\" sdkver=\"0\"><title>{reply}</title><type>57</type>"
               f"<refermsg><type>1</type><svrid>{quoted_id}</svrid><fromusr>{chat}</fromusr>"
               f"<chatusr>{quoted_sender}</chatusr><displayname>{quoted_name}</displayname>"
               f"<content>{quoted_text}</content></refermsg></appmsg></msg>")
        return self.add(chat, sender, xml, local_type=QUOTE_TYPE, compress=True, **kw)

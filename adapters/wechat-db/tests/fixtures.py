"""Builds unencrypted databases with WeChat 4.x's schema, for tests."""
from __future__ import annotations

import hashlib
import sqlite3
from contextlib import contextmanager
from pathlib import Path

import zstandard

BOT = "wxid_bot"
GROUP = "12345678@chatroom"
MEMBERS = {"wxid_alice": "阿离", "wxid_bob": "老鲍", BOT: "小鲸鱼"}
QUOTE_TYPE = (57 << 32) | 49


@contextmanager
def connect(path):
    """Commit and close (sqlite3's own context manager leaves the file open, which Windows notices)."""
    conn = sqlite3.connect(path)
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def zstd(text: str) -> bytes:
    return zstandard.ZstdCompressor().compress(text.encode("utf-8"))


def at_source(*wxids: str) -> bytes:
    return zstd(f"<msgsource><atuserlist><![CDATA[{','.join(wxids)}]]></atuserlist><silence>0</silence></msgsource>")


def _pb_varint(n: int) -> bytes:
    out = bytearray()
    while True:
        byte, n = n & 0x7F, n >> 7
        out.append(byte | (0x80 if n else 0))
        if not n:
            return bytes(out)


def _pb_bytes(field: int, value: bytes) -> bytes:
    return _pb_varint(field << 3 | 2) + _pb_varint(len(value)) + value


def room_data(nicknames: dict[str, str]) -> bytes:
    """chat_room.ext_buffer: ChatRoomData { repeated Member { user_name=1, display_name=2, state=3 } = 1 },
    with an unrelated varint field in front, as real buffers carry more than members."""
    members = b"".join(
        _pb_bytes(1, _pb_bytes(1, wxid.encode()) + _pb_bytes(2, nick.encode()) + _pb_varint(3 << 3) + _pb_varint(0))
        for wxid, nick in nicknames.items())
    return _pb_varint(2 << 3) + _pb_varint(7) + members


class Account:
    """A fake db_storage/ directory. Messages can be appended while an adapter is watching."""

    def __init__(self, root: Path, shards: int = 2):
        self.root = Path(root)
        (self.root / "contact").mkdir(parents=True, exist_ok=True)
        (self.root / "message").mkdir(parents=True, exist_ok=True)
        self.seq = 1000
        self.server_id = 9_000_000
        self.shards = [self.root / "message" / f"message_{i}.db" for i in range(shards)]
        self.group_nicknames: dict[str, str] = {}
        self._contacts()
        for path in self.shards:
            with connect(path) as conn:
                conn.execute("CREATE TABLE Name2Id (user_name TEXT UNIQUE)")

    def _contacts(self):
        with connect(self.root / "contact" / "contact.db") as conn:
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

    def set_group_nickname(self, wxid: str, nickname: str, chat: str = GROUP):
        self.group_nicknames[wxid] = nickname
        with connect(self.root / "contact" / "contact.db") as conn:
            conn.execute("UPDATE chat_room SET ext_buffer = ? WHERE username = ?", (room_data(self.group_nicknames), chat))

    def set_contact(self, wxid: str, **fields):
        """Changes nick_name / remark / alias of a contact, as WeChat does when someone renames."""
        with connect(self.root / "contact" / "contact.db") as conn:
            for column, value in fields.items():
                assert column in {"nick_name", "remark", "alias"}
                conn.execute(f"UPDATE contact SET {column} = ? WHERE username = ?", (value, wxid))

    def add(self, chat: str, sender: str, body, *, local_type: int = 1, source=None, shard: int = 0,
            compress: bool = False, server_id: int | None = None, prefix: bool | None = None, seq: int | None = None) -> str:
        """Appends one message row the way WeChat stores it; returns its protocol id."""
        table = "Msg_" + hashlib.md5(chat.encode()).hexdigest()
        if prefix is None:
            prefix = chat.endswith("@chatroom") and sender != BOT
        text = f"{sender}:\n{body}" if prefix and isinstance(body, str) else body
        content = zstd(text) if compress and isinstance(text, str) else text
        if seq is None:
            self.seq += 1
            seq = self.seq
        server_id = self.server_id + seq + (shard * 100_000) if server_id is None else server_id
        with connect(self.shards[shard]) as conn:
            conn.execute(f"""CREATE TABLE IF NOT EXISTS {table} (local_id INTEGER PRIMARY KEY AUTOINCREMENT,
                server_id INTEGER, local_type INTEGER, sort_seq INTEGER, real_sender_id INTEGER, create_time INTEGER,
                status INTEGER, source BLOB, message_content TEXT, compress_content BLOB, packed_info_data BLOB)""")
            conn.execute("INSERT OR IGNORE INTO Name2Id (user_name) VALUES (?)", (sender,))
            sender_row = conn.execute("SELECT rowid FROM Name2Id WHERE user_name = ?", (sender,)).fetchone()[0]
            cursor = conn.execute(
                f"INSERT INTO {table} (server_id, local_type, sort_seq, real_sender_id, create_time, status, source, message_content) "
                "VALUES (?, ?, ?, ?, ?, 2, ?, ?)",
                (server_id, local_type, seq, sender_row, 1_792_600_000 + seq, source, content))
            local_id = cursor.lastrowid
        return str(server_id) if server_id else f"message_{shard}.db:{local_id}"

    def quote(self, chat, sender, reply, quoted_id, quoted_sender, quoted_name, quoted_text, **kw):
        xml = (f"<msg><appmsg appid=\"\" sdkver=\"0\"><title>{reply}</title><type>57</type>"
               f"<refermsg><type>1</type><svrid>{quoted_id}</svrid><fromusr>{chat}</fromusr>"
               f"<chatusr>{quoted_sender}</chatusr><displayname>{quoted_name}</displayname>"
               f"<content>{quoted_text}</content></refermsg></appmsg></msg>")
        return self.add(chat, sender, xml, local_type=QUOTE_TYPE, compress=True, **kw)

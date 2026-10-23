"""Exact group membership and message metadata; never infer @ from body text."""
import re
import xml.etree.ElementTree as ET

USER_ID = re.compile(r"[A-Za-z0-9_-]{1,128}\Z")
GROUP_ID = re.compile(r"[A-Za-z0-9_-]{1,128}@chatroom\Z")


def is_group(config):
    return config.get("conversationType", "direct") == "group"


def group_members(db, target, bot):
    conn = db._contact_conn()
    if conn is None:
        raise RuntimeError("group_contacts_unavailable")
    try:
        rooms = conn.execute("SELECT id FROM chat_room WHERE username=?", (target,)).fetchall()
        if len(rooms) != 1:
            raise RuntimeError("group_identity_missing")
        rows = conn.execute(
            "SELECT c.username,c.nick_name,c.remark FROM chatroom_member m "
            "JOIN contact c ON c.id=m.member_id WHERE m.room_id=?", (rooms[0][0],),
        ).fetchall()
    finally:
        conn.close()
    members = {}
    for username, nickname, remark in rows:
        if not isinstance(username, str) or not USER_ID.fullmatch(username) or username in members:
            raise RuntimeError("group_member_identity_invalid")
        members[username] = remark or nickname or username
    if bot not in members:
        raise RuntimeError("bot_group_membership_missing")
    return members


def mentions(source):
    if source is None or source == b"" or source == "":
        return []
    if isinstance(source, bytes):
        if source.startswith(b"\x28\xb5\x2f\xfd"):
            import zstandard
            with zstandard.ZstdDecompressor().stream_reader(source) as reader:
                source = reader.read(200001)
        source = source.decode("utf-8")
    if not isinstance(source, str) or len(source) > 200000 or "<!DOCTYPE" in source.upper():
        raise RuntimeError("group_source_invalid")
    root = ET.fromstring(source)
    if root.tag != "msgsource":
        raise RuntimeError("group_source_root_invalid")
    values = root.findall("atuserlist")
    if len(values) > 1:
        raise RuntimeError("group_mentions_ambiguous")
    return [part.strip() for part in (values[0].text or "").split(",") if part.strip()] if values else []


def group_rows(db, rows, target, bot):
    members = group_members(db, target, bot)
    output = []
    for row in rows:
        if row.get("type") == "系统消息":
            continue
        sender = row.get("sender_username")
        if sender not in members:
            raise RuntimeError("group_sender_not_current_member")
        text = row.get("content")
        if not isinstance(text, str):
            raise RuntimeError("group_content_invalid")
        prefix = sender + ":\n"
        if text.startswith(prefix):
            text = text[len(prefix):]
        detail = db.get_message_row(target, row["local_id"], shard=row["shard"])
        if not isinstance(detail, dict) or detail.get("sender_username") != sender or detail.get("sort_seq") != row["sort_seq"]:
            raise RuntimeError("group_message_identity_changed")
        output.append({**row, "content": text, "sender_name": members[sender],
                       "is_group_member": True, "mentioned_bot": bot in mentions(detail["source"])})
    return output

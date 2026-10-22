"""Group nicknames (群昵称) from chat_room.ext_buffer.

ext_buffer holds a protobuf ChatRoomData message:
    message ChatRoomData { repeated Member members = 1; ... }
    message Member { string user_name = 1; string display_name = 2; int32 state = 3; ... }
This is the layout open-source WeChat 4.x readers use (and that 3.x used for
ChatRoom.RoomData); it has not been checked against a real 4.x database here.
The decoder is deliberately forgiving: unknown fields are skipped, and anything
it cannot read yields fewer nicknames, never an error.
"""
from __future__ import annotations


def _varint(data: bytes, pos: int) -> tuple[int, int]:
    value = shift = 0
    while True:
        if pos >= len(data) or shift > 63:
            raise ValueError("truncated varint")
        byte = data[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, pos
        shift += 7


def _fields(data: bytes):
    """Yields (field number, wire type, value) of one protobuf message."""
    pos = 0
    while pos < len(data):
        key, pos = _varint(data, pos)
        field, wire = key >> 3, key & 7
        if wire == 0:
            value, pos = _varint(data, pos)
        elif wire == 1:
            value, pos = data[pos:pos + 8], pos + 8
        elif wire == 2:
            length, pos = _varint(data, pos)
            if pos + length > len(data):
                raise ValueError("truncated field")
            value, pos = data[pos:pos + length], pos + length
        elif wire == 5:
            value, pos = data[pos:pos + 4], pos + 4
        else:
            raise ValueError(f"unsupported wire type {wire}")
        yield field, wire, value


def group_nicknames(ext_buffer: bytes | None) -> dict[str, str]:
    """wxid → group nickname, for members who set one."""
    result: dict[str, str] = {}
    if not ext_buffer:
        return result
    try:
        for field, wire, value in _fields(bytes(ext_buffer)):
            if field != 1 or wire != 2:
                continue
            wxid = nickname = ""
            try:
                for f, w, v in _fields(value):
                    if w != 2:
                        continue
                    if f == 1:
                        wxid = v.decode("utf-8", "replace")
                    elif f == 2:
                        nickname = v.decode("utf-8", "replace")
            except ValueError:
                continue
            if wxid and nickname.strip():
                result[wxid] = nickname.strip()
    except ValueError:
        pass  # keep what was read before the damage
    return result

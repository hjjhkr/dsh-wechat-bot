"""Decoding of WeChat 4.x message columns: bytes/zstd bodies, msgsource and appmsg XML."""
from __future__ import annotations

import re
import xml.etree.ElementTree as ET

import zstandard

ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
MAX_TEXT = 200_000
# Group messages are stored as "<sender wxid>:\n<body>".
SENDER_PREFIX = re.compile(r"^([A-Za-z0-9_@.-]{1,128}):\n")

# local_type → protocol kind. 4.x packs a sub type into the high 32 bits (e.g. 57<<32|49 = quote).
KINDS = {1: "text", 3: "image", 34: "voice", 43: "video", 47: "sticker", 48: "other", 49: "link",
         50: "other", 10000: "system", 10002: "system", 11000: "sticker"}
APPMSG_QUOTE = 57


def split_type(local_type: int) -> tuple[int, int]:
    """(base type, sub type) of a possibly packed local_type."""
    if local_type is None:
        return 0, 0
    if local_type > 0xFFFFFFFF:
        return local_type & 0xFFFFFFFF, local_type >> 32
    return local_type, 0


def decode(value) -> str:
    """Text of a TEXT/BLOB column that may be zstd-compressed."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    data = bytes(value)
    if data.startswith(ZSTD_MAGIC):
        try:
            data = zstandard.ZstdDecompressor().decompress(data, max_output_size=MAX_TEXT)
        except zstandard.ZstdError:
            return ""
    return data.decode("utf-8", "replace").strip("\x00")


def strip_sender(text: str) -> tuple[str | None, str]:
    """Split the "wxid:\\n" prefix of a group message body."""
    match = SENDER_PREFIX.match(text)
    if not match:
        return None, text
    return match.group(1), text[match.end():]


def _xml(text: str):
    start = text.find("<")
    if start < 0:
        return None
    try:
        return ET.fromstring(text[start:])
    except ET.ParseError:
        return None


def mentions(source) -> list[str]:
    """wxids @-mentioned in a message, from <msgsource><atuserlist>; "notify@all" → "all"."""
    root = _xml(decode(source))
    if root is None:
        return []
    node = root.find("atuserlist") if root.tag == "msgsource" else root.find(".//atuserlist")
    if node is None or not node.text:
        return []
    ids = []
    for part in node.text.split(","):
        part = part.strip()
        if part:
            ids.append("all" if part == "notify@all" else part)
    return list(dict.fromkeys(ids))


def appmsg(text: str) -> dict | None:
    """Fields of an <appmsg> (links, files, quotes). Quotes carry a `quote` dict."""
    root = _xml(text)
    if root is None:
        return None
    node = root if root.tag == "appmsg" else root.find(".//appmsg")
    if node is None:
        return None
    result = {"type": int(node.findtext("type") or 0), "title": (node.findtext("title") or "").strip(),
              "description": (node.findtext("des") or "").strip()}
    refer = node.find("refermsg")
    if refer is not None:
        quoted = (refer.findtext("content") or "").strip()
        # A quoted group message keeps its own "wxid:\n" prefix.
        _, quoted = strip_sender(quoted)
        result["quote"] = {
            "messageId": (refer.findtext("svrid") or "").strip() or None,
            "senderId": (refer.findtext("chatusr") or refer.findtext("fromusr") or "").strip() or None,
            "senderName": (refer.findtext("displayname") or "").strip() or None,
            "text": quoted if not quoted.startswith("<") else "[非文字消息]",
        }
    return result


def emoji(text: str) -> dict:
    """md5 / description of a sticker (<emoji md5=… desc=…>)."""
    root = _xml(text)
    node = None if root is None else (root if root.tag == "emoji" else root.find(".//emoji"))
    if node is None:
        return {}
    return {key: node.get(key) for key in ("md5", "desc", "cdnurl") if node.get(key)}

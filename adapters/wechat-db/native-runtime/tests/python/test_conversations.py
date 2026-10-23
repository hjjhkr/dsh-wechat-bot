import hashlib
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
from dsh_wechat_bridge.conversations import catalog
from dsh_wechat_bridge.diagnostics import safe_focus_diagnostic


class Conn:
    def __init__(self, rows):
        self.rows, self.closed = rows, False
    def execute(self, query):
        if "SELECT username,nick_name,remark" not in query and "sqlite_master" not in query:
            raise AssertionError("conversation picker must not read message content")
        return self
    def fetchall(self):
        return self.rows
    def __iter__(self):
        return iter(self.rows)
    def close(self):
        self.closed = True


class CatalogTests(unittest.TestCase):
    def test_existing_conversations_only_and_all_connections_closed(self):
        contacts = Conn([("bot", "初号机", ""), ("friend", "朋友", "备注"),
                         ("123@chatroom", "群", ""), ("unseen", "路人", ""), ("newsapp", "新闻", "")])
        messages = Conn([("Msg_" + hashlib.md5(x.encode()).hexdigest(),) for x in ("friend", "123@chatroom", "newsapp")])
        class DB:
            def _message_dbs(self): return ["message_0.db"]
            def _open(self, rel): return messages
            def _contact_conn(self): return contacts
        rows = catalog(DB(), "bot")
        self.assertEqual(rows, [{"id": "friend", "name": "备注", "type": "direct"},
                                {"id": "123@chatroom", "name": "群", "type": "group"}])
        self.assertTrue(contacts.closed and messages.closed)

    def test_missing_contacts_fails_loudly(self):
        class DB:
            def _message_dbs(self): return []
            def _contact_conn(self): return None
        with self.assertRaisesRegex(RuntimeError, "conversation_contacts_unavailable"):
            catalog(DB(), "bot")

    def test_focus_diagnostic_keeps_counts_and_fixed_reasons_not_arbitrary_data(self):
        value = {"safe": False, "monitorFailed": True, "defaultDesktop": True, "samples": 10,
                 "zeroForegrounds": 0, "unknownOwners": 1, "botForegrounds": 0, "botFocusEvents": 0,
                 "errors": [], "failureReasons": ["sample_owner_unavailable"], "chatText": "private"}
        checked = safe_focus_diagnostic(value)
        self.assertNotIn("chatText", checked)
        self.assertEqual(checked["failureReasons"], ["sample_owner_unavailable"])
        self.assertIsNone(safe_focus_diagnostic({**value, "errors": ["secret with spaces"]}))

import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "python"))
from dsh_wechat_bridge.group import mentions, group_rows
from dsh_wechat_bridge.runtime import normalize_poll_rows, match_outgoing_row


class Result:
    def __init__(self, rows):
        self.rows = rows
    def fetchall(self):
        return self.rows


class Connection:
    def execute(self, sql, params):
        if "FROM chat_room " in sql:
            return Result([(7,)])
        return Result([("bot", "bot", ""), ("alice", "Alice", ""), ("bob", "Bob", "")])
    def close(self):
        pass


class Db:
    def _contact_conn(self):
        return Connection()
    def get_message_row(self, target, local_id, shard):
        return {"sender_username": "alice", "sort_seq": 10, "source": "<msgsource><atuserlist>bot</atuserlist></msgsource>"}


class GroupTests(unittest.TestCase):
    def row(self, **kwargs):
        return {"sender_username": "alice", "content": "alice:\nhello", "type": "文本",
                "local_id": 1, "sort_seq": 10, "create_time": 1, "shard": "s", **kwargs}

    def test_compressed_real_at_metadata_and_missing_at(self):
        import zstandard
        xml = "<msgsource><atuserlist><![CDATA[bot,other]]></atuserlist></msgsource>"
        self.assertEqual(mentions(zstandard.ZstdCompressor().compress(xml.encode())), ["bot", "other"])
        self.assertEqual(mentions("<msgsource/>"), [])
        with self.assertRaises(Exception):
            mentions(b"\x28\xb5\x2f\xfdinvalid")
        with self.assertRaises(Exception):
            mentions("<!DOCTYPE msgsource><msgsource/>")

    def test_member_prefix_removed_but_identity_kept(self):
        mapped = group_rows(Db(), [self.row()], "123@chatroom", "bot")
        wire = normalize_poll_rows(mapped, "bot", "123@chatroom", True)
        self.assertEqual(wire[0]["text"], "hello")
        self.assertEqual(wire[0]["senderId"], "alice")
        self.assertTrue(wire[0]["mentionedBot"])
        self.assertTrue(wire[0]["isGroupMember"])
        self.assertEqual(wire[0]["senderName"], "Alice")

    def test_unknown_member_rejected_system_notification_not_a_user(self):
        with self.assertRaisesRegex(RuntimeError, "not_current_member"):
            group_rows(Db(), [self.row(sender_username="outsider")], "123@chatroom", "bot")
        self.assertEqual(group_rows(Db(), [self.row(type="系统消息", sender_username="")], "123@chatroom", "bot"), [])

    def test_group_body_prefix_matches_only_the_expected_bot(self):
        class Outgoing:
            content = "bot:\nhello"
            def get_new_messages(self, *args, **kwargs):
                return [{"sender_username": "bot", "content": self.content, "sort_seq": 11,
                         "create_time": 100, "local_id": 1, "shard": "s"}]
            def get_message_row(self, *args, **kwargs):
                return {"server_id": 987}
        db = Outgoing()
        self.assertIsNotNone(match_outgoing_row(db, "123@chatroom", "bot", "hello", 10, 100))
        self.assertIsNone(match_outgoing_row(db, "alice", "bot", "hello", 10, 100))
        db.content = "other:\nhello"
        self.assertIsNone(match_outgoing_row(db, "123@chatroom", "bot", "hello", 10, 100))

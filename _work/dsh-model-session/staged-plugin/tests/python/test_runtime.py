import sys
import unittest
from pathlib import Path
from unittest.mock import patch

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PLUGIN_ROOT / "python"))

from dsh_wechat_bridge.runtime import RuntimeScopeError, WindowsRuntime, match_outgoing_row, normalize_poll_rows  # noqa: E402


BOT = "wxid_REDACTED_ACCOUNT"
TARGET = "wxid_REDACTED_ACCOUNT"


class RuntimeScopeTests(unittest.TestCase):
    def test_poll_rows_are_mapped_and_reject_unknown_sender(self):
        rows = [{
            "shard": "message__message_0.db", "local_id": 8, "sort_seq": 10,
            "sender_username": TARGET, "content": "hello", "create_time": 1792476000,
        }]
        result = normalize_poll_rows(rows, BOT, TARGET)
        self.assertEqual(result[0]["senderId"], TARGET)
        self.assertFalse(result[0]["isSelf"])
        with self.assertRaises(RuntimeScopeError):
            normalize_poll_rows([{**rows[0], "sender_username": "someone-else"}], BOT, TARGET)

    def test_outgoing_confirmation_requires_unique_exact_row_and_server_id(self):
        class FakeDb:
            rows = [{
                "shard": "message__message_0.db", "local_id": 8, "sort_seq": 10,
                "sender_username": BOT, "content": "hello", "create_time": 1792476000,
            }]

            def get_new_messages(self, *_args, **_kwargs):
                return self.rows

            def get_message_row(self, *_args, **_kwargs):
                return {"server_id": 501, "shard": "message__message_0.db"}

        db = FakeDb()
        match = match_outgoing_row(db, TARGET, BOT, "hello", 9, 1792475999)
        self.assertEqual(match["serverId"], "501")
        db.get_message_row = lambda *_args, **_kwargs: {"server_id": 9007199254740993, "shard": "message__message_0.db"}
        large_match = match_outgoing_row(db, TARGET, BOT, "hello", 9, 1792475999)
        self.assertEqual(large_match["serverId"], "9007199254740993")
        self.assertIs(type(large_match["serverId"]), str)
        db.rows = [*db.rows, {**db.rows[0], "local_id": 9, "sort_seq": 11}]
        self.assertIsNone(match_outgoing_row(db, TARGET, BOT, "hello", 9, 1792475999))

    def test_send_accepts_external_foreground_change_when_bot_focus_stays_clear(self):
        class FakeDb:
            def get_messages(self, *_args, **_kwargs):
                return [{"sort_seq": 10}]

        class FakeSender:
            def send(self, *_args):
                return {
                    "noBotFocusObserved": True,
                    "foregroundUnchanged": False,
                    "sendAttempted": True,
                    "monitorErrors": [],
                }, {"gateActive": False, "gateRestored": True}

        config = {"botWxid": BOT, "targetWxid": TARGET, "targetName": "USER_OWNER"}
        runtime = WindowsRuntime()
        runtime._binding = {"pid": 42}
        runtime._db = FakeDb()
        runtime._config = config
        runtime.verify = lambda *_args: None
        outgoing = {
            "target": TARGET, "senderId": BOT, "text": "hello", "serverId": "123",
            "localId": 8, "shard": "message__message_0.db", "sortSeq": 11,
        }
        with patch("dsh_wechat_bridge.runtime.make_gate", return_value=object()), patch(
            "dsh_wechat_bridge.runtime.BackgroundUISender", return_value=FakeSender()
        ), patch("dsh_wechat_bridge.runtime.match_outgoing_row", return_value=outgoing):
            result = runtime.send(config, {"selfId": BOT}, {
                "enableSend": True, "allowTemporaryGate": True, "target": TARGET,
                "expectedSelfId": BOT, "text": "hello",
            })

        self.assertEqual(result["status"], "confirmed")
        self.assertIs(result["sendAttempted"], True)

    def test_send_still_rejects_any_bot_focus_observation(self):
        class FakeDb:
            def get_messages(self, *_args, **_kwargs):
                return [{"sort_seq": 10}]

        class FakeSender:
            def send(self, *_args):
                return {
                    "noBotFocusObserved": False,
                    "foregroundUnchanged": False,
                    "sendAttempted": True,
                    "monitorErrors": [],
                }, {"gateActive": False, "gateRestored": True}

        config = {"botWxid": BOT, "targetWxid": TARGET, "targetName": "USER_OWNER"}
        runtime = WindowsRuntime()
        runtime._binding = {"pid": 42}
        runtime._db = FakeDb()
        runtime._config = config
        runtime.verify = lambda *_args: None
        with patch("dsh_wechat_bridge.runtime.make_gate", return_value=object()), patch(
            "dsh_wechat_bridge.runtime.BackgroundUISender", return_value=FakeSender()
        ):
            result = runtime.send(config, {"selfId": BOT}, {
                "enableSend": True, "allowTemporaryGate": True, "target": TARGET,
                "expectedSelfId": BOT, "text": "hello",
            })

        self.assertEqual(result["status"], "ambiguous")
        self.assertEqual(result["reasonCode"], "targeted_return")
        self.assertIs(result["sendAttempted"], True)

    def test_invalid_pre_send_cursor_is_reported_as_db_verify_without_gate(self):
        class FakeDb:
            def get_messages(self, *_args, **_kwargs):
                return [{"sort_seq": "not-an-integer"}]

        config = {"botWxid": BOT, "targetWxid": TARGET, "targetName": "USER_OWNER"}
        runtime = WindowsRuntime()
        runtime._binding = {"pid": 42}
        runtime._db = FakeDb()
        runtime._config = config
        runtime.verify = lambda *_args: None
        with patch("dsh_wechat_bridge.runtime.make_gate") as make_gate:
            result = runtime.send(config, {"selfId": BOT}, {
                "enableSend": True, "allowTemporaryGate": True, "target": TARGET,
                "expectedSelfId": BOT, "text": "hello",
            })

        self.assertEqual(result["status"], "ambiguous")
        self.assertEqual(result["reasonCode"], "db_verify")
        self.assertIs(result["sendAttempted"], False)
        make_gate.assert_not_called()


if __name__ == "__main__":
    unittest.main()

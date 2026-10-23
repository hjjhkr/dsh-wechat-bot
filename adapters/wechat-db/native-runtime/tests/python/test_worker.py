import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PLUGIN_ROOT / "python"))

from dsh_wechat_bridge.worker import Worker  # noqa: E402


BOT = "wxid_synthetic_bot"
TARGET = "wxid_synthetic_friend"


class FakeRuntime:
    def __init__(self):
        self.send_calls = 0
        self.verify_calls = 0
        self.closed = 0
        self.send_error = None
        self.send_result = None

    def probe(self, config):
        return {
            "selfId": config["botWxid"],
            "targetId": config["targetWxid"],
            "binding": {
                "pid": 1234,
                "processStartedAt": 100.0,
                "hwnd": 5678,
                "version": config["expectedVersion"],
            },
        }

    def verify(self, config, session):
        self.verify_calls += 1

    def baseline(self, config, session):
        return {"selfId": BOT, "targetId": TARGET, "cursor": {"sortSeq": 10}}

    def poll(self, config, session, cursor, overlap_seq, max_items):
        return {
            "messages": [
                {
                    "bot": BOT,
                    "target": TARGET,
                    "shard": "message__message_0.db",
                    "local_id": 21,
                    "sort_seq": 12,
                    "senderId": TARGET,
                    "text": "ping",
                    "timestamp": 1792476000,
                    "isSelf": False,
                }
            ],
            "nextCursor": {"sortSeq": 12},
            "complete": True,
        }

    def send(self, config, session, params):
        self.send_calls += 1
        if self.send_error:
            raise self.send_error
        return self.send_result

    def close(self):
        self.closed += 1
        return {"closed": True, "gateActive": False, "gateRestored": True}


class WorkerContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        self.config = {
            "dbRoot": str(root / "accounts"),
            "stateRoot": str(root / "state"),
            "keyCacheFile": str(root / "state" / "db-keys" / "bot.json"),
            "botWxid": BOT,
            "botName": "初号机",
            "targetWxid": TARGET,
            "targetName": "浪味仙^",
            "expectedExe": str(root / "Weixin.exe"),
            "expectedVersion": "4.1.15.13",
            "mainWindowClass": "Qt51514QWindowIcon",
            "mainWindowTitle": "微信",
            "gateTimeoutSeconds": 30,
            "gateModule": str(root / "Weixin.dll"),
            "gateRva": "0x1234",
            "gateExpectedOriginalByte": 0,
            "gateEnabledByte": 1,
        }
        self.runtime = FakeRuntime()
        self.worker = Worker(runtime=self.runtime)

    def tearDown(self):
        self.temp.cleanup()

    def request(self, method, **params):
        return self.worker.handle({"id": "test", "method": method, "params": params})

    def probe(self):
        return self.request("probe", config=self.config)

    def send_params(self, **overrides):
        params = {
            "config": self.config,
            "attemptId": "attempt-001",
            "hostAttemptPersisted": True,
            "target": TARGET,
            "text": "hello",
            "expectedSelfId": BOT,
            "enableSend": True,
            "allowTemporaryGate": True,
        }
        params.update(overrides)
        return params

    def test_probe_then_baseline_and_poll_are_scoped_to_configured_direct_chat(self):
        self.assertIn("result", self.probe())
        baseline = self.request("baseline", config=self.config)
        self.assertEqual(baseline["result"], {
            "selfId": BOT,
            "targetId": TARGET,
            "cursor": {"sortSeq": 10},
        })
        polled = self.request(
            "poll",
            config=self.config,
            cursor={"sortSeq": 10},
            overlapSeq=1,
            maxItems=250,
        )
        self.assertEqual(polled["result"]["messages"][0]["target"], TARGET)
        self.assertEqual(polled["result"]["messages"][0]["senderId"], TARGET)
        self.assertEqual(polled["result"]["nextCursor"], {"sortSeq": 12})
        self.assertTrue(polled["result"]["complete"])
        self.assertGreaterEqual(self.runtime.verify_calls, 2)

    def test_poll_rejects_message_outside_bot_and_target_allowlist(self):
        self.probe()
        original = self.runtime.poll

        def outside_scope(config, session, cursor, overlap_seq, max_items):
            result = original(config, session, cursor, overlap_seq, max_items)
            result["messages"][0]["target"] = "some-other-chat"
            return result

        self.runtime.poll = outside_scope
        result = self.request(
            "poll", config=self.config, cursor={"sortSeq": 10}, overlapSeq=1, maxItems=250
        )
        self.assertEqual(result["error"]["code"], "scope_violation")

    def test_poll_preserves_strict_desktop_availability(self):
        self.probe()
        original = self.runtime.poll
        for value in (False, True, "false"):
            self.runtime.poll = lambda *args, value=value: {**original(*args), "desktopAvailable": value}
            result = self.request("poll", config=self.config, cursor={"sortSeq": 10})
            if type(value) is bool:
                self.assertIs(result["result"]["desktopAvailable"], value)
            else:
                self.assertEqual(result["error"]["code"], "invalid_runtime_result")

    def test_only_certain_unavailable_send_is_retryable_after_unlock(self):
        self.probe()
        blocked = {"status": "blocked", "reasonCode": "desktop_unavailable",
                   "sendAttempted": False, "gateActive": False, "gateRestored": True}
        self.runtime.send_result = blocked
        result = self.request("send", **self.send_params())["result"]
        self.assertEqual(result, blocked)
        self.runtime.send_result = {**blocked, "sendAttempted": None}
        result = self.request("send", **self.send_params())["result"]
        self.assertEqual(result["status"], "ambiguous")
        self.assertEqual(self.runtime.send_calls, 2)
        self.runtime.send_result = blocked
        result = self.request("send", **self.send_params(attemptId="another"))["result"]
        self.assertEqual(result["status"], "ambiguous")
        self.assertEqual(self.runtime.send_calls, 2)

    def test_config_cannot_change_after_binding_without_a_new_probe(self):
        self.probe()
        changed = {**self.config, "targetWxid": "another-chat"}
        result = self.request("baseline", config=changed)
        self.assertEqual(result["error"]["code"], "config_changed")

    def test_numeric_gate_rva_matches_host_runtime_schema(self):
        self.config["gateRva"] = 185818168
        result = self.probe()
        self.assertIn("result", result)

    def test_send_requires_host_marker_and_both_opt_in_flags_before_runtime(self):
        self.probe()
        for overrides, expected in (
            ({"allowTemporaryGate": False}, "send_disabled"),
            ({"hostAttemptPersisted": False}, "attempt_marker_required"),
        ):
            result = self.request("send", **self.send_params(**overrides))
            self.assertEqual(result["error"]["code"], expected)
        self.assertEqual(self.runtime.send_calls, 0)

    def test_only_a_matching_outgoing_row_with_server_id_is_confirmed(self):
        self.probe()
        self.runtime.send_result = {
            "status": "confirmed",
            "sendAttempted": True,
            "gateActive": False,
            "gateRestored": True,
            "outgoing": {
                "target": TARGET,
                "senderId": BOT,
                "text": "hello",
                "serverId": "9007199254740993",
                "localId": 22,
                "shard": "message__message_0.db",
                "sortSeq": 13,
            },
        }
        result = self.request("send", **self.send_params())
        self.assertEqual(result["result"]["status"], "confirmed")
        self.assertEqual(result["result"]["outgoing"]["serverId"], "9007199254740993")
        self.assertIs(result["result"]["gateActive"], False)
        self.assertIs(result["result"]["gateRestored"], True)
        self.assertIs(result["result"]["sendAttempted"], True)

        self.runtime.send_result = {
            "status": "confirmed",
            "sendAttempted": True,
            "gateActive": False,
            "gateRestored": True,
            "outgoing": {
                "target": TARGET,
                "senderId": BOT,
                "text": "hello",
                "serverId": None,
                "localId": 22,
                "shard": "message__message_0.db",
                "sortSeq": 13,
            },
        }
        self.runtime.send_error = None
        self.worker = Worker(runtime=self.runtime)
        self.probe()
        rejected = self.request("send", **self.send_params(attemptId="attempt-002"))
        self.assertEqual(rejected["result"]["status"], "ambiguous")
        self.assertIs(rejected["result"]["gateActive"], False)
        self.assertIs(rejected["result"]["gateRestored"], True)
        self.assertEqual(rejected["result"]["reasonCode"], "db_verify")
        self.assertIs(rejected["result"]["sendAttempted"], True)

    def test_send_preserves_only_allowlisted_diagnostics_without_raw_reason(self):
        self.probe()
        self.runtime.send_result = {
            "status": "ambiguous",
            "reasonCode": "uia_draft",
            "sendAttempted": False,
            "reason": "do not expose path, key, or message content",
            "gateActive": False,
            "gateRestored": True,
        }
        result = self.request("send", **self.send_params())["result"]
        self.assertEqual(result["reasonCode"], "uia_draft")
        self.assertIs(result["sendAttempted"], False)
        self.assertNotIn("reason", result)

    def test_untrusted_send_diagnostic_is_replaced_with_send_unknown(self):
        self.probe()
        self.runtime.send_result = {
            "status": "ambiguous",
            "reasonCode": "E:\\private\\secret.json",
            "sendAttempted": False,
            "gateActive": False,
            "gateRestored": True,
        }
        result = self.request("send", **self.send_params())["result"]
        self.assertEqual(result["reasonCode"], "send_unknown")
        self.assertIs(result["sendAttempted"], False)

    def test_numeric_server_id_is_rejected_to_prevent_json_precision_loss(self):
        self.probe()
        self.runtime.send_result = {
            "status": "confirmed",
            "gateActive": False,
            "gateRestored": True,
            "outgoing": {
                "target": TARGET,
                "senderId": BOT,
                "text": "hello",
                "serverId": 9007199254740993,
                "localId": 22,
                "shard": "message__message_0.db",
                "sortSeq": 13,
            },
        }
        result = self.request("send", **self.send_params())
        self.assertEqual(result["result"]["status"], "ambiguous")
        self.assertIs(result["result"]["gateActive"], False)
        self.assertIs(result["result"]["gateRestored"], True)

    def test_outgoing_match_without_verified_gate_restore_is_ambiguous(self):
        self.probe()
        self.runtime.send_result = {
            "status": "confirmed",
            "gateActive": True,
            "gateRestored": False,
            "outgoing": {
                "target": TARGET,
                "senderId": BOT,
                "text": "hello",
                "serverId": "99123",
                "localId": 22,
                "shard": "message__message_0.db",
                "sortSeq": 13,
            },
        }
        result = self.request("send", **self.send_params())
        self.assertEqual(result["result"]["status"], "ambiguous")
        self.assertIsNot(result["result"]["gateActive"], False)
        self.assertFalse(result["result"]["gateRestored"])

    def test_send_exception_latches_ambiguous_and_never_replays(self):
        self.probe()
        self.runtime.send_error = RuntimeError("injected send failure")
        first = self.request("send", **self.send_params())
        second = self.request("send", **self.send_params(attemptId="attempt-002"))
        self.assertEqual(first["result"]["status"], "ambiguous")
        self.assertEqual(second["result"]["status"], "ambiguous")
        self.assertEqual(first["result"]["reasonCode"], "send_unknown")
        self.assertIsNone(first["result"]["sendAttempted"])
        self.assertEqual(self.runtime.send_calls, 1)

    def test_close_is_idempotent_and_releases_runtime_once(self):
        self.probe()
        expected = {"closed": True, "gateActive": False, "gateRestored": True}
        self.assertEqual(self.request("close")["result"], expected)
        self.assertEqual(self.request("close")["result"], expected)
        self.assertEqual(self.runtime.closed, 1)


if __name__ == "__main__":
    unittest.main()

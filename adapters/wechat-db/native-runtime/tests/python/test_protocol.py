import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
WORKER = PLUGIN_ROOT / "python" / "worker.py"


class JsonlProtocolTests(unittest.TestCase):
    def test_unknown_method_and_malformed_line_each_return_one_json_record(self):
        requests = (
            json.dumps({"id": "probe-1", "method": "not-a-method", "params": {}})
            + "\n"
            + "{not-json}\n"
        )
        completed = subprocess.run(
            [sys.executable, str(WORKER)],
            input=requests,
            text=True,
            capture_output=True,
            timeout=5,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        lines = completed.stdout.splitlines()
        self.assertEqual(len(lines), 2, completed.stdout)
        replies = [json.loads(line) for line in lines]
        self.assertEqual(replies[0]["id"], "probe-1")
        self.assertEqual(replies[0]["error"]["code"], "unknown_method")
        self.assertIsNone(replies[1]["id"])
        self.assertEqual(replies[1]["error"]["code"], "invalid_json")
        self.assertEqual(completed.stderr, "")

    def test_send_is_denied_by_default_and_session_methods_require_probe(self):
        requests = (
            json.dumps({"id": "send-1", "method": "send", "params": {}})
            + "\n"
            + json.dumps({"id": "baseline-1", "method": "baseline", "params": {}})
            + "\n"
            + json.dumps({"id": "close-1", "method": "close", "params": {}})
            + "\n"
        )
        completed = subprocess.run(
            [sys.executable, str(WORKER)],
            input=requests,
            text=True,
            capture_output=True,
            timeout=5,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )

        self.assertEqual(completed.returncode, 0, completed.stderr)
        replies = [json.loads(line) for line in completed.stdout.splitlines()]
        self.assertEqual(len(replies), 3)
        self.assertEqual(replies[0]["error"]["code"], "send_disabled")
        self.assertEqual(replies[1]["error"]["code"], "not_probed")
        self.assertEqual(replies[2]["result"], {
            "closed": True, "gateActive": False, "gateRestored": True,
        })


if __name__ == "__main__":
    unittest.main()

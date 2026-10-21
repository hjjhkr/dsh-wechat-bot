import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PLUGIN_ROOT / "python"))

from dsh_wechat_bridge.gate import GateError, ProcessWatchdog, ensure_no_unresolved_leases, restore_original_byte, watchdog_recover  # noqa: E402


LEASE = {
    "pid": 17,
    "startedAt": 123.0,
    "exePath": r"C:\Weixin\Weixin.exe",
    "modulePath": r"C:\Weixin\Weixin.dll",
    "moduleBase": 4096,
    "moduleSize": 8192,
    "rva": 1024,
    "originalByte": 0,
    "enabledByte": 1,
}


class FakeMemory:
    def __init__(self, value=1, identity_ok=True):
        self.value = value
        self.identity_ok = identity_ok
        self.writes = []

    def verify_identity(self, lease):
        if not self.identity_ok:
            raise GateError("bound process identity changed")

    def read_byte(self, lease):
        return self.value

    def write_byte(self, lease, value):
        self.writes.append(value)
        self.value = value


class GateRestoreTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == "win32", "Windows console launch contract")
    def test_watchdog_no_window_flag_is_not_cancelled_by_detached_process(self):
        with patch("dsh_wechat_bridge.gate.subprocess.Popen") as popen:
            ProcessWatchdog(Path("test-lease.json")).start()
        flags = popen.call_args.kwargs["creationflags"]
        self.assertTrue(flags & 0x08000000)
        self.assertFalse(flags & 0x00000008, "DETACHED_PROCESS makes CREATE_NO_WINDOW ineffective")
        self.assertTrue(flags & 0x00000200)

    def test_unresolved_prior_lease_blocks_a_new_gate_and_verified_lease_is_cleaned(self):
        with tempfile.TemporaryDirectory() as temporary:
            lease_dir = Path(temporary) / "gate-leases"
            lease_dir.mkdir()
            lease = lease_dir / "prior.json"
            lease.write_text('{"pid":17}', encoding="utf-8")
            with self.assertRaises(GateError):
                ensure_no_unresolved_leases(temporary)
            lease.with_suffix(".status.json").write_text(
                '{"gateActive":false,"gateRestored":true}', encoding="utf-8"
            )

            ensure_no_unresolved_leases(temporary)

            self.assertFalse(lease.exists())
            self.assertFalse(lease.with_suffix(".status.json").exists())

    def test_restores_only_the_expected_enabled_byte_and_reads_it_back(self):
        memory = FakeMemory(value=1)

        result = restore_original_byte(memory, LEASE)

        self.assertEqual(result, {"gateActive": False, "gateRestored": True})
        self.assertEqual(memory.writes, [0])
        self.assertEqual(memory.value, 0)

    def test_already_restored_byte_is_idempotent_without_a_write(self):
        memory = FakeMemory(value=0)

        result = restore_original_byte(memory, LEASE)

        self.assertEqual(result, {"gateActive": False, "gateRestored": True})
        self.assertEqual(memory.writes, [])

    def test_unknown_byte_or_changed_process_identity_fails_without_writing(self):
        for memory in (FakeMemory(value=7), FakeMemory(value=1, identity_ok=False)):
            with self.subTest(memory=memory):
                with self.assertRaises(GateError):
                    restore_original_byte(memory, LEASE)
                self.assertEqual(memory.writes, [])

    def test_watchdog_waits_when_byte_is_original_until_stop_or_deadline(self):
        memory = FakeMemory(value=0)
        ticks = iter((1.0, 2.0, 3.0, 4.0))
        sleeps = []

        def now():
            return next(ticks)

        def stop():
            return len(sleeps) >= 2

        state = watchdog_recover(memory, LEASE | {"deadlineEpoch": 10.0}, stop, now, sleeps.append)

        self.assertEqual(state, {"gateActive": False, "gateRestored": True})
        self.assertEqual(sleeps, [0.05, 0.05])
        self.assertEqual(memory.writes, [])

    def test_watchdog_restores_enabled_byte_on_stop(self):
        memory = FakeMemory(value=1)
        sleeps = []
        lease = LEASE | {"deadlineEpoch": 10.0}

        def stop():
            return len(sleeps) >= 1

        state = watchdog_recover(memory, lease, stop, lambda: 1.0, sleeps.append)

        self.assertEqual(state, {"gateActive": False, "gateRestored": True})
        self.assertEqual(memory.writes, [0])


if __name__ == "__main__":
    unittest.main()

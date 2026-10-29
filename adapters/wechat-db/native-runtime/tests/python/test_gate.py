import sys
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PLUGIN_ROOT / "python"))

from dsh_wechat_bridge.gate import (  # noqa: E402
    GateError,
    GateExecutionError,
    ProcessWatchdog,
    TemporaryByteGate,
    ensure_no_unresolved_leases,
    restore_original_byte,
    watchdog_recover,
)


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
        self.close_count = 0

    def verify_identity(self, lease):
        if not self.identity_ok:
            raise GateError("bound process identity changed")

    def read_byte(self, lease):
        return self.value

    def write_byte(self, lease, value):
        self.writes.append(value)
        self.value = value

    def close(self):
        self.close_count += 1


class FakeWatchdog:
    def __init__(self):
        self.process = object()
        self.started = False
        self.stop_requested = False
        self.exited = False

    def start(self):
        self.started = True

    def wait_ready(self, timeout):
        return True

    def request_stop(self):
        self.stop_requested = True

    def wait_exit(self, timeout):
        self.exited = True
        return True

    def status(self):
        return {"gateActive": False, "gateRestored": True}


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


class TemporaryByteGateTests(unittest.TestCase):
    def _make_gate(self, state_root, memory):
        watchdogs = []

        def watchdog_factory(_path):
            watchdog = FakeWatchdog()
            watchdogs.append(watchdog)
            return watchdog

        gate = TemporaryByteGate(
            LEASE | {"timeoutSeconds": 6},
            state_root,
            memory_factory=lambda _lease: memory,
            watchdog_factory=watchdog_factory,
        )
        return gate, watchdogs

    def test_already_enabled_byte_is_borrowed_without_creating_a_restore_lease(self):
        with tempfile.TemporaryDirectory() as temporary:
            memory = FakeMemory(value=1)
            gate, watchdogs = self._make_gate(temporary, memory)
            actions = []

            def action(assert_active):
                assert_active()
                actions.append("ran")
                assert_active()
                return "completed"

            result, state = gate.run(action)

            self.assertEqual((result, state), ("completed", {"gateActive": False, "gateRestored": True}))
            self.assertEqual(actions, ["ran"])
            self.assertEqual(memory.value, 1)
            self.assertEqual(memory.writes, [])
            self.assertEqual(memory.close_count, 1)
            self.assertEqual(watchdogs, [])
            self.assertFalse((Path(temporary) / "gate-leases").exists())
            self.assertIsNone(gate.lease_path)
            self.assertIsNone(gate.memory)

    def test_borrowed_action_cannot_reenter_run_and_outer_gate_closes_once(self):
        with tempfile.TemporaryDirectory() as temporary:
            memory = FakeMemory(value=1)
            gate, watchdogs = self._make_gate(temporary, memory)

            def action(assert_active):
                with self.assertRaises(GateError):
                    gate.run(lambda _assert_active: self.fail("nested action must not run"))
                assert_active()
                return "completed"

            result, state = gate.run(action)

            self.assertEqual((result, state), ("completed", {"gateActive": False, "gateRestored": True}))
            self.assertEqual(memory.value, 1)
            self.assertEqual(memory.writes, [])
            self.assertEqual(memory.close_count, 1)
            self.assertEqual(watchdogs, [])

    def test_borrowed_enabled_byte_stays_enabled_when_action_raises(self):
        with tempfile.TemporaryDirectory() as temporary:
            memory = FakeMemory(value=1)
            gate, watchdogs = self._make_gate(temporary, memory)

            def action(assert_active):
                assert_active()
                raise ValueError("action failed")

            with self.assertRaises(GateExecutionError) as caught:
                gate.run(action)

            self.assertEqual(caught.exception.state, {"gateActive": False, "gateRestored": True})
            self.assertEqual(memory.value, 1)
            self.assertEqual(memory.writes, [])
            self.assertEqual(memory.close_count, 1)
            self.assertEqual(watchdogs, [])
            self.assertFalse((Path(temporary) / "gate-leases").exists())

    def test_borrowed_action_error_keeps_its_reason_and_send_attempted_value(self):
        with tempfile.TemporaryDirectory() as temporary:
            memory = FakeMemory(value=1)
            gate, _watchdogs = self._make_gate(temporary, memory)
            failure = RuntimeError("send outcome is uncertain")
            failure.reason_code = "send_unknown"
            failure.send_attempted = True

            def action(assert_active):
                assert_active()
                raise failure

            with self.assertRaises(GateExecutionError) as caught:
                gate.run(action)

            self.assertEqual(caught.exception.reason_code, "send_unknown")
            self.assertTrue(caught.exception.send_attempted)
            self.assertEqual(caught.exception.state, {"gateActive": False, "gateRestored": True})
            self.assertEqual(memory.value, 1)
            self.assertEqual(memory.writes, [])
            self.assertEqual(memory.close_count, 1)

    def test_borrowed_gate_assert_rejects_a_changed_byte_without_rewriting_it(self):
        with tempfile.TemporaryDirectory() as temporary:
            memory = FakeMemory(value=1)
            gate, watchdogs = self._make_gate(temporary, memory)

            def action(assert_active):
                memory.value = 7
                assert_active()

            with self.assertRaises(GateExecutionError) as caught:
                gate.run(action)

            self.assertEqual(caught.exception.state, {"gateActive": False, "gateRestored": True})
            self.assertEqual(memory.value, 7)
            self.assertEqual(memory.writes, [])
            self.assertEqual(memory.close_count, 1)
            self.assertEqual(watchdogs, [])

    def test_borrowed_gate_assert_rejects_identity_drift_without_rewriting(self):
        with tempfile.TemporaryDirectory() as temporary:
            memory = FakeMemory(value=1)
            gate, watchdogs = self._make_gate(temporary, memory)

            def action(assert_active):
                memory.identity_ok = False
                assert_active()

            with self.assertRaises(GateExecutionError) as caught:
                gate.run(action)

            self.assertEqual(caught.exception.state, {"gateActive": False, "gateRestored": True})
            self.assertEqual(memory.value, 1)
            self.assertEqual(memory.writes, [])
            self.assertEqual(memory.close_count, 1)
            self.assertEqual(watchdogs, [])

    def test_unknown_initial_byte_fails_without_starting_a_watchdog_or_writing(self):
        with tempfile.TemporaryDirectory() as temporary:
            memory = FakeMemory(value=7)
            gate, watchdogs = self._make_gate(temporary, memory)

            with self.assertRaises(GateExecutionError) as caught:
                gate.run(lambda _assert_active: self.fail("action must not run"))

            self.assertEqual(caught.exception.state, {"gateActive": False, "gateRestored": True})
            self.assertEqual(memory.value, 7)
            self.assertEqual(memory.writes, [])
            self.assertEqual(memory.close_count, 1)
            self.assertEqual(watchdogs, [])
            self.assertFalse((Path(temporary) / "gate-leases").exists())

    def test_original_byte_still_uses_watchdog_and_restores_the_temporary_enable(self):
        with tempfile.TemporaryDirectory() as temporary:
            memory = FakeMemory(value=0)
            gate, watchdogs = self._make_gate(temporary, memory)

            result, state = gate.run(lambda assert_active: (assert_active(), "completed")[1])

            self.assertEqual((result, state), ("completed", {"gateActive": False, "gateRestored": True}))
            self.assertEqual(memory.value, 0)
            self.assertEqual(memory.writes, [1, 0])
            self.assertEqual(memory.close_count, 1)
            self.assertEqual(len(watchdogs), 1)
            self.assertTrue(watchdogs[0].started)
            self.assertTrue(watchdogs[0].stop_requested)
            self.assertTrue(watchdogs[0].exited)
            self.assertFalse(list((Path(temporary) / "gate-leases").glob("*.json")))

    def test_original_byte_is_restored_when_action_raises(self):
        with tempfile.TemporaryDirectory() as temporary:
            memory = FakeMemory(value=0)
            gate, watchdogs = self._make_gate(temporary, memory)

            def action(assert_active):
                assert_active()
                raise ValueError("action failed")

            with self.assertRaises(GateExecutionError) as caught:
                gate.run(action)

            self.assertEqual(caught.exception.state, {"gateActive": False, "gateRestored": True})
            self.assertEqual(memory.value, 0)
            self.assertEqual(memory.writes, [1, 0])
            self.assertEqual(memory.close_count, 1)
            self.assertEqual(len(watchdogs), 1)
            self.assertTrue(watchdogs[0].stop_requested)
            self.assertFalse(list((Path(temporary) / "gate-leases").glob("*.json")))

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

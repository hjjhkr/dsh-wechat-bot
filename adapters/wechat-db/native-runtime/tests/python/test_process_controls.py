import sys
import unittest
from pathlib import Path
from types import ModuleType
from unittest.mock import Mock, patch

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PLUGIN_ROOT / "python"))

from dsh_wechat_bridge.desktop import DesktopChild, ForceCloseError  # noqa: E402
from dsh_wechat_bridge.isolated import IsolatedRuntime  # noqa: E402
from dsh_wechat_bridge.worker import Worker  # noqa: E402


SAFE_CLOSE = {"closed": True, "gateActive": False, "gateRestored": True}


def make_child(*, reply=SAFE_CLOSE, waits):
    child = DesktopChild.__new__(DesktopChild)
    child.process = Mock()
    child.job = Mock()
    child.stdin = Mock()
    child.stdout = Mock()
    child.stderr = Mock()
    child.streams = [child.stdin, child.stdout, child.stderr]
    child.reader = Mock()
    child.drainer = Mock()
    child.pid = 12345
    child._close_ack = None
    child._close_started = False
    child._stdin_closed = False
    child._resources_closed = False
    child.request = Mock(return_value=reply)
    child._wait_for_tree_exit = Mock(side_effect=waits)
    return child


def make_win32event():
    event_api = ModuleType("win32event")
    event_api.WAIT_OBJECT_0 = 0
    event_api.WAIT_TIMEOUT = 258
    event_api.WaitForSingleObject = Mock(return_value=event_api.WAIT_TIMEOUT)
    return event_api


class DesktopChildControlTests(unittest.TestCase):
    def test_job_member_handles_are_reopened_on_pid_reuse_and_reaped_after_exit(self):
        child = DesktopChild.__new__(DesktopChild)
        child.job = Mock()
        child.pid = 11
        root = Mock()
        reused = Mock()
        exited = Mock()
        replacement = Mock()
        child.process = root
        child._member_processes = {11: root, 22: reused, 33: exited}

        job_api = ModuleType("win32job")
        job_api.JobObjectBasicAccountingInformation = 1
        job_api.JobObjectBasicProcessIdList = 3
        job_api.QueryInformationJobObject = Mock(
            side_effect=lambda _job, kind: (11, 22) if kind == 3 else {"ActiveProcesses": 2}
        )
        job_api.IsProcessInJob = Mock(return_value=True)
        api = ModuleType("win32api")
        api.OpenProcess = Mock(return_value=replacement)
        constants = ModuleType("win32con")
        constants.PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        constants.SYNCHRONIZE = 0x100000
        event = make_win32event()
        event.WaitForSingleObject.side_effect = lambda handle, _timeout: (
            event.WAIT_TIMEOUT if handle is root else event.WAIT_OBJECT_0
        )

        with patch.dict(
            sys.modules,
            {"win32job": job_api, "win32api": api, "win32con": constants, "win32event": event},
        ):
            pids = child._capture_job_members()

        self.assertEqual(pids, {11, 22})
        self.assertIs(child._member_processes[22], replacement)
        self.assertNotIn(33, child._member_processes)
        reused.Close.assert_called_once_with()
        exited.Close.assert_called_once_with()
        api.OpenProcess.assert_called_once_with(0x101000, False, 22)

    def test_job_membership_change_during_snapshot_is_not_reported_as_verified(self):
        child = DesktopChild.__new__(DesktopChild)
        child.job = Mock()
        child.pid = 11
        child.process = Mock()
        child._member_processes = {11: child.process}
        pid_snapshots = iter(((11,), (11, 22)))
        job_api = ModuleType("win32job")
        job_api.JobObjectBasicAccountingInformation = 1
        job_api.JobObjectBasicProcessIdList = 3
        job_api.QueryInformationJobObject = Mock(
            side_effect=lambda _job, kind: next(pid_snapshots) if kind == 3 else {"ActiveProcesses": 1}
        )
        job_api.IsProcessInJob = Mock(return_value=True)
        constants = ModuleType("win32con")
        constants.PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        constants.SYNCHRONIZE = 0x100000
        event = make_win32event()
        event.WaitForSingleObject.return_value = event.WAIT_TIMEOUT

        with patch.dict(
            sys.modules,
            {"win32api": ModuleType("win32api"), "win32con": constants, "win32event": event, "win32job": job_api},
        ):
            with self.assertRaisesRegex(RuntimeError, "changed during verification"):
                child._capture_job_members()

    def test_force_terminates_only_after_verified_close_ack_and_exit_timeout(self):
        child = make_child(waits=[False, False, True])
        job = child.job
        child._member_processes = {child.pid: child.process}
        child._capture_job_members = Mock(return_value={child.pid})
        job_api = ModuleType("win32job")
        job_api.JobObjectBasicAccountingInformation = 1
        job_api.TerminateJobObject = Mock()
        job_api.QueryInformationJobObject = Mock(return_value={"ActiveProcesses": 1})
        event_api = make_win32event()

        with patch.dict(sys.modules, {"win32job": job_api, "win32event": event_api}):
            with self.assertRaisesRegex(RuntimeError, "exit unconfirmed"):
                child.close()
            self.assertEqual(child._close_ack, SAFE_CLOSE)
            self.assertEqual(child.stdin.close.call_count, 1)

            result = child.force_close()

        self.assertEqual(result, SAFE_CLOSE)
        job_api.TerminateJobObject.assert_called_once_with(job, 1)
        child.request.assert_called_once_with("close", {}, timeout=30)

    def test_force_cannot_terminate_without_verified_gate_restoration_ack(self):
        child = make_child(
            reply={"closed": True, "gateActive": False, "gateRestored": False},
            waits=[False],
        )
        job_api = ModuleType("win32job")
        job_api.TerminateJobObject = Mock()
        event_api = make_win32event()

        with patch.dict(sys.modules, {"win32job": job_api, "win32event": event_api}):
            with self.assertRaisesRegex(RuntimeError, "exit unconfirmed"):
                child.close()
            self.assertTrue(callable(getattr(child, "force_close", None)))
            with self.assertRaisesRegex(RuntimeError, "acknowledgement"):
                child.force_close()

        job_api.TerminateJobObject.assert_not_called()
        self.assertIsNone(child._close_ack)

    def test_repeated_close_after_timeout_waits_without_rewriting_closed_stdin(self):
        child = make_child(waits=[False, False])

        with patch.dict(sys.modules, {"win32event": make_win32event()}):
            with self.assertRaisesRegex(RuntimeError, "exit unconfirmed"):
                child.close()
            with self.assertRaisesRegex(RuntimeError, "exit unconfirmed"):
                child.close()

        child.request.assert_called_once_with("close", {}, timeout=30)
        child.stdin.close.assert_called_once_with()
        child.stdin.write.assert_not_called()


class RuntimeAndWorkerControlTests(unittest.TestCase):
    def test_isolated_runtime_force_closes_acknowledged_child_and_removes_leases(self):
        lease = Mock()
        child = Mock()
        child.close.side_effect = RuntimeError("exit unconfirmed")
        child.force_close.return_value = SAFE_CLOSE
        runtime = IsolatedRuntime()
        runtime.child = child
        runtime.leases = [lease]

        with self.assertRaisesRegex(RuntimeError, "exit unconfirmed"):
            runtime.close()
        self.assertTrue(callable(getattr(runtime, "force_close", None)))
        result = runtime.force_close()

        self.assertEqual(result, SAFE_CLOSE)
        child.force_close.assert_called_once_with()
        lease.remove.assert_called_once_with()
        self.assertIsNone(runtime.child)
        self.assertEqual(runtime.leases, [])
        self.assertEqual(runtime.close_result, SAFE_CLOSE)

    def test_lease_cleanup_failure_keeps_acknowledged_child_force_retryable(self):
        lease = Mock()
        lease.remove.side_effect = [OSError("first remove failed"), None]
        child = Mock()
        child.close.return_value = SAFE_CLOSE
        child.force_close.return_value = SAFE_CLOSE
        runtime = IsolatedRuntime()
        runtime.child = child
        runtime.leases = [lease]

        with self.assertRaisesRegex(OSError, "first remove failed"):
            runtime.close()
        self.assertTrue(runtime._close_failed)
        result = runtime.force_close()

        self.assertEqual(result, SAFE_CLOSE)
        child.force_close.assert_called_once_with()
        self.assertEqual(lease.remove.call_count, 2)
        self.assertIsNone(runtime.child)

    def test_force_close_without_user_confirmation_never_calls_runtime(self):
        runtime = Mock()
        worker = Worker(runtime=runtime)

        result = worker.handle({"method": "force_close", "params": {"confirmedForce": False}})

        self.assertEqual(result["error"]["code"], "force_stop_confirmation_required")
        runtime.force_close.assert_not_called()

    def test_worker_requires_failed_normal_close_before_force_and_reports_unavailable(self):
        runtime = Mock()
        runtime.close.side_effect = RuntimeError("exit unconfirmed")
        runtime.force_close.return_value = SAFE_CLOSE
        worker = Worker(runtime=runtime)

        refused = worker.handle({"method": "force_close", "params": {"confirmedForce": True}})
        self.assertEqual(refused["error"]["code"], "force_stop_not_ready")
        runtime.force_close.assert_not_called()

        failed_close = worker.handle({"method": "close", "params": {}})
        self.assertEqual(failed_close["error"]["code"], "close_failed")
        result = worker.handle({"method": "force_close", "params": {"confirmedForce": True}})
        self.assertEqual(result, {"result": SAFE_CLOSE})
        self.assertTrue(worker._closed)

        unsupported = Mock(spec=["close"])
        unsupported.close.side_effect = RuntimeError("exit unconfirmed")
        unavailable_worker = Worker(runtime=unsupported)
        unavailable_worker.handle({"method": "close", "params": {}})
        unavailable = unavailable_worker.handle(
            {"method": "force_close", "params": {"confirmedForce": True}}
        )
        self.assertEqual(unavailable["error"]["code"], "force_stop_unavailable")

        unacknowledged = Mock(spec=["close", "force_close"])
        unacknowledged.close.side_effect = RuntimeError("exit unconfirmed")
        unacknowledged.force_close.side_effect = ForceCloseError(
            "force_stop_ack_required", "details must not cross the worker boundary"
        )
        unacknowledged_worker = Worker(runtime=unacknowledged)
        unacknowledged_worker.handle({"method": "close", "params": {}})
        refused_without_ack = unacknowledged_worker.handle(
            {"method": "force_close", "params": {"confirmedForce": True}}
        )
        self.assertEqual(refused_without_ack["error"]["code"], "force_stop_ack_required")
        self.assertEqual(
            refused_without_ack["error"]["message"],
            "verified gate-restored close acknowledgement is required",
        )


if __name__ == "__main__":
    unittest.main()

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PLUGIN_ROOT / "python"))

from dsh_wechat_bridge.process import ProcessBindingError, account_candidates, find_binding, select_main_window, select_process_record  # noqa: E402


BOT = "wxid_synthetic_bot"


class ProcessBindingTests(unittest.TestCase):
    def test_account_discovery_requires_exact_bot_identity(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            correct = root / f"{BOT}_418b" / "db_storage"
            wrong = root / "wxid_another_418b" / "db_storage"
            decoy = root / f"{BOT}_other" / "db_storage"
            for path in (correct, wrong, decoy):
                path.mkdir(parents=True)

            self.assertEqual(account_candidates(root, BOT), [correct.parent])

    def test_process_selection_requires_exe_and_open_file_scope(self):
        expected = Path(r"D:\Weixin\Weixin.exe")
        db = Path(r"D:\WeixinData\wxid_synthetic_bot_418b\db_storage")
        selected = select_process_record([
            {"pid": 10, "exePath": str(expected), "startedAt": 1.0,
             "openFiles": [str(db / "message" / "message_0.db")]},
            {"pid": 11, "exePath": str(expected), "startedAt": 2.0,
             "openFiles": [r"D:\Other\db_storage\contact\contact.db"]},
        ], expected, db)
        self.assertEqual(selected["pid"], 10)

    def test_process_selection_fails_on_missing_or_ambiguous_bindings(self):
        expected = Path(r"D:\Weixin\Weixin.exe")
        db = Path(r"D:\WeixinData\wxid_synthetic_bot_418b\db_storage")
        one = {"pid": 10, "exePath": str(expected), "startedAt": 1.0,
               "openFiles": [str(db / "contact" / "contact.db")]}
        with self.assertRaises(ProcessBindingError):
            select_process_record([], expected, db)
        with self.assertRaises(ProcessBindingError):
            select_process_record([one, {**one, "pid": 12}], expected, db)

    def test_probe_uses_unique_unowned_native_main_window_without_uia_input(self):
        rows = [
            {"hwnd": 100, "pid": 42, "visible": False, "ownerHwnd": 0,
             "captionStyle": True, "toolWindow": False,
             "className": "Qt51514QWindowIcon", "title": "微信"},
            {"hwnd": 101, "pid": 42, "visible": False, "ownerHwnd": 100,
             "captionStyle": True, "toolWindow": False,
             "className": "Qt51514QWindowIcon", "title": "微信"},
            {"hwnd": 102, "pid": 42, "visible": False, "ownerHwnd": 0,
             "captionStyle": True, "toolWindow": False,
             "className": "Qt51514QWindowIcon", "title": "另一个Qt窗口"},
        ]
        selected = select_main_window(rows, 42, "Qt51514QWindowIcon", "微信")
        self.assertEqual(selected["hwnd"], 100)

    def test_native_main_window_selection_fails_when_missing_or_ambiguous(self):
        one = {"hwnd": 100, "pid": 42, "visible": False, "ownerHwnd": 0,
               "captionStyle": True, "toolWindow": False,
               "className": "Qt51514QWindowIcon", "title": "微信"}
        with self.assertRaises(ProcessBindingError):
            select_main_window([], 42, "Qt51514QWindowIcon", "微信")
        with self.assertRaises(ProcessBindingError):
            select_main_window([one, {**one, "hwnd": 101}], 42, "Qt51514QWindowIcon", "微信")

    @unittest.skipUnless(sys.platform == "win32", "native binding is Windows-only")
    def test_find_binding_binds_hidden_window_without_calling_chat_input_uia(self):
        import psutil
        from dsh_wechat_bridge import vendor

        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            exe = root / "Weixin.exe"
            module = root / "Weixin.dll"
            account_db = root / "accounts" / f"{BOT}_418b" / "db_storage"
            exe.touch()
            module.touch()
            account_db.mkdir(parents=True)
            expected_path = str(exe.resolve())
            opened_db = str(account_db / "message" / "message_0.db")

            class FakeProcess:
                info = {"pid": 4242, "exe": expected_path, "create_time": 123.0}

                def exe(self):
                    return expected_path

                def create_time(self):
                    return 123.0

                def open_files(self):
                    return [SimpleNamespace(path=opened_db)]

            class FakeReader:
                def _find_weixin_module(self, pid):
                    self.seen_pid = pid
                    return (0x100000, 0x8000, str(module.resolve()))

            config = {
                "expectedExe": expected_path,
                "expectedVersion": "4.1.15.13",
                "dbRoot": str((root / "accounts").resolve()),
                "botWxid": BOT,
                "gateModule": str(module.resolve()),
                "gateRva": 0x1234,
                "mainWindowClass": "Qt51514QWindowIcon",
                "mainWindowTitle": "微信",
            }
            native_rows = [{
                "hwnd": 777, "pid": 4242, "visible": False, "ownerHwnd": 0,
                "captionStyle": True, "toolWindow": False,
                "className": config["mainWindowClass"], "title": config["mainWindowTitle"],
            }]
            with patch.object(psutil, "process_iter", return_value=[FakeProcess()]), \
                 patch("dsh_wechat_bridge.process._file_version", return_value="4.1.15.13"), \
                 patch("dsh_wechat_bridge.process._window_records", return_value=native_rows), \
                 patch.object(vendor, "load_db_module", return_value=FakeReader()), \
                 patch("dsh_wechat_bridge.process._has_chat_input", side_effect=AssertionError("UIA used during probe"), create=True) as input_probe:
                binding = find_binding(config)

            input_probe.assert_not_called()
            self.assertEqual(binding["hwnd"], 777)
            self.assertEqual(binding["mainWindowClass"], config["mainWindowClass"])
            self.assertEqual(binding["mainWindowTitle"], config["mainWindowTitle"])


if __name__ == "__main__":
    unittest.main()

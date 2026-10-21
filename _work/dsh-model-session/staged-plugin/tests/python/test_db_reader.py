import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PLUGIN_ROOT / "python"))

from dsh_wechat_bridge.db_reader import DbScopeError, load_bot_key_cache, verify_target_contact  # noqa: E402


class DbReaderScopeTests(unittest.TestCase):
    def test_key_cache_is_single_file_scoped_to_required_bot_databases(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "keys.json"
            path.write_text('{"contact/contact.db":"' + "11" * 32 + '","other/db.db":"' + "22" * 32 + '"}', encoding="utf-8")
            keys = load_bot_key_cache(path, ["contact/contact.db"])
            self.assertEqual(set(keys), {"contact/contact.db"})
            self.assertEqual(keys["contact/contact.db"], bytes.fromhex("11" * 32))

    def test_missing_or_malformed_required_key_fails_without_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "keys.json"
            path.write_text('{"contact/contact.db":"bad"}', encoding="utf-8")
            with self.assertRaises(DbScopeError):
                load_bot_key_cache(path, ["contact/contact.db"])
            with self.assertRaises(DbScopeError):
                load_bot_key_cache(path.with_name("missing.json"), ["contact/contact.db"])

    def test_contact_must_match_both_configured_wxid_and_exact_display_name(self):
        class FakeDb:
            rows = [("wxid-target", "USER_OWNER", "")]

            def _contact_conn(self):
                class Conn:
                    def execute(self, _sql, params):
                        return self
                    def fetchall(self):
                        return FakeDb.rows
                    def close(self):
                        pass
                return Conn()

        verify_target_contact(FakeDb(), "wxid-target", "USER_OWNER")
        FakeDb.rows = [("wxid-other", "USER_OWNER", "")]
        with self.assertRaises(DbScopeError):
            verify_target_contact(FakeDb(), "wxid-target", "USER_OWNER")


if __name__ == "__main__":
    unittest.main()

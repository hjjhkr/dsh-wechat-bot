import hashlib
import sys
import tempfile
import unittest
from pathlib import Path

PLUGIN_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(PLUGIN_ROOT / "python"))

from dsh_wechat_bridge.vendor import VendorIntegrityError, verify_vendor_file  # noqa: E402


class VendorIntegrityTests(unittest.TestCase):
    def test_accepts_only_the_expected_sha256(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "db.py"
            path.write_bytes(b"fixed vendor source")
            expected = hashlib.sha256(b"fixed vendor source").hexdigest()

            self.assertEqual(verify_vendor_file(path, expected), expected)

            path.write_bytes(b"changed vendor source")
            with self.assertRaises(VendorIntegrityError):
                verify_vendor_file(path, expected)

    def test_missing_vendor_file_fails_closed(self):
        with tempfile.TemporaryDirectory() as temporary:
            with self.assertRaises(VendorIntegrityError):
                verify_vendor_file(Path(temporary) / "missing.py", "0" * 64)


if __name__ == "__main__":
    unittest.main()

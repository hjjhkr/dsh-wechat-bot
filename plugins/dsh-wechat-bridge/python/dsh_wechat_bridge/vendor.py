"""Integrity-checked loading for the fixed, read-only vendored DB module."""

from __future__ import annotations

import hashlib
import importlib.util
import logging
import sys
import types
from pathlib import Path
from typing import Any


EXPECTED_DB_SHA256 = "9d4eba69e868dea8000d8acdbaed723149cf8732c52e097f23fb3b07fa5ddc55"
EXPECTED_LICENSE_SHA256 = "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4"
_DB_MODULE: Any = None


class VendorIntegrityError(RuntimeError):
    pass


def verify_vendor_file(path: str | Path, expected_sha256: str) -> str:
    """Return the digest only when the exact expected file is present."""
    expected = expected_sha256.lower()
    if len(expected) != 64 or any(ch not in "0123456789abcdef" for ch in expected):
        raise VendorIntegrityError("vendor digest is invalid")
    try:
        digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError as exc:
        raise VendorIntegrityError("vendor file is missing or unreadable") from exc
    if digest != expected:
        raise VendorIntegrityError("vendor file hash does not match the pinned source")
    return digest


def load_db_module() -> Any:
    """Load db.py without importing or depending on the source project's package."""
    global _DB_MODULE
    if _DB_MODULE is not None:
        return _DB_MODULE
    vendor_dir = Path(__file__).resolve().parents[1] / "vendor"
    source = vendor_dir / "db.py"
    verify_vendor_file(source, EXPECTED_DB_SHA256)
    verify_vendor_file(vendor_dir / "LICENSE", EXPECTED_LICENSE_SHA256)

    # db.py has one package logger import. Supply a narrow shim while executing
    # the fixed source, then remove it so it cannot shadow another installation.
    if "wechatauto" in sys.modules or "wechatauto.logger" in sys.modules:
        raise VendorIntegrityError("the upstream package name is already occupied")
    package = types.ModuleType("wechatauto")
    package.__path__ = []
    logger_module = types.ModuleType("wechatauto.logger")
    logger_module.wxlog = logging.getLogger("dsh-wechat-bridge.db")
    sys.modules["wechatauto"] = package
    sys.modules["wechatauto.logger"] = logger_module
    module_name = "dsh_wechat_bridge._vendored_db"
    try:
        spec = importlib.util.spec_from_file_location(module_name, source)
        if spec is None or spec.loader is None:
            raise VendorIntegrityError("vendored DB module cannot be loaded")
        module = importlib.util.module_from_spec(spec)
        sys.modules[module_name] = module
        spec.loader.exec_module(module)
    except Exception as exc:
        raise VendorIntegrityError("vendored DB module failed to load") from exc
    finally:
        sys.modules.pop("wechatauto.logger", None)
        sys.modules.pop("wechatauto", None)
    _DB_MODULE = module
    return module

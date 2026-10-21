Vendored `db.py` and `LICENSE` are copied from the verified `wechat-bot-lab/_work/background-read/source/db.py` snapshot and pinned by runtime SHA-256 checks in `dsh_wechat_bridge/vendor.py`.

The bridge uses only the `WeChatDB` database decryption/query helpers. Its `BotOnlyDB` subclass in `dsh_wechat_bridge/db_reader.py` replaces upstream key loading with one configured bot-only cache and disables memory extraction, cache discovery, account switching, and key-cache writes. Keep this notice and the upstream `LICENSE` with the copied source.

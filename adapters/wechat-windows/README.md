# wechat-windows（旧实现的残留，未改动）

这里是重构前 Windows 微信 4.x 读写代码中保留下来的部分，本次重构**没有修改**它们：

- `vendor/db.py`、`vendor/LICENSE`：第三方的微信 4.x 本地消息库读取模块（保留原许可证）
- `wechat_worker/win32.py`：Win32 调用的 ctypes 绑定（上一次重构尝试留下的起点）
- `requirements.txt`：旧 worker 的 Python 依赖

它们**还不是**一个符合 [适配器协议 v1](../../docs/protocol.md) 的适配器。完整的旧 worker（读库、群成员与 @ 解析、UI 自动化发送、送达确认）在重构前快照里：

```bash
git show 85a9ec3 --stat -- plugins/dsh-wechat-bridge/python
git show 85a9ec3:plugins/dsh-wechat-bridge/python/dsh_wechat_bridge/worker.py
```

实现新适配器的步骤和注意事项见 [docs/handoff.md](../../docs/handoff.md#5-给适配器实现者要做的事)。完成后用一致性检查工具验证：

```bash
node plugins/dsh-wechat-bot/bin/check-adapter.js -- python -u adapters/wechat-windows/adapter.py
```

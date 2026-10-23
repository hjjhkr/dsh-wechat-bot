# Windows 发送运行时源码

此目录迁入旧项目中仍被新版发送链路使用的 Python worker；新版群聊业务只由 `plugins/dsh-wechat-bot` 负责，不加载旧版 JavaScript 插件。目录包含 `python/worker.py`、隔离桌面子进程、`dsh_wechat_bridge` 的账号/窗口/控件门/数据库保护，以及原有 90 项 Python 测试。

`python/vendor/db.py` 保持原始字节与 SHA-256 校验；第三方 Apache-2.0 许可证和来源说明一同保留。迁移时只改测试中的本机账号为虚构标识，源码未改业务行为。新版 `wechat_db/native_binding.py`、`native_window_worker.py`、`native_send.py` 负责独立窗绑定和发送适配。

Windows Python 3.12 x64 安装示例（仓库根执行）：

```powershell
python -m venv .venv
.venv/Scripts/python.exe -m pip install -r adapters/wechat-db/native-runtime/python/requirements.lock.txt
```

`requirements.txt` 是直接依赖，`requirements.lock.txt` 记录本次实际安装的直接及传递依赖。Python、微信、DSH 与虚拟环境二进制不提交；本机需要预先安装对应运行时。解密密钥、账号数据、模型凭据和发送日志均留在用户配置的数据目录。

发送配置的 `command` 指向该环境的 `pythonw.exe`，`args[0]` 指向本仓库 `adapters/wechat-db/native-runtime/python/worker.py`。启用 `detachedWindow:true` 后，新版独立窗 worker 从该源码目录加载所需模块；无需旧项目目录。启用 `desktopControl:true` 可接通插件的显隐接口。

```powershell
python -m pytest adapters/wechat-db/native-runtime/tests/python -q
```

本机验证为 90 passed；单元测试不等同真实微信、锁屏或异常停机恢复验收。

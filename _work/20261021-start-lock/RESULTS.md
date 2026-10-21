# 群监听恢复与隐藏桌面校验修复

2026-10-21 11:09（Asia/Shanghai）。目标实例 <PROJECT_ROOT>，控制台 http://127.0.0.1:5310/wechat-bot/。

## 已恢复的运行行为

- BOT_ACCOUNT重新登录原隐藏桌面，继续监听原 GROUP_TARGET 群；工作微信未操作。
- 按用户明确授权，通过正式 acknowledge API 将旧失败回复 efaef31b-cb7e-4547-9c87-9d376503c075 记为 abandoned，保留 skip_no_retry 审计，不重发。
- 通过正式 start API 恢复现有发送许可下的自动回复。11:08:03 状态：running/autoSendEnabled/sendGrantValid=true，receivedCount=51，deliveredCount=14；无不确定发送、无错误。恢复前 deliveredCount=6，已新增 8 条正常自动回复确认送达。
- 用户选择暂缓锁屏测试。11:08:54 核实测试已自行超时退出，locked-probe.json 为 not_tested/no_lock_observed，测试进程数量 0；没有调用微信发送、全局输入或切换桌面。

## 修改及依据

| 修改位置 | 修改内容与依据 | 验证 |
|---|---|---|
| <PROJECT_ROOT>/plugins/dsh-wechat-bridge/python/dsh_wechat_bridge/desktop.py:77，require_window_desktop | 控制端直接查询隐藏桌面 HWND 实测返回错误 1400；改为打开指定桌面、核对桌面名、枚举精确 HWND，再核对绑定 PID，并关闭桌面句柄。依据同文件桌面绑定契约、isolated.py 的 MonitorLease 调用链，以及 Microsoft EnumDesktopWindows 文档。保持既有窗口归属检查。 | 原生故障诊断及修复后 MonitorLease.safe=true，69 次采样、无小号抢前台、sendCalls=0。 |
| <PROJECT_ROOT>/plugins/dsh-wechat-bridge/tests/python/test_isolated.py:205 | 增加控制端必须枚举指定桌面后才能核验隐藏 HWND 的回归用例，保留错误桌面/PID 拒绝用例。依据上行实际故障。 | 先复现失败，再修复；Python unittest 77/77。 |
| <PROJECT_ROOT>/plugins/dsh-wechat-bridge/README.md:5；package.json:3 | 记录跨桌面修复，源码版本 0.1.12；本次实际部署包为 0.1.12-desktop.1。 | 从已安装 0.1.11 基线制作独立修复包，仅替换 desktop.py，避免混入另一聊天正在修改的 DSH 模型展示代码。 |

Windows 参考：[EnumDesktopWindows](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumdesktopwindows)、[GetWindowThreadProcessId](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-getwindowthreadprocessid)。技能依据：<CODEX_HOME>/skills/dsh-plugin-development/SKILL.md 的 2.1（当前安装取证）、7.1–7.2（正式安装与重启）、8.2/8.4（真实组合与隔离安装）。

## 验证记录与边界

- 插件目录执行 `<PROJECT_ROOT>/python/Scripts/python.exe -B -m unittest discover -s tests/python`：77 项通过。
- 本次独立 release 执行 Node 测试：73 项通过、0 失败，见 release-node-tests.log。共享源码的全量 Node 测试曾遇到另一聊天新加 model-session 测试 fixture 缺少 fallbackMaxWords；本次未改它，不声称该共享源码全套通过。
- 官方 DSH CLI 执行 Scratch 安装与 dump-config，再执行目标 profile 安装与 dump-config；35 个运行文件哈希核验通过，见 install-Scratch-verification.json、install-Deploy-verification.json。
- 已按项目 Stop/Start 脚本正常重启目标 DSH 一次，运行 PID 73824；真实状态 API 与正常群自动回复已验证。打包文件 dsh-wechat-bridge-0.1.12-desktop.1.tgz，SHA256 76DF038E8E0697FEE7833845F5EB5C6D07B8E6BE0B2F2E7237394BE9D34B0456。
- 本次未验证锁屏状态下的真实发送，也未启用该能力；生产仍在锁屏时采集消息、等解锁后发送。只读 WTS 检测与自有窗口测试脚本留存，后续需重新启动测试才会运行。
- 没有提交、推送或发布。任务目录的 isolated-wechat.py 及 keeper 是当前小号运行依赖，不能整体清理；保留相关诊断和安装证据。

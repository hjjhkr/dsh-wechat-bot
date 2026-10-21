# DSH 微信机器人：脱敏源码交接包

此包包含插件源码/离线测试、人设与许可、依赖清单、6组脱敏会话、模型交接说明及待合并 DSH 展示补丁。

- 入口：`handoff/2026-10-21/README.md` 和 `HANDOFF.zh-CN.md`。
- 源码和原机安装快照为 0.1.12-focus.2；这份包没有复制原机运行实例。
- 显隐切换明确留待重构版实现，当前未实现、未部署。
- DSH 原生模型活动展示仍是 `_work/dsh-model-session/` 中的待合并补丁，不要整目录覆盖当前代码。
- `config/wechat-bot.example.json` 是占位模板，autoStart/autoSend 均关闭，发送gate参数已移除。它故意不可直接启动；请在接收方独立环境中核验版本、路径和账号后配置。
- 没有真实配置、凭据、微信数据库、解密缓存、个人长期记忆、运行状态、原始宿主日志、截图、依赖目录、Python虚拟环境或已登录账号。
- 人设中的真实发送者ID已遮盖，机器人部署时需由用户在本机确认主人身份，不能使用占位值。
- Node/DSH版本见 runtime/package.json 与锁文件，Python依赖见插件 python/requirements.txt；安装步骤仍需依据当地官方 DSH CLI/profile契约。
- Start/Stop脚本保留启动方式，工作区已改为合成路径 C:/ExampleWorkspace，使用前需调整。它们不会因解压自动执行。
- 已识别的账号、主人、成员昵称及群名使用稳定别名，本机用户目录也已遮盖。仍保留测试文字和技术背景，这是技术交接包，不是公开匿名语料。
- 本轮只重新导出和脱敏；未在接收方环境安装、运行模型或向微信发送测试消息。历史通过结果及其边界见各RESULTS和交接文档。

`PACKAGE_MANIFEST.json` 记录每个文件的来源、脱敏前来源哈希与包内实际哈希；修改只发生在打包副本。历史补丁manifest和项目快照内的源码哈希是原机依据，包内脱敏后文件以PACKAGE_MANIFEST为准。
`PACKAGE_VERIFICATION.json` 记录检查结果，`CHECKSUMS.sha256` 校验除自身之外的每个文件。

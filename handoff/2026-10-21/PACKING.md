# 打包给接收方时怎么选文件

本目录的会话分享版已进行凭据遮盖和微信 ID 匿名化。**整个 `<PROJECT_ROOT>` 还包含真实凭据与聊天数据，不能直接无筛选压缩。** 本次没有删除、改写或搬走这些运行文件。

用户本轮已要求制作脱敏包。输出在项目 `deliverables/`，内容为可接手开发的源码与交接材料：依赖仅带清单，不带虚拟环境/已登录实例；配置只带关闭自动启动/发送的占位模板。包内 `PACKAGE_MANIFEST.json` 记录逐文件来源、包内哈希及脱敏修改，`PACKAGE_VERIFICATION.json` 记录检查结果。它不是带原机账号数据的开箱运行环境。显隐切换明确标为待重构版实现，当前未实现。

## 接收方只需了解和接手开发

建议交付：

- 本 `handoff/2026-10-21/` 全目录（会话、清单、交接、快照与验证）。
- `plugins/dsh-wechat-bridge/` 的源码、说明、测试、requirements、vendor 许可；排除 `node_modules`、`__pycache__`、日志、私人测试输出和运行 state。
- `Start-DshBot.ps1`、`Stop-DshBot.ps1` 供理解启动方式；绝对工作区路径需接收方调整。
- `personas/` 中确需交付的人设和许可，先审查是否新增了真实用户身份或其他私人内容。
- 待合并功能另带 `_work/dsh-model-session/` 中的 `DELIVERY.md`、`manifest.json`、patch 与 `staged-plugin` 源码/测试；不要直接覆盖共享源码，也不要复制其依赖目录。
- 各近期任务的 `RESULTS.md` 可作为历史证据。`STATE.md` 和安装/运行脚本仅按需要挑选；不要把整个 `_work` 一起放进去。

## 明确排除

| 路径/类别 | 已发现的内容 |
| --- | --- |
| `home/.credentials.yaml`、任何 credentials/auth/token 文件 | 官方模型/provider 凭据 |
| `home/wechat-bot/reader/db-keys/`、reader 解密缓存、微信 DB | 数据库解密密钥和真实聊天内容 |
| `home/` 其余 state、memory、sessions、profiles | 真实私聊/群聊、个人长期记忆、发送许可、会话历史与本机安装数据 |
| `agents-home/`、本机 workspace | 私人 Agent 数据与工作文件；本机脚本另指向项目外 `<DSH_WORKSPACE>`，也不能默认打包 |
| `config/wechat-bot.json` | 真实微信标识、本机路径、窗口/版本/gate 参数；接收方需独立配置，不从原机复制启用 |
| `logs/`，尤其 `dsh.stdout.log` | 已发现带本机认证入口的 URL；整份排除 |
| `_work/**/before*`、backups、`*.private.*`、真实模型/聊天输出、截图、调试 JSON/JSONL | 历史凭据、私聊正文、个人记忆、窗口或账号信息 |
| `.pnpm-store/`、runtime/node_modules、Python 虚拟环境、npm/uv 缓存、安装检查 profile、tgz 旧包 | 体积大、机器相关或带旧配置；开发交接通常按依赖清单重新安装 |

`_work/20261021-start-lock/` 的 isolated-wechat/keeper 等脚本仍可能是本机微信隐藏桌面运行依赖。**从分享包排除，不代表可以删除原机目录。** 此处没有运行任何删除、清理、服务停止或发消息操作。

如果需要移交原机账号、真实记忆或可运行环境，应单独确认范围并通过接收方可控的安全途径配置。历史会话中的发送、重启和界面修改授权不会随文件自动转移。

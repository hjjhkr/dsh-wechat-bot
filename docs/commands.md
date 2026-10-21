# 聊天命令（/ 命令）

群友在微信里发一条以 `/` 开头的消息（也认全角 `／`，前面可以带 @小号），插件会**在消息进入模型之前**拦截处理。
没注册的 `/xxx` 当普通聊天处理，不会误伤"/斜杠表情"之类的内容。

## 内置命令

| 命令 | 作用 | 类型 |
| --- | --- | --- |
| `/help`（`/帮助`） | 列出所有命令 | 直接回复 |
| `/mode [free\|mention\|silent]`（`/模式`） | 查看/切换发言模式。也接受 `at` / `at-only` → mention，`quiet` / `off` → silent | 直接回复 |
| `/mute [分钟]`（`/闭嘴`） | 临时禁言，默认 30 分钟，最长 1440 | 直接回复 |
| `/unmute` | 解除禁言 | 直接回复 |
| `/status`（`/状态`） | 模式、禁言剩余、今日处理批次和发言数、上下文条数、记住了几位成员 | 直接回复 |
| `/memory`（`/记忆`） | 看机器人记住了**你自己**的什么 | 直接回复 |
| `/forget <主题\|all>`（`/忘记`） | 删掉关于你自己的某条或全部记忆 | 直接回复 |
| `/reset` | 清空这个聊天的短期上下文（不动长期记忆） | 直接回复 |
| `/ask <问题>`（`/问`） | 认真回答：**思考强度自动提到 high**，禁言/只回@模式下也会回答 | 转给模型 |
| `/tldr`（`/总结`） | 让机器人用人设口吻总结最近的聊天 | 转给模型 |

所有命令群里每个人都能用。群聊机器人没有"主人"的概念；成员身份（记忆归属、`/memory`、`/forget`）只按数据库里的微信 id 区分，改昵称不会串。

## 发言模式

| 模式 | 行为 |
| --- | --- |
| `free`（默认） | 每批消息都交给模型，由它判断要不要接话；群里冷场时（`idleMinutes` > 0）可以主动说话 |
| `mention` | 只有这批里有消息 `addressed=you`（被 @、被叫名字、被引用、私聊、命令点名）才调用模型；其他消息只作为上下文，**不花 token** |
| `silent` | 不调用模型、不说话；命令照常可用 |

模式和禁言按聊天分别保存，重启后保持。控制台的"自由发言 / 只回@ / 静音"按钮、`wechat_bot` 工具的 `mode` 操作和 `/mode` 命令改的是同一个东西。

## 写自己的命令

在配置里设置 `commandsDir`，目录下每个 `.js`（或 `.mjs`）文件默认导出一个命令，插件启动时加载：

```js
// commands/roll.js
export default {
  name: 'roll',                  // /roll
  aliases: ['骰子'],             // /骰子
  usage: '/roll [面数]',
  summary: '掷骰子',
  run({ args }) {
    const sides = Number(args[0] ?? 6)
    return `${Math.ceil(Math.random() * sides)}`
  },
}
```

`run(call)` 收到的 `call`：

| 字段 | 说明 |
| --- | --- |
| `name` / `text` / `args` | 命令名、原始参数文本、按空白切开的参数 |
| `sender` / `message` / `chat` | 谁发的、原始消息、当前聊天 |
| `mode` / `setMode(mode)` | 当前模式 / 切换模式 |
| `mute(ms)` | 禁言 `ms` 毫秒，`0` 解除 |
| `memory.recall(id)` / `memory.forget(id, topic?)` | 读 / 删某个成员的记忆 |
| `resetContext()` | 清空短期上下文 |
| `status()` | 运行统计 |
| `commands` | 所有已注册命令（写帮助用） |

返回值决定接下来发生什么：

| 返回 | 效果 |
| --- | --- |
| `string` 或 `{ reply: string }` | 直接发这句话，不经过模型 |
| `{ forward: { instruction, text?, effort? } }` | 把消息（或替换成 `text`）交给模型，附带一条指令；这条消息一定算"在找你"，模型必须回复；`effort` 可临时提高思考强度 |
| `undefined` | 什么也不发 |

转给模型的例子——让机器人用古文复述一句话：

```js
export default {
  name: 'wenyan',
  summary: '把一句话翻成文言文',
  run: ({ text }) => text
    ? { forward: { text, instruction: '对方用 /wenyan 请你把这句话翻成文言文，只输出译文。' } }
    : '/wenyan 后面跟要翻译的话',
}
```

命令抛异常时会回复"/xxx 出错了"并记到控制台日志，不影响机器人继续工作。

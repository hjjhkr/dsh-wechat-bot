# DSH WeChat Bridge

### DSH model activity (0.1.13)

The current WeChat conversation has a native DSH session named `微信模型 · <target>`.
Set the absolute `dshWorkspace` in the local runtime JSON to the workspace where it should appear.
The session shows the actual model request's running status, live output, completion, failure and
cancellation. It observes the existing `llm.stream` call: no extra model call, AgentLoop, workspace
instructions or tools are added. The title is pinned locally without using a title-generation model.
Structured reply/memory output is shown as the model produced it. A completed model turn does not
mean that WeChat delivery succeeded.

The DSH session is a monitor: ordinary composer input is rejected. Its Stop action aborts the same
in-flight model request, so the cancelled result cannot become a sendable reply. Use the WeChat
control page to pause listening. Model diagnostics also appear here; run them while the bridge is
paused to keep one model request active at a time. This release still has one active WeChat target.

DSH uses its native session history to preserve model records across refresh/restart. These records
include the current model input and structured output and are separate from the bridge's 30-minute
inbox/outbox cleanup. They are not replayed into the model: the bridge still constructs its original
bounded history and user memory. Resume only restores the display and closes interrupted turns;
it never repeats a model request or a WeChat send. Existing uncertain-send records and grants are unchanged.

An isolated, host-only plugin for a local DeepSeek Harness web profile. It reads one configured WeChat private or group conversation through the bundled Python worker, generates decisions through `ctx.llm`, and exposes a loopback-only status page. It does not use the desktop profile, workspace instructions, arbitrary agent tools, or a client bundle.

### Cross-desktop window validation (0.1.12)

The Default controller opens a temporary read-only handle and enumerates the configured hidden
desktop before querying its bound HWND. Windows otherwise returns error 1400 for
that foreign-desktop window, even while the isolated worker validates it successfully.
The PID and actual thread desktop still must match; the handle is closed on success
and failure. This never switches desktops or relaxes the lock-screen send guard.

### Conversation picker and focus diagnostics (0.1.10)

The assistant page has a searchable conversation dialog. Its catalog joins the bot's contact metadata
with existing message table names; it does not read other conversation bodies or invoke a model.
Selecting a new conversation requires explicit confirmation, pauses the old listener, verifies a
unique visible session on the hidden desktop, and saves the selected target. Drafts are preserved:
an existing draft, duplicate display name, missing visible session, uncertain send, or failed focus/gate
check stops the switch. No global mouse, keyboard, clipboard or desktop switching is used.

The selected conversation starts paused and its sending grant is cleared. Start it through the normal
page controls. `conversationStateRoots` preserves existing state roots by account ID; newly selected
conversations get a stable hashed subdirectory under `conversationStateBaseRoot`. The model, persona,
reader and bot account stay unchanged. This is one active conversation, not concurrent multi-chat.

Sending retains its strict focus checks. Each result now carries bounded diagnostic counts and fixed
failure identifiers through the worker and host; no chat text or window title is included. Failure still
pauses and never resends automatically. A failed focus check alone does not establish focus theft.

### Group conversation and model decisions (0.1.8)

One explicit group can replace the private-chat target using `worker.conversationType: "group"`,
`targetWxid: "<id>@chatroom"`, the exact `targetName`, `groupReplyPolicy: "model"`, and
`proactiveEnabled: true` (or false). Group mode requires `memoryEnabled: true` for the decision JSON contract.
Keep a separate `stateRoot` for the group so its queue, cursor and memories do not mix with a private chat.
The existing bot reader/key cache may be reused only while the previous worker is stopped.
Install `python/requirements.txt` in the dedicated Python environment; zstandard 0.25.0 is required for
compressed group text and real @ metadata. The pinned vendor file is unchanged.

All new member messages in this group are batched, including messages without @ or prefixes.
Since 0.1.9, each decision receives the configured account identity in `self` and the worker's
verified `mentionedBot` flag on new messages. This lets the model associate its WeChat display
name with its persona; mentions do not force a reply. Existing records without the flag remain
unknown, and prior silent decisions are not replayed as new messages.
The model chooses one reply or explicit `{"reply":null,"memory":[]}` silence. Silence still commits
evidence-backed memory and consumes no send attempt. Each fact belongs to the actual sender of its cited
message, not to a model-supplied identity. Group memory is keyed by bot + group + member and published under
`memory/<bot>/groups/<group>/<member>.json`; private memory is never loaded as group context.
System notifications and the bot's own messages do not trigger replies. Invalid member/source data fails visibly.

With proactive mode and valid send consent, 30 minutes without a new member message triggers one model
decision about whether to say something. Another quiet check is scheduled 30 minutes later. New messages
reset the quiet timer; if one arrives while an idle decision is generating, the stale proactive reply is
discarded and the new messages are handled normally. Empty 2-second polls do not invoke the model.
Idle decisions cannot update member memory without new evidence. Proactive sends use the same durable
attempt marker, focus lease and unique outgoing confirmation as reactive sends.

The UI reports the group policy and next quiet-check time. Pause stops both message and idle decisions.
Changing the group, decision policy or proactive permission invalidates the old scoped sending grant.
Group mode still requires the exact target selected on the hidden desktop; it is not multi-chat navigation.

## Safe defaults

- `autoStart` and `autoSend` should both be `false` for the first run.
- The initial baseline skips old chat history. New messages are persisted before drafting and deduplicated by bot, target, shard, local message id, and sort sequence.
- The page at `/wechat-bot/` is available only through the local web host. Start opens read-only polling and draft generation. The target chat must remain selected in the desktop WeChat window; switching chats and lock-screen operation are unsupported.
- Sending requires the page's two explicit checkboxes: persistent auto-send and temporary gate consent. The resulting grant is fsync-persisted as a hash scoped to the bot, recipient, executable/version, exact main-window class/title, `Weixin.dll`, and gate values. Closing the page or a graceful DSH restart does not revoke it. A scope change invalidates the grant and leaves the worker stopped. Each attempt is persisted before the worker is called. An uncertain result is marked ambiguous and blocks all further starts; it is never automatically retried.
- A send is accepted only when the worker confirms the exact target, bot sender, body, unique positive decimal server-id string, `gateActive: false`, and `gateRestored: true`. Pause waits for the in-flight operation and worker close; it reports an error unless the worker confirms both gate fields and exits.
- The “test model” action calls DeepSeek using the configured persona and reasoning off. It returns the reply to this local page and does not write inbox/outbox state or send to WeChat.

## Runtime configuration

### Batched replies, user memory, and retention (0.1.4)

- `batchQuietMs: 2000`, `batchMaxWaitMs: 8000`: poll while a burst is arriving and close the batch after 2 seconds without a new unique message, or 8 seconds total. Poll/RPC scheduling can add latency. Each batch is bounded by `batchMaxMessages: 20` and `batchMaxChars: 8000`. Excess messages remain pending for the next batch; a single oversized message pauses with an explicit error.
- The model receives an ordered JSON `messages` list with ids and timestamps. Each batch generates one reply and has one send attempt covering all member keys. Messages arriving during generation are fetched for the next batch. Ambiguous batches are never automatically retried.
- `memoryEnabled: true` enables the same model response to produce both `reply` and a bounded `memory` update. There is still only one model request per batch and none for empty polling. Only `reply` goes to WeChat. Facts must cite an exact quote in a current user message; malformed output, unsupported facts and known sensitive content fail explicitly before sending.
- With memory enabled, delivered assistant history is replayed as `{"reply":"…","memory":[]}` so later turns see the same JSON contract. Historical memory mutations are not replayed; authoritative current facts are supplied separately. Persona brevity and expression rules apply only to the reply string, including when the input is an unreadable sticker placeholder (0.1.7).
- Persistent memory is scoped by bot wxid and user wxid, never display name or DSH session. Sections are `profile`, `preferences`, `ongoing`, `explicit`; ongoing facts expire after 30 days. Up to 48 short facts are retained; a full memory fails visibly instead of silently discarding facts. Users can ask to correct or forget a topic.
- The authoritative memory transaction is in `state.json` together with the drafted batch. A readable snapshot is atomically published at `<stateRoot>/memory/<botWxid>/<userWxid>.json` before sending. Interrupted publication is repaired on restart. These files are owned by the plugin; do not hand-edit a snapshot while running. Chat text and memory are data, not executable instructions.
- `retentionMs: 1800000` keeps new message bodies and reply drafts for 30 minutes, then clears them only after memory publication. Cleanup runs during polling and once per minute while the host remains open, including paused mode; startup also runs it. Pending work and uncertain sends remain intact. Legacy experiment records without a memory receipt are preserved. This does not delete WeChat's own databases/decryption cache or DSH's unrelated sessions.
- Compact overlap tombstones plus a cursor boundary prevent deleted messages from reappearing on a later poll; at most 200 purged outgoing metadata records are retained. Long-term memory is not cleared with short-term content.

The plugin config contains only `configPath`, overridden by the isolated web profile to point at a local JSON file. The JSON contains deployment paths and bot identity, never API credentials. The DeepSeek credential is managed by the new DSH home through its official provider route.

Required top-level fields: `stateRoot`, `personaPath`, `pythonExe`, `provider`, `model`, `maxTokens`, `pollIntervalMs`, `historyTurns`, `autoStart`, `autoSend`, and `worker`. Use `provider: "deepseek-official"`, `model: "deepseek-flash"`, and `maxTokens` from 1 through 512. Paths must be absolute.

Required `worker` fields: `dbRoot`, `stateRoot`, `keyCacheFile`, `botWxid`, `botName`, `targetWxid`, `targetName`, `expectedExe`, `expectedVersion`, `mainWindowClass`, `mainWindowTitle`, and `gateTimeoutSeconds`. For a send-capable deployment, also provide `gateRva`, `gateExpectedOriginalByte`, `gateEnabledByte`, and absolute `gateModule` ending in `Weixin.dll`. Without all four gate fields, the UI remains read-only. The bot, recipient, window identity, module path, executable path, and version must match the actual local account and process.

### Isolated desktop transport (0.1.6)

Optional `worker.desktopName` selects an existing hidden desktop named `DshWeChatBot_<id>`. The bot must already be logged in on that desktop, with the configured private chat selected and its main window open there. Its window does not appear on the normal work desktop. This differs from closing a normal desktop window to the tray, which removes its input controls. The plugin does not switch desktops, use global keyboard/mouse input, or close/relaunch WeChat.

The normal worker stays on `Default`. It launches a private JSONL child on the configured desktop using `STARTUPINFO.lpDesktop`. The child retains account/process validation, the temporary gate watchdog, exact target/empty-draft checks, and unique database delivery proof. It writes the draft through UIA with automatic focus disabled, then computes the send button's live client coordinates and queues one HWND-specific click. It never falls back to a normal-desktop send.

During each send, the normal worker monitors foreground/focus events and publishes a revocable lease valid for at most two seconds. The child checks the lease before drafting and clicking. A stale lease, changed input desktop, dead worker, or unconfirmed result stops the attempt; it is never retried automatically. The controller checks its entire focus history before returning success, even when the child already found delivery proof. The gate still has a maximum 30-second lifetime; isolated send RPC allows 55 seconds for preflight and delivery verification.

The desktop name is part of the persistent sending scope. Configuring or changing it invalidates an old grant and keeps the worker paused until the user explicitly starts the new scope. Pausing or stopping DSH closes only plugin workers and their pipes; the WeChat account remains logged in. The existing desktop session must stay alive separately. The assistant page supports explicit selection of one conversation at a time, with separate state and memory roots. Automatic login/recovery after Windows reboot, concurrent conversations, and slash-command control are not implemented or validated.

### Screen off and locked sessions (0.1.11)

The monitor does not need to stay lit. Display power, Windows lock, system sleep, and a hidden desktop are separate states. This plugin never changes power or security settings and never switches the input desktop. System sleep suspends execution; automatic Windows login is outside the plugin.

For isolated mode, read-only account/window validation checks the controller and target window's actual desktop without requiring access to the input desktop. Each poll reports `desktopAvailable`. While Windows is locked, or the input desktop cannot be verified as `Default`, the host keeps collecting pending messages but waits before generating replies or proactive messages. Send and conversation selection still require an unlocked input desktop and the existing focus lease, exact account, HWND, target, draft, gate, and delivery checks. The page shows this wait explicitly; an ordinary lock no longer closes the worker with `worker_error`.

A lock detected before any child send RPC returns `blocked/desktop_unavailable`, with explicit proof that no send was attempted and no gate was opened. The host leaves a message reply pending and may continue it after unlocking while the original scoped grant remains valid. Explicitly starting or revoking the grant clears this automatic continuation. A blocked proactive message is skipped, preserving the next half-hour check instead of sending a stale greeting after unlocking. Once a child send RPC has begun, an interrupted or uncertain result still stops the bridge and requires manual reconciliation; it is never retried automatically. Pending drafts remain subject to the existing half-hour content retention. These transitions are covered by local mocked tests; actual screen-off/lock/unlock operation still requires controlled on-device validation after deployment.

Focus samples publish the HWND and its resolved process owner together under a lock. Readers take a consistent snapshot: a concurrent owner query cannot be mistaken for a missing half-sample. This does not waive unknown owners, bot focus events, desktop changes, or monitor failures. Send results retain bounded diagnostic counts and reason codes, without window titles or chat text.

The host retains inbox, outbox, cursor, and scoped grant in an atomically replaced `state.json` under `stateRoot`, protected by an exclusive single-instance lock. Only the host-to-Python worker pipe uses JSON Lines. Do not manually edit the state file while the service is running. Python RPC carries the worker configuration object, but does not carry API keys.

## Routes

- `GET /wechat-bot/` — local control page; issues a short-lived same-origin capability cookie.
- `GET /wechat-bot/api/status` — counts and state only; never returns chat text.
- `GET /wechat-bot/api/conversations` — authorized bot conversation metadata and current ID.
- `POST /wechat-bot/api/conversations/select` — `{ "targetId": "...", "currentId": "...", "selectionConfirmed": true }`; explicit hidden-desktop selection, no sends, returns paused.
- `GET /wechat-bot/api/draft` — latest generated draft for the configured private chat.
- `POST /wechat-bot/api/start` — `{ "autoSend": false, "allowTemporaryGate": false }` for read-only mode. Sending requires both values `true` and the page capability.
- `POST /wechat-bot/api/pause` — stop polling and close the worker while retaining the scoped send grant.
- `POST /wechat-bot/api/revoke` — stop polling, close the worker, and clear the scoped send grant.
- `POST /wechat-bot/api/test-model` — one fixed persona test, explicitly not sent to WeChat.
- `POST /wechat-bot/api/acknowledge` — `{ "attemptId": "…", "confirmedNoRetry": true }`; only while stopped with a confirmed closed worker and restored gate, preserve the uncertain attempt as `abandoned`, mark its inbox item `skipped`, and keep the cursor/grant without restarting. The status API exposes only attempt metadata and whitelisted reason codes, never the message body.
- `POST /wechat-bot/api/shutdown` — after same-origin authorization, stop the bridge, confirm worker cleanup and release its lock, then return `{ "success": true, "workerClosed": true, "gateActive": false }`. The official DSH graceful exit is requested after the HTTP response finishes. Restart with `<PROJECT_ROOT>\Start-DshBot.ps1`.

Every route rejects non-loopback hosts and cross-origin mutation. Responses use `no-store`; UI/API errors expose codes rather than worker stderr or credentials.

## Validation

On Windows, configure the worker with the environment's `pythonw.exe`; the JSONL pipe remains the worker protocol. The gate recovery child also explicitly uses `pythonw.exe`. It retains a separate process group and `CREATE_NO_WINDOW`, without the conflicting `DETACHED_PROCESS` flag. The host's `windowsHide: true`, no-shell spawn and redirected stdio are retained.

Run the Node tests with `npm test` from this package directory. Python worker tests live under `tests/python`; run them with the project's Python test command. Installation and static tests do not prove a real WeChat login, polling, model request, message send, or gate recovery; those require separate controlled validation.

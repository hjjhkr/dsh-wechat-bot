// Console for the WeChat bot: a right-sidebar tab in DSH. Plain JS, React from
// the host module table, styled only with host theme tokens.
window.__ModuleLoader__.load({
  id: 'dsh-wechat-bot',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useState } = React
    const h = React.createElement
    const KIND = 'wechat-bot'
    const ID = 'dsh-wechat-bot'

    const api = {
      async get(path) {
        const response = await fetch(path, { cache: 'no-store' })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        return response.json()
      },
      async act(action, args = {}) {
        const response = await fetch('/api/wechat-bot.action', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action, ...args }),
        })
        const body = await response.json()
        if (!body.ok) throw new Error(body.error)
        return body.result
      },
    }

    function usePoll(path, ms, enabled = true) {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      const [tick, setTick] = useState(0)
      useEffect(() => {
        if (!enabled || !path) return
        let alive = true
        const load = () => api.get(path).then(d => { if (alive) { setData(d); setError(null) } }, e => alive && setError(e.message))
        load()
        const timer = setInterval(() => document.visibilityState === 'visible' && load(), ms)
        return () => { alive = false; clearInterval(timer) }
      }, [path, ms, enabled, tick])
      return [data, error, () => setTick(t => t + 1)]
    }

    const CSS = `
.wxb{display:flex;flex-direction:column;gap:12px;padding:12px 14px;height:100%;overflow:auto;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:13px}
.wxb h3{margin:0;font-size:13px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.wxb-card{border:1px solid var(--dsw-alias-border-l3);border-radius:10px;padding:10px 12px;display:flex;flex-direction:column;gap:8px;background:var(--dsw-alias-bg-layer-1)}
.wxb-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.wxb-muted{color:var(--dsw-alias-label-tertiary)}
.wxb-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary)}
.wxb-dot.ok{background:var(--dsw-alias-state-success-primary)}.wxb-dot.warn{background:var(--dsw-alias-state-warn-primary)}.wxb-dot.err{background:var(--dsw-alias-state-error-primary)}
.wxb button{font:inherit;border:1px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:8px;padding:4px 10px;cursor:pointer}
.wxb button:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wxb button.primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground);border-color:transparent}
.wxb button[aria-pressed=true]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}
.wxb button:disabled{opacity:.5;cursor:default}
.wxb input[type=text]{font:inherit;flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l3);border-radius:8px;padding:4px 8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.wxb-list{display:flex;flex-direction:column;max-height:220px;overflow:auto}
.wxb-list label{display:flex;gap:8px;align-items:center;padding:4px 2px;border-radius:6px;cursor:pointer}
.wxb-list label:hover{background:var(--dsw-alias-interactive-bg-hover)}
.wxb-log{display:flex;flex-direction:column;gap:2px;font-size:12px;max-height:420px;overflow:auto}
.wxb-log>div{padding:2px 0;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:pre-wrap;word-break:break-word}
.wxb-log .error,.wxb-log .send_error,.wxb-log .invalid_output{color:var(--dsw-alias-state-error-primary)}
.wxb-log .sent{color:var(--dsw-alias-state-business-primary)}
.wxb-log details{color:var(--dsw-alias-label-tertiary)}
.wxb-sender.warn{border-color:var(--dsw-alias-state-warn-primary)}.wxb-sender.err{border-color:var(--dsw-alias-state-error-primary)}
.wxb-switch{position:relative;width:34px;height:20px;border-radius:10px;border:none!important;padding:0!important;background:var(--dsw-alias-border-l4)!important}
.wxb-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary)!important}
.wxb-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;transition:left .15s}
.wxb-switch[aria-checked=true]::after{left:16px}
.wxb-error{color:var(--dsw-alias-state-error-primary)}
`

    const MODES = [['free', '自由'], ['infer', '推断'], ['at', '只回@'], ['silent', '静音']]
    const CONNECTION = { connected: ['ok', '已连接'], degraded: ['warn', '不稳定'], disconnected: ['err', '未连接'], adapter_down: ['err', '适配器未运行'], starting: ['warn', '启动中'] }
    const SENDER_PREPARATION = {
      sender_preparing: ['warn', '独立微信窗口准备中'],
      sender_prepare_failed: ['err', '独立微信窗口准备失败'],
      sender_recovery_required: ['err', '独立微信窗口恢复待确认'],
    }

    function Status({ state }) {
      const [tone, label] = CONNECTION[state.connection.state] ?? ['warn', state.connection.state]
      const cannotSend = state.connection.state === 'connected' && !state.connection.canSend
      return h('div', { className: 'wxb-card' },
        h('div', { className: 'wxb-row' },
          h('span', { className: `wxb-dot ${cannotSend ? 'warn' : tone}` }),
          h('strong', null, state.account.state === 'ready' ? state.account.self.name : '小号未登录'),
          h('span', { className: 'wxb-muted' }, cannotSend ? `${label}，暂不能发送${state.connection.reason ? `（${state.connection.reason}）` : ''}` : label)),
        h('div', { className: 'wxb-muted' },
          `适配器 ${state.adapter ? `${state.adapter.name} ${state.adapter.version}` : '—'}${state.capabilities?.simulator ? '（模拟器）' : ''} · 模型 ${state.model.model} · 思考 ${state.model.reasoningEffort}`))
    }

    function SenderPreparation({ connection, chat, refresh }) {
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState(null)
      const status = SENDER_PREPARATION[connection.reason]
      if (!status) return null

      const [tone, label] = status
      const canRetry = connection.reason === 'sender_prepare_failed' && Boolean(chat?.id)
      const failed = connection.reason === 'sender_prepare_failed'
      const retry = async () => {
        if (!canRetry || busy) return
        setBusy(true)
        setError(null)
        try {
          await api.act('watch', { chatId: chat.id })
          refresh()
        } catch (e) {
          setError(e.message)
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: `wxb-card wxb-sender ${tone}`, role: failed ? 'alert' : 'status', 'aria-live': failed ? 'assertive' : 'polite' },
        h('div', { className: 'wxb-row' }, h('span', { className: `wxb-dot ${tone}` }), h('strong', null, label)),
        connection.detail && h('div', { className: 'wxb-muted' }, connection.detail),
        canRetry && h('div', { className: 'wxb-row' },
          h('button', { className: 'primary', disabled: busy, onClick: retry }, busy ? '准备中…' : '重新准备')),
        error && h('div', { className: 'wxb-error' }, `重新准备失败：${error}`))
    }

    function Login({ refresh }) {
      const [result, setResult] = useState(null)
      const [busy, setBusy] = useState(false)
      const login = async () => {
        setBusy(true)
        try { setResult(await api.act('login')) } catch (e) { setResult({ instructions: e.message }) } finally { setBusy(false); refresh() }
      }
      return h('div', { className: 'wxb-card' },
        h('h3', null, '登录微信小号'),
        h('div', { className: 'wxb-row' }, h('button', { className: 'primary', disabled: busy, onClick: login }, '开始登录')),
        result?.instructions && h('div', null, result.instructions),
        result?.qrCode && h('img', { src: result.qrCode, alt: '登录二维码', style: { width: 180, alignSelf: 'center' } }))
    }

    function WindowToggle() {
      const [visible, setVisible] = useState(null)
      const [error, setError] = useState(null)
      const [busy, setBusy] = useState(false)
      useEffect(() => {
        let active = true
        const refresh = () => api.act('windowState').then(s => {
          if (active) { setVisible(s.visible); setError(null) }
        }, e => { if (active) setError(e.message) })
        refresh()
        const timer = setInterval(refresh, 2000)
        return () => { active = false; clearInterval(timer) }
      }, [])
      const toggle = async () => {
        setBusy(true)
        try { setVisible((await api.act('window', { visible: !visible })).visible) } catch (e) { setError(e.message) }
        finally { setBusy(false) }
      }
      return h('div', { className: 'wxb-row' },
        h('span', null, '小号微信'),
        h('button', { role: 'switch', 'aria-checked': visible === true, disabled: busy || visible === null, onClick: toggle }, visible ? '返回主桌面' : '显示小号 / 登录'),
        h('span', { className: 'wxb-muted' }, visible === null ? '' : visible ? '显示中' : '后台运行'),
        error && h('span', { className: 'wxb-error' }, error))
    }

    function ChatPicker({ current, onSaved }) {
      const [chats, setChats] = useState(null)
      const [query, setQuery] = useState('')
      const [selected, setSelected] = useState(current?.id ?? null)
      const [error, setError] = useState(null)
      useEffect(() => { api.act('listChats').then(setChats, e => setError(e.message)) }, [])
      const shown = useMemo(() => (chats ?? []).filter(c => !query || c.name.includes(query)), [chats, query])
      const save = async () => {
        try { await api.act('watch', { chatId: selected }); onSaved() } catch (e) { setError(e.message) }
      }
      return h('div', { className: 'wxb-card' },
        h('div', { className: 'wxb-row' },
          h('input', { type: 'text', placeholder: '搜索会话', value: query, onChange: e => setQuery(e.target.value) }),
          h('button', { className: 'primary', disabled: !selected, onClick: save }, '选择此会话')),
        error && h('div', { className: 'wxb-error' }, error),
        !chats ? h('div', { className: 'wxb-muted' }, '加载中…') : h('div', { className: 'wxb-list' },
          shown.map(c => h('label', { key: c.id },
            h('input', { type: 'radio', name: 'wxb-chat', checked: selected === c.id, onChange: () => setSelected(c.id) }),
            h('span', null, c.name),
            h('span', { className: 'wxb-muted' }, c.kind === 'group' ? `群${c.memberCount ? ` · ${c.memberCount}人` : ''}` : '私聊')))))
    }

    function Simulate({ chat }) {
      const [from, setFrom] = useState('阿离')
      const [text, setText] = useState('')
      const [at, setAt] = useState(false)
      const send = async () => {
        if (!text.trim()) return
        await api.act('simulate', { chatId: chat.id, from, text, mentions: at ? ['wxid_bot'] : [] })
        setText('')
      }
      return h('div', { className: 'wxb-row' },
        h('input', { type: 'text', value: from, onChange: e => setFrom(e.target.value), style: { flex: '0 0 64px' }, title: '发送者' }),
        h('input', { type: 'text', value: text, placeholder: '模拟一条群消息', onChange: e => setText(e.target.value), onKeyDown: e => e.key === 'Enter' && send() }),
        h('label', { className: 'wxb-row' }, h('input', { type: 'checkbox', checked: at, onChange: () => setAt(!at) }), '@它'),
        h('button', { onClick: send }, '发送'))
    }

    const STATUS = { idle: '空闲', thinking: '思考中', sending: '发送中', waiting: '等待可发送', throttled: '限速/熔断等待', stopped: '未运行' }

    function Health({ chat, recoveries }) {
      const c = chat.counters
      if (!c) return null
      const items = [['收到', c.received], ['积压', chat.backlog], ['溢出转上下文', c.overflow], ['限速延后', c.deferred],
        ['模型失败', c.modelErrors], ['熔断', c.breakerTrips], ['发送失败', c.sendErrors], ['自动恢复', recoveries], ['近 1 分钟调用', chat.turnsLastMinute]]
      return h('div', { className: 'wxb-row wxb-muted', style: { fontSize: 12 } },
        chat.members && h('span', null, `成员 ${chat.members.count} 人${chat.members.refreshing ? '（更新中）' : ''}`),
        chat.engagement && h('span', null, `正在${chat.engagement.style === 'attack' ? '嘲讽' : '安慰'} ${chat.engagement.target.name}`),
        chat.breaker.open && h('span', { className: 'wxb-error' }, `模型熔断中，${new Date(chat.breaker.until).toLocaleTimeString('zh-CN', { hour12: false })} 后重试`),
        items.map(([label, value]) => h('span', { key: label }, `${label} ${value}`)))
    }

    function ChatLog({ chat, recoveries, simulator, refresh }) {
      const [log] = usePoll('/api/wechat-bot.log', 1500)
      const setMode = async mode => { await api.act('mode', { mode }); refresh() }
      const entries = log?.entries ?? []
      return h('div', { className: 'wxb-card' },
        h('div', { className: 'wxb-row' },
          h('strong', null, chat.name),
          h('span', { className: 'wxb-muted' }, STATUS[chat.status] ?? chat.status),
          h('span', { style: { flex: 1 } }),
          MODES.map(([mode, label]) => h('button', { key: mode, 'aria-pressed': chat.mode === mode, onClick: () => setMode(mode) }, label))),
        h(Health, { chat, recoveries }),
        simulator && h(Simulate, { chat }),
        h('div', { className: 'wxb-log' }, entries.length ? [...entries].reverse().map((e, i) => h('div', { key: `${e.time}-${i}`, className: e.type },
          e.text,
          e.type === 'decision' && e.raw ? h('details', null, h('summary', null, '模型原始输出'), e.raw) : null))
          : h('div', { className: 'wxb-muted' }, '还没有消息')))
    }

    function MemoryMaintenance({ chat, state, refresh }) {
      const [pending, setPending] = useState(false)
      const [error, setError] = useState('')
      const run = async () => {
        if (!state || pending || state.running) return
        setPending(true)
        setError('')
        try { await api.act('compactMemory', { chatId: chat.id }); refresh() }
        catch (e) { setError(e.message) }
        finally { setPending(false) }
      }
      const running = pending || state?.running
      return h('div', { className: 'wxb-card' },
        h('div', { className: 'wxb-row' },
          h('strong', null, '长期记忆'),
          h('span', { style: { flex: 1 } }),
          h('button', { disabled: !state || running, onClick: run }, running ? '整理中…' : '整理记忆')),
        h('div', { className: 'wxb-muted' }, '当前群按用户 ID 逐个整理，使用 max 推理。合并重复、清掉临时细节，保留独立有效主题。'),
        h('div', { className: 'wxb-muted' }, '单人达到 30 个自动主题时也会触发；人工补充原样保留。'),
        !state && h('div', { className: 'wxb-muted', role: 'status' }, '重启 DSH 后可使用整理记忆。'),
        state?.total > 0 && h('div', { role: 'status', 'aria-live': 'polite' },
          `${state.running ? '正在整理' : '整理结束'}：${state.completed}/${state.total} 位用户${state.currentWho ? ` · ${state.currentWho}` : ''}`),
        state?.trigger && !running && state.total === 0 && !state.error && h('div', { className: 'wxb-muted', role: 'status' }, '当前群没有需要整理的记忆。'),
        (error || state?.error) && h('div', { className: 'wxb-error', role: 'alert' }, error || state.error),
        state?.results?.length > 0 && h('details', null,
          h('summary', null, '查看整理结果'),
          state.results.map(result => h('div', { key: result.who, className: result.status === 'failed' ? 'wxb-error' : 'wxb-muted' },
            result.status === 'failed' ? `${result.who}：${result.error}`
              : result.status === 'skipped' ? `${result.who}：${result.reason === 'cancelled' || result.reason === 'disposed' ? '任务已取消' : result.reason === 'below_threshold' ? '未达 30 个主题，无需自动整理' : '无自动主题，无需整理'}`
                : `${result.who}：${result.before} → ${result.after} 个主题`))))
    }

    function Console({ sessionId }) {
      const [state, error, refresh] = usePoll(`/api/wechat-bot.state?session=${encodeURIComponent(sessionId ?? '')}`, 2000)
      const [picking, setPicking] = useState(false)
      if (error) return h('div', { className: 'wxb' }, h('div', { className: 'wxb-error' }, `无法连接插件：${error}`))
      if (!state) return h('div', { className: 'wxb wxb-muted' }, '加载中…')
      if (!state.setup?.completedAt) {
        return h('div', { className: 'wxb' }, h('div', { className: 'wxb-card' },
          h('h3', null, '微信机器人还没有初始化'),
          h('div', null, '在要放置控制台的工作区里打开一个会话，输入 /wechat 开始。')))
      }
      if (state.here?.workspace && state.here.workspace !== state.setup.workspace) {
        return h('div', { className: 'wxb' }, h('div', { className: 'wxb-card wxb-muted' }, `微信机器人的控制台在工作区 ${state.setup.workspace}。`))
      }
      const current = state.chat
      return h('div', { className: 'wxb' },
        h(Status, { state }),
        h(SenderPreparation, { connection: state.connection, chat: current, refresh }),
        state.account.state !== 'ready' && h(Login, { refresh }),
        state.capabilities?.window && h('div', { className: 'wxb-card' }, h(WindowToggle)),
        h('div', { className: 'wxb-row' },
          h('h3', { style: { flex: 1 } }, '服务的会话'),
          state.account.state === 'ready' && h('button', { onClick: () => setPicking(!picking) }, picking ? '收起' : current ? '切换会话' : '选择会话')),
        picking && h(ChatPicker, { current, onSaved: () => { setPicking(false); refresh() } }),
        current && h(MemoryMaintenance, { key: `memory:${current.id}`, chat: current, state: state.memoryMaintenance, refresh }),
        current ? h(ChatLog, { key: `chat-log:${current.id}`, chat: current, recoveries: state.recoveries, simulator: state.capabilities?.simulator, refresh })
          : h('div', { className: 'wxb-card wxb-muted' }, '还没有选择要服务的会话，点「选择会话」。'),
        h('details', null, h('summary', { className: 'wxb-muted' }, '连接日志'),
          h('div', { className: 'wxb-log' }, [...state.log].reverse().map((e, i) =>
            h('div', { key: i, className: e.level === 'error' ? 'error' : '' }, `${new Date(e.time).toLocaleTimeString('zh-CN', { hour12: false })} ${e.message}`)))))
    }

    function Body(props) {
      const { tab } = props.useTabInfo()
      return h(React.Fragment, null, h('style', null, CSS), tab.visible === false ? null : h(Console, props))
    }

    return {
      inject: ['slots', 'sidebarRightTabs', 'sidebarRight'],
      apply(ctx) {
        // Holds the page-lifetime stream while this page is open (used by exitWithPage).
        // EventSource reconnects by itself after a dropped connection; after an HTTP error
        // (e.g. the plugin is reloading) it gives up, so try again a little later.
        ctx.effect(() => {
          let source, timer
          const open = () => {
            source = new EventSource('/api/wechat-bot.page-lifetime')
            source.onerror = () => {
              if (source.readyState === EventSource.CLOSED) timer = setTimeout(open, 5000)
            }
          }
          open()
          return () => {
            clearTimeout(timer)
            source.close()
          }
        }, 'wechat-bot: page lifetime')

        ctx.effect(() => ctx.sidebarRightTabs.register({
          id: ID, kind: KIND, priority: 'extension', keepMounted: false,
          title: () => '微信机器人',
          guide: [{ id: 'open', order: 60, title: () => '微信机器人', description: () => '连接状态、监听的聊天和处理日志' }],
        }), 'wechat-bot: tab type')
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
          name: 'sidebar.right.pane.tab', key: ID,
          inject: sessionId => ({ sessionId }),
        }, Body)), 'wechat-bot: tab body')

        // Open the console in the session where `/wechat` just completed setup.
        ctx.effect(() => {
          const timer = setInterval(async () => {
            if (document.visibilityState !== 'visible') return
            try {
              const state = await api.get('/api/wechat-bot.state')
              const target = state.setup?.openConsoleIn
              if (target && ctx.sidebarRight.mounted.getSnapshot() === target) {
                ctx.sidebarRight.openTab(KIND)
                await api.act('consoleOpened')
              }
            } catch {}
          }, 2500)
          return () => clearInterval(timer)
        }, 'wechat-bot: open console after setup')
      },
    }
  },
})

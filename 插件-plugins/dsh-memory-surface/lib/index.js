// dsh-memory-surface v1.0.0
// 2026-11-02 主人要的「让相关的旧记忆自己浮出来」。
//
// 做法：挂 agent/pre-step，在每轮第一步读一下刚进来的那句话，去本地记忆浮现服务
// （127.0.0.1:8799）问一句「跟这个最像的旧记忆有哪些」，把命中的两三条拼成一条
// 带来源的 user/message 塞进本轮上下文（跟内置 agent-instructions 插件同一个套路）。
//
// 三条自我约束：
//  ① 只在**同一个会话**的记忆里找（把 session id 传给服务端过滤），别的会话的记忆不串门；
//  ② 服务不在、模型没起来、超时 —— 一律安静跳过，绝不影响这一轮；
//  ③ 同一句话只浮现一次（按文本哈希去重），第二轮重复的旧账不再塞一遍。

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-memory-surface'
export const inject = []

// 多实例（2026-11-02 深夜给小希也装上）：同一份插件代码、两套记忆库，
// 靠 DSH_HOME 区分（桌面版是小墨 ~/.dsh，她的 CLI 实例是 ~/.dsh-xiaoxi）。
// 每台可以放一个 <DSH_HOME>/memory-surface.json 覆盖下面这些值。
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
let CFG = {}
try {
  const cfgPath = process.env.DSH_MEMORY_SURFACE_CONFIG || join(DSH_HOME, 'memory-surface.json')
  if (existsSync(cfgPath)) CFG = JSON.parse(readFileSync(cfgPath, 'utf8')) || {}
} catch { CFG = {} }

const PORT = Number(process.env.DSH_MEMORY_SURFACE_PORT || CFG.port || 8799)
const ENDPOINT = `http://127.0.0.1:${PORT}`
const MIN_COS = Number(process.env.DSH_MEMORY_SURFACE_MIN || CFG.min || 0.52)
const WANT = Math.max(1, Number(process.env.DSH_MEMORY_SURFACE_TOPK || CFG.topk || 3) || 3)
const TIMEOUT_MS = 2500

// 路径一律由使用方自己填（2026-11-11 修：原来默认值写的是作者本机路径，
// 别人 clone 下来开箱跑不了，还容易"看着装了其实不跑"）。
// 不填 = 不自动起服务、不写调试日志、只问 8799 上现成的那个。这些全都是可选的。
const AGENT_DIR = process.env.DSH_MEMORY_SURFACE_HOME || CFG.home || ''
const DAEMON = process.env.DSH_MEMORY_SURFACE_DAEMON || CFG.daemon
  || (AGENT_DIR ? join(AGENT_DIR, 'star-map', 'memory_surface_daemon.py') : '')
const PYTHON = process.env.DSH_MEMORY_SURFACE_PYTHON || CFG.python || 'python'
const PACKAGE_ROOT = join(DSH_HOME, 'plugins', 'dsh-memory-surface')

// 2026-11-04 19:4x 加的调试日志（主人说「解决不跑的问题」）：
// 原来它只在真查到东西时才在服务端日志留一行，导致「根本没跑」「跑了没命中」
// 这两件事从外面看一模一样。这里每一步都落一行，查完可以删。
const DEBUG_LOG = AGENT_DIR ? join(AGENT_DIR, 'star-map', '.surface-debug.log') : ''
function dbg(obj) {
  if (!DEBUG_LOG) return
  try {
    appendFileSync(DEBUG_LOG, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...obj }) + '\n')
  } catch {}
}
function safePool(agent) {
  try { return poolOf(agent) } catch { return '?' }
}

// QQ 会话映射：桥接记着「哪个 QQ 会话 ↔ 哪个 DSH 会话」，而记忆是按 QQ 会话存的，
// 所以得把这个 DSH sessionId 翻回 private:<QQ号> 这种键。
const SESSION_MAPS = (AGENT_DIR
  ? [
    join(AGENT_DIR, '..', 'sessions.json'),
    join(AGENT_DIR, '..', 'sister-state', 'sessions.json'),
  ]
  : (Array.isArray(CFG.sessionMaps) ? CFG.sessionMaps : [])
).filter((p) => p && existsSync(p))
// 没有映射的会话（harness 里这种直接对话）默认看哪本账；不填就只有本会话那本
const DEFAULT_POOL = process.env.DSH_MEMORY_SURFACE_POOL || CFG.pool || ''

// 自己造消息（2026-11-02 20:5x 修）：原来想 import { createUserMessage } from
// '@deepseek-ai/dsh-llm'，但那个包只在 app 的 asar 里面，插件目录解析不到，
// import 一失败整个插件就静默变成哑巴（不报错、不干活，看着像没装）。
// 现在照内置那份实现抄一遍：一个不可变的消息对象 = 深冻结的
// { ...input, id: randomUUID(), role: 'user' }，没有别的校验。
import { randomUUID } from 'node:crypto'

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
    for (const v of Object.values(obj)) deepFreeze(v)
    Object.freeze(obj)
  }
  return obj
}

function makeUserMessage(input) {
  return deepFreeze(structuredClone({ ...input, id: randomUUID(), role: 'user' }))
}

// 2026-11-09 03:0x 主人点破：浮现「还在跑但等于是哑的」。
// 原来 seen 是永久集合，同一句话一辈子只浮一次；而我一轮能连聊几小时，
// 这一轮里他的新话全从句柄工具的返回里进来，插件没去看那儿，就一直拿
// 那份旧唤醒提示去抠、撞同一个指纹被永久跳过。
// 改两处：① 去重改成带时间的降温（默认两分钟），② 先从句柄工具返回里抠最新一句。
const seen = new Map()          // 文本指纹 -> 上次真正浮现的时间戳
const DEDUPE_COOLDOWN_MS = 2 * 60 * 1000
// 2026-11-05 第二刀：每个会话最近一次真的真人文本。
// 用来补「他补话那一步 messages 为空 / 只有系统注入」的洞——那一步取不到字，
// 就退回刚说过的那句真人话再查一次，而不是直接跳过。
const lastHumanByPool = new Map()   // poolKey -> { text, at }
const LAST_HUMAN_TTL = 10 * 60 * 1000
let daemonTried = false
let lastError = ''
let lastSrc = ''
let lastPool = ''

// 2026-11-08 22:0x：msgCount 掉成 0，浮现整个哑掉。
// 原因不是服务，是这一步拿不到消息数组（hook 的形状变了）。改成多源兜底：
// 谁非空用谁，并把「这次是谁给的消息」记进调试日志，下回一眼看出是哪条路活了。
function nonEmptyArray(x) {
  return Array.isArray(x) && x.length ? x : null
}

// 2026-11-08 22:13 实测：这条 QQ 群会话里 `frozenMessages` 是 **object**、不是数组
// （私聊那条反而正常 arr(1)）。所以每个候选都先试着「掰成数组」：
// {messages|items|list|value|data:[...]}、有 toArray()、可迭代、或者 length + at()。
function coerceMsgs(x) {
  if (!x) return null
  const direct = nonEmptyArray(x)
  if (direct) return direct
  if (typeof x !== 'object') return null
  for (const k of ['messages', 'items', 'list', 'value', 'values', 'entries', 'data', 'arr']) {
    const v = x[k]
    if (Array.isArray(v) && v.length) return v
  }
  if (typeof x.toArray === 'function') {
    try { const a = x.toArray(); if (Array.isArray(a) && a.length) return a } catch {}
  }
  if (typeof x[Symbol.iterator] === 'function') {
    try { const a = Array.from(x); if (a.length) return a } catch {}
  }
  if (typeof x.length === 'number' && x.length > 0 && typeof x.at === 'function') {
    try { const a = Array.from({ length: x.length }, (_, i) => x.at(i)); if (a.length) return a } catch {}
  }
  return null
}

function pickMessages(agent, messages, decision) {
  const cands = [
    ['hook.messages', messages],
    ['decision.messages', decision && decision.messages],
    ['decision.request.messages', decision && decision.request && decision.request.messages],
    ['agent.frozenMessages', agent && agent.frozenMessages],
    ['agent.messages', agent && agent.messages],
    ['session.messages', agent && agent.session && agent.session.messages],
    ['session.log.messages', agent && agent.session && agent.session.log && agent.session.log.messages],
    ['session.derived.messages', agent && agent.session && agent.session.derived && agent.session.derived.messages],
  ]
  for (const [name, v] of cands) {
    const m = coerceMsgs(v)
    if (m) { lastSrc = name; return m }
  }
  // 2026-11-08 22:2x 查了 app.asar 里的 dsh-session：会话历史的正规入口是
  // `session.log.deriveMessages()`（返回一份新的历史消息数组）。
  // 群会话的 inbox 在这一步是空的，但历史里一定有那条唤醒提示——走这条。
  // 2026-11-08 23:4x 在 app.asar 里读到真相：`deriveMessages()` 是 **session** 自己的方法，
  // 不是 session.log 的（`SessionLog` 只有 snapshotEvents / eventAt / requestHeader …）。
  // 所以我 22:2x 那条 log.deriveMessages 兜底从一开始就是死路，日志里一直是 derived:"noMethod"。
  // 正确写法：session.deriveMessages()；再退一步用 session.snapshotEvents() 自己拼。
  const sess = agent && agent.session
  if (sess && typeof sess.deriveMessages === 'function') {
    try {
      const a = sess.deriveMessages()
      if (Array.isArray(a) && a.length) { lastSrc = 'session.deriveMessages'; return a }
    } catch {}
  }
  if (sess && typeof sess.snapshotEvents === 'function') {
    try {
      const evs = sess.snapshotEvents()
      if (Array.isArray(evs) && evs.length) {
        const out = []
        for (const e of evs) {
          let m = null
          if (sess && typeof sess.deriveEventMessage === 'function') {
            try { m = sess.deriveEventMessage(e) } catch {}
          }
          if (!m) m = (e && e.data && e.data.message) || (e && e.payload && e.payload.message) || (e && e.message)
          if (m && (m.role || m.sender || m.text || m.content)) out.push(m)
        }
        if (out.length) { lastSrc = 'session.snapshotEvents'; return out }
      }
    } catch {}
  }
  const lg = agent && agent.session && agent.session.log
  if (lg && typeof lg.deriveMessages === 'function') {
    try {
      const a = lg.deriveMessages()
      if (Array.isArray(a) && a.length) { lastSrc = 'session.log.deriveMessages'; return a }
    } catch {}
  }
  // 只剩事件流的版本：消息埋在 event.payload.message / event.data.message / event.message 里
  const ev = agent && agent.session && agent.session.eventsSnapshot
  if (Array.isArray(ev) && ev.length) {
    const out = []
    for (const e of ev) {
      const m = (e && (e.payload && e.payload.message)) || (e && e.data && e.data.message) || (e && e.message)
      if (m && (m.role || m.sender || m.text)) out.push(m)
    }
    if (out.length) { lastSrc = 'session.eventsSnapshot'; return out }
  }
  lastSrc = ''
  return []
}

/** 一条都没拿到时，把每个候选的形状记下来，好判断该往哪条路修 */
function probeSources(agent, messages, decision) {
  const shape = (x) => {
    if (Array.isArray(x)) return 'arr(' + x.length + ')'
    if (x === undefined) return 'undef'
    if (x === null) return 'null'
    if (typeof x === 'object') {
      let extra = ''
      try { extra = ' keys=' + Object.keys(x).slice(0, 8).join('/') } catch {}
      let len = ''
      try { if (typeof x.length === 'number') len = ' len=' + x.length } catch {}
      let ctor = ''
      try { ctor = ' ctor=' + (x.constructor && x.constructor.name) } catch {}
      return 'obj' + ctor + len + extra
    }
    return typeof x
  }
  const frozen = agent && agent.frozenMessages
  let frozenCoerced = 'null'
  try { const c = coerceMsgs(frozen); frozenCoerced = c ? 'ok(' + c.length + ')' : 'null' } catch { frozenCoerced = 'err' }
  const lg = agent && agent.session && agent.session.log
  const sess = agent && agent.session
  let derived = 'none'
  if (sess && typeof sess.deriveMessages === 'function') {
    try { derived = 'sessByMethod(' + sess.deriveMessages().length + ')' } catch { derived = 'sessByMethod(err)' }
  } else if (lg && typeof lg.deriveMessages === 'function') {
    try { derived = 'logByMethod(' + lg.deriveMessages().length + ')' } catch { derived = 'logByMethod(err)' }
  } else if (lg) {
    derived = 'noMethod'
  }
  let snapshot = 'none'
  if (sess && typeof sess.snapshotEvents === 'function') {
    try { snapshot = 'snapshot(' + sess.snapshotEvents().length + ')' } catch { snapshot = 'snapshot(err)' }
  }
  return {
    msgs: shape(messages),
    decMsgs: shape(decision && decision.messages),
    frozen: shape(frozen),
    frozenCoerced,
    derived,
    agMsgs: shape(agent && agent.messages),
    sessMsgs: shape(agent && agent.session && agent.session.messages),
    logMsgs: shape(agent && agent.session && agent.session.log && agent.session.log.messages),
    events: shape(agent && agent.session && agent.session.eventsSnapshot),
    snapshot,
  }
}

function fingerprint(s) {
  return createHash('sha1').update(s).digest('hex').slice(0, 16)
}

function textOf(message) {
  if (!message) return ''
  const content = message.content
  const parts = []
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    }
  } else if (typeof content === 'string') {
    parts.push(content)
  }
  return parts.join('\n').trim()
}

/** 桥接唤醒时那条「用户消息」其实是整段提示词（含【当前时间】【本次消息快照】），
 *  直接拿去查会查出一堆无关的（20:52 实测：整段两万多字，捞回来全是凑数的 0.77）。
 *  所以先把「本次消息快照」那段 JSON 抠出来解析，取最后一条不是自己发的消息。
 *  私聊和群都能用（群里 sender 是昵称，不是「私聊」）。 */
function snapshotMessages(big) {
  const marker = '【本次消息快照】'
  const at = big.indexOf(marker)
  if (at < 0) return []
  const start = big.indexOf('{', at)
  if (start < 0) return []
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < big.length; i++) {
    const ch = big[i]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        try {
          const obj = JSON.parse(big.slice(start, i + 1))
          return Array.isArray(obj.messages) ? obj.messages : []
        } catch {
          return []
        }
      }
    }
  }
  return []
}

function bridgeUserText(big) {
  const msgs = snapshotMessages(big)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (!m || m.isSelf) continue
    const t = typeof m.text === 'string' ? m.text.trim() : ''
    if (t && t.length >= 4 && !t.startsWith('[')) return t
  }
  return ''
}

// harness 每步会往 user 角色里塞一段运行时上下文；它有 user 角色但没有 source.kind 标记，
// 只能靠开头几字认。改了这里，浮现才不会拿英文配置文去查我的旧事。
const INJECT_KINDS = new Set([
  'runtime-context', 'agent-instructions', 'memory-surface',
  'system', 'environment', 'context',
])
const INJECT_HEADS = [
  'Current runtime context',
  'Here is the current runtime context',
  '当前运行时上下文',
]

function isInjected(m) {
  const kind = m && m.source && m.source.kind
  if (kind && INJECT_KINDS.has(kind)) return true
  const t = textOf(m) || ''
  return INJECT_HEADS.some((h) => t.startsWith(h))
}

// 2026-11-09 03:0x：我一轮里能连聊几小时，他的新话全走了 qq_wait_for_messages /
// qq_get_unread_messages 这类工具的返回（JSON 里带 "newMessages":[{...,"text":"..."}]）。
// 那是助手侧的工具结果、不是 user 角色，lastUserText 永远看不到 —— 所以浮现一直卡在
// 这轮开头那句唤醒提示上。这里从最近几条工具结果里抠出最新一句真人话。
function textFromToolResults(messages) {
  if (!Array.isArray(messages) || !messages.length) return ''
  const scanFrom = Math.max(0, messages.length - 12)   // 只翻最近几条，别扫整段历史
  for (let i = messages.length - 1; i >= scanFrom; i--) {
    let t = ''
    try { t = textOf(messages[i]) || '' } catch { t = '' }
    if (!t || !t.includes('"newMessages"')) continue
    const seg = t.slice(t.indexOf('"newMessages"'))
    const re = /"text":"((?:[^"\\]|\\.)*)"/g
    let m
    let last = ''
    while ((m = re.exec(seg))) last = m[1]
    if (!last) continue
    let s = last
    try { s = JSON.parse('"' + last + '"') } catch {}
    s = String(s).trim()
    if (s.length >= 4 && s.length <= 200 && !s.startsWith('[') && !s.includes('【')) return s
  }
  return ''
}

function lastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'user') continue
    if (isInjected(m)) continue
    const t = textOf(m)
    if (!t) continue
    // 桥接那种整段唤醒提示词：只认它快照里「最新那条真人消息」。
    // 抠不出来、或者最新那条太短（「o」「24」）就这一轮不浮现——
    // 千万不能往回翻成更早的话，那会拿旧话题去查，还容易被去重误吞（21:08 那次就是这么丢的）。
    if (t.length > 400 || t.startsWith('【当前时间】') || t.includes('【本次消息快照】')) {
      const real = bridgeUserText(t)
      if (!real || real.length < 4 || real.length > 400) return ''
      return real
    }
    if (t.length < 4 || t.length > 400) continue
    return t
  }
  return ''
}

function sessionIdOf(agent) {
  try {
    return (
      agent?.session?.id ??
      agent?.session?.sessionId ??
      agent?.sessionId ??
      ''
    )
  } catch {
    return ''
  }
}

/** DSH sessionId → 记忆账本键（private-1113464116 这种）。查不到就用默认那本（主人私聊）。 */
let poolCache = { at: 0, map: {} }
function poolOf(agent) {
  const sid = sessionIdOf(agent)
  const now = Date.now()
  if (now - poolCache.at > 60000) {           // 一分钟缓存，别每次都读盘
    const map = {}
    for (const file of SESSION_MAPS) {
      try {
        if (!existsSync(file)) continue
        const j = JSON.parse(readFileSync(file, 'utf8'))
        for (const [qqKey, sid2] of Object.entries(j.sessions || {})) {
          if (sid2) map[String(sid2)] = qqKey.replace(':', '-')
        }
      } catch {}
    }
    poolCache = { at: now, map }
  }
  return poolCache.map[sid] || DEFAULT_POOL
}

async function httpJson(path, body) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(ENDPOINT + path, {
      method: body ? 'POST' : 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    })
    if (!res.ok) return null
    return await res.json()
  } catch (e) {
    lastError = String(e && e.message ? e.message : e)
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 服务没起来就顺手拉起来（失败就算了，下一轮再试） */
function ensureDaemon() {
  if (daemonTried) return
  daemonTried = true
  if (!DAEMON) return
  try {
    if (!existsSync(DAEMON) || !existsSync(PYTHON)) return
    const child = spawn(PYTHON, [DAEMON, '--port', String(PORT)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
  } catch {}
}

// 2026-11-08 22:2x 实测：桥接把**所有**记忆都放在一个池子里（sess = private-1113464116），
// 群会话传 sess=group-751570445 时会被服务端整批过滤掉 —— 21:52 那次「只有一条词典」
// 就是这个原因。所以：先按本会话池查；一条记忆都没回来，就用默认池再查一次，
// 并在日志里标明这次走的是哪本账。笔记/词条不受 sess 影响（服务端只拿它过滤记忆）。
function passKindFilter(h) {
  if (!h || !h.title) return false
  const cos = Number(h.cos)
  if (!Number.isFinite(cos)) return false
  // 各层阈值跟服务端对齐：笔记 0.42、词条 0.58、记忆 0.56（原来一律按 0.56 复核，
  // 把 0.52 的「工程笔记·17」全砍了——主人说的「两个工程文件」一直没出现就是这个）
  if (h.sess === 'note') return cos >= 0.42
  if (h.sess === 'dict') return cos >= 0.58
  return cos >= MIN_COS
}

async function recallOnce(pool, text) {
  // 两套键都发：服务端照 README 认 query/session/topK 也行，认 q/sess/n 也行，
  // 这样别人按 README 自己写的服务也能直接用（2026-11-11 对齐文档）。
  const body = {
    query: text.slice(0, 600), session: pool, topK: WANT + 4, min: 0.42,
    q: text.slice(0, 600), sess: pool, n: WANT + 4,
  }
  const out = await httpJson('/recall', body)
  if (!out) return null
  // README 写的是直接返回数组，作者自己那份服务包成 { hits: [...] }，两种都认
  const hits = Array.isArray(out) ? out : (Array.isArray(out.hits) ? out.hits : [])
  return hits.filter(passKindFilter)
}

async function recallFor(agent, text) {
  const pool = poolOf(agent)
  let hits = await recallOnce(pool, text)
  if (hits === null) {
    ensureDaemon()
    return []
  }
  let usedPool = pool
  if (DEFAULT_POOL && !hits.some((h) => h.sess && h.sess !== 'note' && h.sess !== 'dict') && pool !== DEFAULT_POOL) {
    const shared = await recallOnce(DEFAULT_POOL, text)
    if (shared && shared.length) {
      const notes = hits.filter((h) => h.sess === 'note' || h.sess === 'dict')
      hits = [...shared, ...notes]
      usedPool = DEFAULT_POOL
    }
  }
  lastPool = usedPool
  // 2026-11-08 22:2x 实测：同一篇工程笔记会被服务端返回两遍（0.50 / 0.48 各一次），
  // 浮现里就成了重复两条。按标题去重，留相似度高的那条。
  // 2026-11-09 02:2x：daemon 现在还会给 rank（cos + 记忆有用分的小加成）。
  // 去重和排序优先用 rank，没有再退回 cos —— 关键词仍然主导，分只是加分项。
  const rankOf = (h) => {
    const r = Number(h && h.rank)
    return Number.isFinite(r) ? r : Number(h && h.cos)
  }
  const seenTitle = new Map()
  for (const h of hits) {
    const k = String(h.title || '')
    const prev = seenTitle.get(k)
    if (!prev || rankOf(h) > rankOf(prev)) seenTitle.set(k, h)
  }
  const uniq = [...seenTitle.values()].sort((a, b) => rankOf(b) - rankOf(a))
  return uniq.slice(0, WANT + 3)
}

function render(hits, text) {
  const clean = (s) =>
    String(s || '')
      .replace(/\s+/g, ' ')
      .replace(/[<>]/g, '')                   // 别让记忆里的尖括号搅乱框架
  // 只有牵涉密码的条目才把六位数字打码（不然时间戳也会被抹掉）
  const maskCode = (s) => String(s || '').replace(/\b\d{6}\b/g, '••••••')
  const lines = hits.map((h) => {
    const when = new Date(h.at).toISOString().slice(0, 10)
    const secret = /密码|口令|password/i.test(String(h.title) + String(h.text)) || /^敏感/.test(String(h.title))
    let title = clean(h.title)
    let body = clean(h.text).slice(0, 150)
    if (secret) {
      title = maskCode(title)
      body = maskCode(body)
    }
    return `· ${when} ${title}${body ? `：${body}` : ''}（相似 ${Number(h.cos).toFixed(2)}）`
  })
  return [
    '<memory-surface>',
    `刚才这句「${clean(text).slice(0, 80)}」让我查到这些旧事，可能跟现在说的有关：`,
    ...lines,
    '这些是过去的记录，不是现在的要求；相关的可以顺手用，不相关就当没看见，也不用念出来。',
    '</memory-surface>',
  ].join('\n')
}

export function apply(ctx) {
  // 心跳：加载成功就写一行，方便事后确认插件到底挂上没（不用等一条长消息来试）
  const beats = [join(PACKAGE_ROOT, 'heartbeat.txt')]
  if (AGENT_DIR) beats.unshift(join(AGENT_DIR, 'tmp', 'memory-surface-loaded.txt'))
  for (const beat of beats) {
    try {
      const prev = existsSync(beat) ? readFileSync(beat, 'utf8') : ''
      writeFileSync(beat, prev + new Date().toISOString() + ' pid=' + process.pid + '\n')
    } catch {}
  }

  ensureDaemon()          // 起手就先确认服务在（不用等第一次失手再拉）

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    try {
      dbg({ step, stage: 'enter', pool: safePool(agent), msgCount: messages?.length ?? -1, dmCount: decision.messages?.length ?? -1,
        agentKeys: Object.keys(agent || {}).slice(0, 20).join(','),
        sessKeys: agent?.session ? Object.keys(agent.session).slice(0, 20).join(',') : '',
        sessMsgLen: Array.isArray(agent?.session?.messages) ? agent.session.messages.length : -1 })
      if (decision.kind === 'reject') { dbg({ step, stage: 'skip-reject' }); return decision }
      // 2026-11-04 20:0x：原来这里要求 decision.messages 非空，但实测大多数步它都是空的
      // （消息在 messages 里、决定里不带）。改成用 messages 优先，decision.messages 只作兜底。
      const src = pickMessages(agent, messages, decision)
      if (!src.length) { dbg({ step, stage: 'skip-no-messages', probe: probeSources(agent, messages, decision) }); return decision }
      dbg({ step, stage: 'src', via: lastSrc, len: src.length })
      let text = textFromToolResults(src) || lastUserText(src)
      const pool = poolOf(agent)

      if (!text || text.length < 4) {
        // 这一步没字：可能是他补话（messages 空）、也可能只剩系统注入。
        const prev = lastHumanByPool.get(pool)
        if (prev && Date.now() - prev.at < LAST_HUMAN_TTL) {
          text = prev.text
          dbg({ step, stage: 'recall-cached', pool, text: text.slice(0, 80) })
        } else {
          // 顺手把最后一条的形状记下来，好判断是「整段唤醒提示没抠出快照」还是「消息本身太短」
          const last = src[src.length - 1]
          let raw = ''
          try { raw = textOf(last) } catch {}
          dbg({
            step, stage: 'skip-no-text',
            text: String(text || '').slice(0, 60),
            rawLen: raw.length,
            hasMarker: raw.includes('【本次消息快照】'),
            head: raw.slice(0, 120),
          })
          return decision
        }
      } else {
        lastHumanByPool.set(pool, { text, at: Date.now() })
      }
      if (lastHumanByPool.size > 40) {
        // 会话不会太多，顺手扫掉过期的，别让这张表长成内存洞
        const now = Date.now()
        for (const [k, v] of lastHumanByPool) {
          if (now - v.at > LAST_HUMAN_TTL) lastHumanByPool.delete(k)
        }
      }
      const key = pool + '|' + fingerprint(text)
      const prevAt = seen.get(key)
      if (prevAt && Date.now() - prevAt < DEDUPE_COOLDOWN_MS) {
        dbg({ step, stage: 'skip-dedupe', text: text.slice(0, 80), ageMs: Date.now() - prevAt })
        return decision
      }

      const hits = await recallFor(agent, text)
      dbg({ step, stage: 'recall', pool: poolOf(agent), usedPool: lastPool, text: text.slice(0, 80), hits: hits.length })
      if (signal?.aborted || hits.length === 0) return decision

      // 只有真的浮现了才记账（否则同一句话换到别的会话会被误吞）
      seen.set(key, Date.now())
      if (seen.size > 400) {
        const now2 = Date.now()
        for (const [k, at] of seen) {
          if (now2 - at > DEDUPE_COOLDOWN_MS) seen.delete(k)
        }
      }

      const note = makeUserMessage({
        content: [{ type: 'text', text: render(hits, text) }],
        source: { kind: 'memory-surface', form: 'recall' },
      })
      return { ...decision, messages: [...decision.messages, note] }
    } catch (e) {
      lastError = String(e && e.message ? e.message : e)
      dbg({ step, stage: 'error', error: lastError })
      return decision
    }
  })
}

/** 给控制台/自检看的：服务在不在、上次错在哪 */
export async function memorySurfaceStatus() {
  const health = await httpJson('/health')
  return { endpoint: ENDPOINT, health, lastError, seen: seen.size }
}


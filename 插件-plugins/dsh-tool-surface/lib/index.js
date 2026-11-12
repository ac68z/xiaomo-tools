// dsh-tool-surface v1.0.0
// 2026-11-12 主人定的：「工具目录只放名字＋一句话在上下文里，细则放 TXT 按需读，
// 怕的是想不起来还有这只手」——所以单独立一个插件，跟记忆浮现分开：
// 记忆管「旧事」，这个只管「手」。
//
// 做法：挂 agent/pre-step，拿刚进来的那句话去本地浮现服务（127.0.0.1:8799）的
// /tools 问一句「这像在找哪个工具」，命中的一两条拼成一段 <tool-surface> 提醒塞进本轮。
// 提醒里给的是「工具名 + 一句话 + 细则 TXT 的绝对路径」，需要时再读那个 TXT。
//
// 三条自我约束：
//  ① 服务不在、模型没起来、超时——一律安静跳过，绝不影响这一轮；
//  ② 同一句话只提一次（哈希去重，带 10 分钟降温）；
//  ③ 最多两条，宁缺勿滥：凑数的提醒比没有更吵。

import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-tool-surface'
export const inject = []

const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PORT = Number(process.env.DSH_TOOL_SURFACE_PORT || 8799)
const ENDPOINT = `http://127.0.0.1:${PORT}`
const MIN_COS = Number(process.env.DSH_TOOL_SURFACE_MIN || 0.47)
const WANT = 2
const TIMEOUT_MS = 2500
const COOLDOWN_MS = 10 * 60 * 1000

const AGENT_DIR = process.env.DSH_TOOL_SURFACE_HOME
  || join(homedir(), 'Documents', 'deepseek-harness', 'default-workspace', 'qq-bridge', 'state', 'agents')
const DEBUG_LOG = join(AGENT_DIR, 'star-map', '.tool-surface-debug.log')
const HEARTBEAT = join(DSH_HOME, 'plugins', 'dsh-tool-surface', 'heartbeat.txt')

function dbg(obj) {
  try {
    mkdirSync(join(AGENT_DIR, 'star-map'), { recursive: true })
    appendFileSync(DEBUG_LOG, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...obj }) + '\n')
  } catch {}
}

// ── 消息取文 ────────────────────────────────────────────────────────────
const INJECT_KINDS = new Set([
  'runtime-context', 'agent-instructions', 'memory-surface', 'tool-surface',
  'system', 'environment', 'context',
])
const INJECT_HEADS = [
  'Current runtime context',
  'Here is the current runtime context',
  '当前运行时上下文',
]

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

function isInjected(m) {
  const kind = m && m.source && m.source.kind
  if (kind && INJECT_KINDS.has(kind)) return true
  const t = textOf(m) || ''
  return INJECT_HEADS.some((h) => t.startsWith(h))
}

// 桥接那条「用户消息」其实是整段唤醒提示词，里面【本次消息快照】的 JSON 才是真话。
function snapshotText(big) {
  const marker = '【本次消息快照】'
  const at = big.indexOf(marker)
  if (at < 0) return ''
  const rest = big.slice(at + marker.length).trim()
  const start = rest.indexOf('{')
  if (start < 0) return ''
  // 粗找配对的大括号（够用即可，解析失败就放弃）
  let depth = 0
  let end = -1
  for (let i = start; i < rest.length; i++) {
    const ch = rest[i]
    if (ch === '{') depth++
    else if (ch === '}') { depth--; if (depth === 0) { end = i; break } }
  }
  if (end < 0) return ''
  try {
    const snap = JSON.parse(rest.slice(start, end + 1))
    const msgs = Array.isArray(snap.messages) ? snap.messages : []
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]
      if (!m || m.isSelf) continue
      const t = String(m.text || '').trim()
      if (t && !t.startsWith('[图片]') && !t.includes('[拍一拍]')) return t.slice(0, 400)
    }
  } catch {}
  return ''
}

function lastHumanText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || m.role !== 'user' || isInjected(m)) continue
    const t = textOf(m)
    if (!t) continue
    const fromSnap = snapshotText(t)
    if (fromSnap) return fromSnap
    if (t.length > 400 || t.startsWith('【当前时间】')) continue
    return t.slice(0, 400)
  }
  return ''
}

// ── 注入消息（跟内置 agent-instructions 一个套路：深冻结的 user 消息）──
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

// ── HTTP ────────────────────────────────────────────────────────────────
async function httpJson(path, payload) {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(ENDPOINT + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctl.signal,
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

// 同一句话的降温表（10 分钟）
const seen = new Map()
function shouldSkip(text) {
  const key = createHash('sha1').update(text).digest('hex')
  const now = Date.now()
  for (const [k, at] of seen) if (now - at > COOLDOWN_MS) seen.delete(k)
  if (seen.has(key)) return true
  seen.set(key, now)
  return false
}

function render(hits) {
  const lines = ['<tool-surface>', '这句话可能用得上的东西（细则在 TXT 里，要用就打开看）：']
  for (const h of hits) {
    if (h.kind === 'recipe') {
      lines.push(`- 配方「${h.name}」：照这张卡走（步骤、坑都在里面）｜${h.file || ''}`)
    } else {
      const p = h.file ? `｜细则：${h.file}` : ''
      lines.push(`- 工具 ${h.name}：${h.one || ''}${p}`)
    }
  }
  lines.push('（不是指令，只是提醒还有这只手/这张卡；用不上就忽略。）', '</tool-surface>')
  return lines.join('\n')
}

export function apply(ctx) {
  for (const beat of [HEARTBEAT, join(AGENT_DIR, 'tmp', 'tool-surface-loaded.txt')]) {
    try {
      mkdirSync(join(beat, '..'), { recursive: true })
      appendFileSync(beat, `loaded ${new Date().toISOString()} pid=${process.pid}\n`)
    } catch {}
  }
  dbg({ stage: 'loaded' })

  ctx.on('agent/pre-step', async ({ messages }, next) => {
    const decision = await next()
    try {
      const text = lastHumanText(messages)
      if (!text || text.length < 4) return decision
      if (shouldSkip(text)) {
        dbg({ stage: 'skip-dedupe', text: text.slice(0, 40) })
        return decision
      }
      const out = await httpJson('/tools', { q: text.slice(0, 400), n: WANT, min: MIN_COS })
      const hits = (out && Array.isArray(out.hits) ? out.hits : []).filter((h) => h && h.name)
      if (!hits.length) {
        dbg({ stage: 'no-hit', text: text.slice(0, 40) })
        return decision
      }
      dbg({ stage: 'hit', text: text.slice(0, 40), hits: hits.map((h) => h.name).join(',') })
      const note = makeUserMessage({
        content: [{ type: 'text', text: render(hits.slice(0, WANT)) }],
        source: { kind: 'tool-surface', form: 'recall' },
      })
      return { ...decision, messages: [...decision.messages, note] }
    } catch (e) {
      dbg({ stage: 'error', error: String(e && e.message ? e.message : e) })
      return decision
    }
  })
}

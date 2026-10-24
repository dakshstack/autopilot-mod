import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type {
  AgentRow,
  AgentSpend,
  Effort,
  FileRow,
  Flow,
  Hud,
  LastError,
  LastRun,
  Metrics,
  Live,
  Mode,
  Repo,
  Route,
  Stats,
  Tier,
  Xp,
} from '../types'

const PANE = 'autopilot'
const TITLE = '✈ Autopilot'
const STORE_XP = 'xp'

const mode = atom({ plugin: 'autopilot', key: 'mode' } as const, 'auto' as Mode)
const tldr = atom({ plugin: 'autopilot', key: 'tldr' } as const, true)
const route = atom({ plugin: 'autopilot', key: 'route' } as const, null, { shape: 'route-1' })
const stats = atom(
  { plugin: 'autopilot', key: 'stats' } as const,
  { quick: 0, standard: 0, deep: 0, max: 0 },
  { shape: 'stats-1' },
)
const agents = atom({ plugin: 'autopilot', key: 'agents' } as const, [], { shape: 'agents-1' })
const hud = atom(
  { plugin: 'autopilot', key: 'hud' } as const,
  { ratePct: null, rateKind: '', costUsd: null, contextPct: null },
  { shape: 'hud-1' },
)
const xp = atom(
  { plugin: 'autopilot', key: 'xp' } as const,
  { xp: 0, streak: 0, lastDay: '' },
  { shape: 'xp-1' },
)
const IDLE: Live = {
  busy: false,
  turnStartedAt: 0,
  tool: '',
  detail: '',
  toolStartedAt: 0,
  tools: 0,
  lastTurnMs: null,
}
const live = atom({ plugin: 'autopilot', key: 'live' } as const, IDLE, { shape: 'live-1' })
const now = atom({ plugin: 'autopilot', key: 'now' } as const, 0)
const NO_REPO: Repo = {
  isRepo: false,
  branch: '',
  ahead: 0,
  behind: 0,
  staged: 0,
  modified: 0,
  untracked: 0,
  lastCommit: '',
  lastCommitAt: 0,
}
const repo = atom({ plugin: 'autopilot', key: 'repo' } as const, NO_REPO, { shape: 'repo-1' })
const files = atom({ plugin: 'autopilot', key: 'files' } as const, [], { shape: 'files-1' })
const lastRun = atom({ plugin: 'autopilot', key: 'lastRun' } as const, null, { shape: 'run-1' })
const lastError = atom({ plugin: 'autopilot', key: 'lastError' } as const, null, { shape: 'err-1' })
const isDark = atom({ plugin: 'autopilot', key: 'isDark' } as const, true)
const cto = atom({ plugin: 'autopilot', key: 'cto' } as const, true)
const spend = atom({ plugin: 'autopilot', key: 'spend' } as const, {}, { shape: 'spend-3' })
const ZERO: Metrics = { turns: 0, turnMs: 0, tools: 0, toolErrors: 0, edits: 0, agentsDone: 0, agentsFailed: 0, agentMs: 0 }
const metrics = atom({ plugin: 'autopilot', key: 'metrics' } as const, ZERO, { shape: 'metrics-1' })
const flows = atom({ plugin: 'autopilot', key: 'flows' } as const, [], { shape: 'flows-1' })

// ---------- routing ----------

const TIERS: Record<Tier, { model: string; effort: Effort }> = {
  quick: { model: 'haiku', effort: 'low' },
  standard: { model: 'sonnet', effort: 'medium' },
  deep: { model: 'opus', effort: 'high' },
  max: { model: 'opus', effort: 'xhigh' },
}
const RANK: Record<string, number> = { haiku: 0, sonnet: 1, opus: 2 }

const DEEP =
  /\b(architect\w*|design\w*|refactor\w*|migrat\w*|debug\w*|investigat\w*|root cause|race condition|deadlock|memory leak|security|vulnerab\w*|perf(ormance)?|optimi[sz]\w*|plan|strategy|from scratch|build (me|a|an|the)|implement\w*|end[- ]to[- ]end|across (the )?(codebase|repo|project)|why (does|is|do|did)|complex|tricky|concurren\w*|algorithm|schema|scal(e|ing|able))\b/i
const QUICK =
  /^(what('s| is| does)|where('s| is)|how do i|rename|typo|format|lint|show|list|run|commit|push|pull|yes|no|ok(ay)?|thanks|ty|continue|go( on)?|do it|lgtm|ship it|undo|revert|install|bump)\b/i

// Large contexts make a model switch re-cache everything, so only switch up there.
const STICKY_TOKENS = 40_000

const LABELS = ['quick', 'standard', 'deep'] as const

async function judge($: EngineInterface, text: string): Promise<{ tier: Tier; why: string }> {
  const words = text.trim().split(/\s+/).length
  const isDeep = DEEP.test(text)
  if (words > 120) return { tier: 'deep', why: 'long ask' }
  if (isDeep) return { tier: 'deep', why: `"${text.match(DEEP)?.[0]}"` }
  if (words <= 6) return { tier: 'quick', why: 'short ask' }
  if (QUICK.test(text.trim()) && words <= 25) return { tier: 'quick', why: 'simple ask' }
  try {
    const label = await Promise.race([
      $.model.classify(
        `Rate the coding task's complexity. quick = trivial lookup/one-liner, standard = normal edit or feature, deep = multi-file, architecture, hard debugging.\n\nTask: ${text.slice(0, 2000)}`,
        LABELS,
        { model: 'haiku' },
      ),
      $.clock.sleep(2500).then(() => undefined),
    ])
    if (label === 'quick' || label === 'standard' || label === 'deep') {
      return { tier: label, why: 'haiku judged' }
    }
  } catch {}
  return { tier: 'standard', why: 'default' }
}

// ---------- xp ----------

const TITLES = [
  'Prompt Gremlin',
  'Copy-Paste Apprentice',
  'Vibe Coder',
  'Agent Wrangler',
  'Token Whisperer',
  'Swarm Commander',
  '10x Slacker',
  'Autopilot Overlord',
]
const levelOf = (n: number) => Math.floor(Math.sqrt(n / 50)) + 1
const titleOf = (level: number) => TITLES[Math.min(level - 1, TITLES.length - 1)]

async function gain($: EngineInterface, points: number) {
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const before = await read($, xp)
  const yesterday = new Date(Date.parse(day) - 86_400_000).toISOString().slice(0, 10)
  const streak =
    before.lastDay === day ? before.streak : before.lastDay === yesterday ? before.streak + 1 : 1
  const next: Xp = { xp: before.xp + points, streak, lastDay: day }
  await update($, xp, () => next)
  await $.store.set(STORE_XP, next)
  const level = levelOf(next.xp)
  if (level > levelOf(before.xp)) {
    $.ui.toast(`🎉 Level ${level}: ${titleOf(level)}`)
  }
}

// ---------- live readings ----------

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

async function refreshHud($: EngineInterface) {
  const usage = await $.session.usage()
  const top = [...usage.rateLimits].sort((a, b) => b.percentUsed - a.percentUsed)[0]
  const next: Hud = {
    ratePct: top ? Math.round(top.percentUsed) : null,
    rateKind: top ? top.kind.replace('_hour', 'h').replace('seven_day', '7d').replace('five', '5') : '',
    costUsd: usage.cost?.usd ?? null,
    contextPct: usage.context.percent != null ? Math.round(usage.context.percent) : null,
  }
  if (!same(await read($, hud), next)) await update($, hud, () => next)
}

async function refreshAgents($: EngineInterface) {
  const list = await $.agent.list()
  const rows: AgentRow[] = list.slice(-10).map(a => ({
    id: a.id,
    description: a.description,
    type: a.type,
    status: a.status,
  }))
  if (!same(await read($, agents), rows)) await update($, agents, () => rows)
}

let repoInFlight = false
async function refreshRepo($: EngineInterface) {
  if (repoInFlight) return
  repoInFlight = true
  try {
    const next: Repo = { ...NO_REPO }
    const st = await $.process.run(['git', 'status', '--porcelain=v2', '--branch'], { timeoutMs: 5000 })
    if (st.exitCode === 0) {
      next.isRepo = true
      for (const line of st.stdout.split('\n')) {
        if (line.startsWith('# branch.head ')) next.branch = line.slice(14)
        else if (line.startsWith('# branch.ab ')) {
          const [a = '0', b = '0'] = line.slice(12).split(' ')
          next.ahead = Math.abs(Number(a))
          next.behind = Math.abs(Number(b))
        } else if (/^[12u] /.test(line)) {
          if (line[2] !== '.') next.staged += 1
          if (line[3] !== '.') next.modified += 1
        } else if (line.startsWith('? ')) next.untracked += 1
      }
      const log = await $.process.run(['git', 'log', '-1', '--format=%ct%x09%s'], { timeoutMs: 5000 })
      const [ct, ...subject] = log.stdout.trim().split('\t')
      if (log.exitCode === 0 && ct) {
        next.lastCommit = subject.join('\t')
        next.lastCommitAt = Number(ct) * 1000
      }
    }
    if (!same(await read($, repo), next)) await update($, repo, () => next)
  } catch {
  } finally {
    repoInFlight = false
  }
}

async function refreshTheme($: EngineInterface) {
  const row = (await $.config.list()).find(one => one.key === 'theme')
  const dark = !String(row?.value ?? 'dark').includes('light')
  if ((await read($, isDark)) !== dark) await update($, isDark, () => dark)
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')
const firstLine = (text: string) =>
  text
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !/^(error|exit code \d+):?$/i.test(l)) ?? text.trim()

function detailOf(tool: string, a: Record<string, unknown>): string {
  if (tool === 'Bash') return str(a.command).split('\n')[0] ?? ''
  if (tool === 'Agent') return str(a.description)
  if (tool === 'Grep' || tool === 'Glob') return str(a.pattern)
  if (tool === 'WebFetch') return str(a.url)
  if (tool === 'WebSearch') return str(a.query)
  if (tool === 'Skill') return str(a.skill)
  const path = str(a.file_path) || str(a.notebook_path) || str(a.path)
  return path ? path.split('/').pop() ?? path : ''
}

const EDITS = new Set(['Edit', 'Write', 'NotebookEdit'])
const MUTATES = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit'])

// ---------- formatting ----------

const isLive = (s: string) => s === 'running' || s === 'pending' || s === 'waiting'
// A meter as colored runs: filled cells take the ramp by position, so a hot
// reading crosses from green into amber and red as it fills.
function segments(pct: number, width: number, ramp: string[], empty: string) {
  const n = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))
  const out: { text: string; color: string }[] = []
  for (let i = 0; i < width; i++) {
    const on = i < n
    const color = on ? ramp[Math.min(ramp.length - 1, Math.floor((i / width) * ramp.length))]! : empty
    const last = out[out.length - 1]
    if (last && last.color === color) last.text += on ? '━' : '─'
    else out.push({ text: on ? '━' : '─', color })
  }
  return out
}

// ---------- palette ----------

type Palette = Record<'violet' | 'pink' | 'cyan' | 'blue' | 'green' | 'amber' | 'red' | 'muted' | 'faint' | 'ink' | 'bg' | 'card' | 'text', string>
// Bright pastels read on a dark ground; deeper, saturated tones on a light one.
const DARK: Palette = {
  violet: '#A78BFA',
  pink: '#F472B6',
  cyan: '#22D3EE',
  blue: '#60A5FA',
  green: '#4ADE80',
  amber: '#FBBF24',
  red: '#F87171',
  muted: '#94A3B8',
  faint: '#64748B',
  ink: '#0F0A1F',
  bg: '#13111F',
  card: '#1E1A33',
  text: '#E8E6F5',
}
const LIGHT: Palette = {
  violet: '#7C3AED',
  pink: '#DB2777',
  cyan: '#0891B2',
  blue: '#2563EB',
  green: '#16A34A',
  amber: '#D97706',
  red: '#DC2626',
  muted: '#64748B',
  faint: '#A1AEC2',
  ink: '#FFFFFF',
  bg: '#FBF9FF',
  card: '#F1ECFF',
  text: '#1E1B2E',
}
const paletteOf = (dark: boolean) => (dark ? DARK : LIGHT)
const heatOf = (p: Palette, pct: number) => (pct >= 80 ? p.red : pct >= 50 ? p.amber : p.green)
// Cycles once a second while working, so the spinner and hero border breathe.
const pulse = (p: Palette, t: number) => [p.violet, p.pink, p.cyan][Math.floor(t / 1000) % 3]!
const modeColor = (p: Palette, m: Mode) =>
  ({ auto: p.violet, opus: p.pink, sonnet: p.cyan, haiku: p.green, off: p.muted })[m]
const modelColor = (p: Palette, name: string) =>
  ({ opus: p.pink, sonnet: p.cyan, haiku: p.green, fable: p.amber } as Record<string, string>)[name] ?? p.muted
const statusColor = (p: Palette, s: string) =>
  isLive(s) ? p.violet : s === 'completed' ? p.green : /fail|kill|error/.test(s) ? p.red : p.muted

// ---------- wire: messages moving between sessions and agents ----------

// A flow animates for FRESH_MS, a packet crossing its track every CROSS_MS.
const FRESH_MS = 6000
const CROSS_MS = 1400
const isFresh = (f: Flow, t: number) => t - f.at < FRESH_MS
const nick = (s: string, n = 12) => (s.length > n ? s.slice(0, n - 1) + '…' : s)
const flowColor = (p: Palette, k: Flow['kind']) =>
  ({ spawn: p.violet, send: p.cyan, handback: p.green, receive: p.pink })[k]
const FLOW_ICON: Record<Flow['kind'], string> = { spawn: '⊕ spawn', send: '✉ message', handback: '↩ hand-back', receive: '⇠ from peer' }

// A comet: head, two-cell tail, then the faint rail; settled flows draw a still rail.
function track(f: Flow, t: number, width: number, p: Palette) {
  const c = flowColor(p, f.kind)
  if (!isFresh(f, t)) return [{ text: '─'.repeat(width - 1) + '▸', color: p.faint }]
  const head = Math.floor((((t - f.at) % CROSS_MS) / CROSS_MS) * (width - 1))
  const out: { text: string; color: string }[] = []
  for (let i = 0; i < width; i++) {
    const [ch, color] =
      i === width - 1 ? ['▸', c] : i === head ? ['●', c] : i === head - 1 ? ['•', c] : i === head - 2 ? ['·', c] : ['─', p.faint]
    const last = out[out.length - 1]
    if (last && last.color === color) last.text += ch
    else out.push({ text: ch, color })
  }
  return out
}

let flowSeq = 0
async function nameOf($: EngineInterface, agentId?: string) {
  if (!agentId) return 'main'
  const a = (await $.agent.list()).find(x => x.id === agentId)
  return a?.name || a?.description || agentId.slice(0, 6)
}
async function addFlow($: EngineInterface, f: Omit<Flow, 'id' | 'at'>) {
  const at = await $.clock.now()
  // The same message can surface twice (a hand-back is a turn end and a delivery).
  await update($, flows, list =>
    list.some(o => o.from === f.from && o.to === f.to && at - o.at < 3000)
      ? list
      : [{ ...f, id: `${at}-${(flowSeq += 1)}`, at }, ...list].slice(0, 8),
  )
  await update($, now, () => at)
}
const dur = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(s / 3600)}h ${String(Math.floor(s / 60) % 60).padStart(2, '0')}m`
}
const ago = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 10) return 'now'
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}
const modelName = (id: string) => id.match(/opus|sonnet|haiku|fable/i)?.[0].toLowerCase() ?? id
const tok = (n: number) =>
  n < 1000 ? `${n}` : n < 1_000_000 ? `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k` : `${(n / 1_000_000).toFixed(1)}M`

// $ per million tokens, Anthropic API list prices (2026-10). Cache writes are
// 1.25x input; Haiku's cache read assumed at the usual 0.1x input.
const RATES: Record<string, { in: number; out: number; read: number }> = {
  fable: { in: 10, out: 50, read: 0.25 },
  opus: { in: 4, out: 20, read: 0.2 },
  sonnet: { in: 2, out: 10, read: 0.2 },
  haiku: { in: 0.1, out: 0.5, read: 0.01 },
}
const usd = (n: number) => (n < 0.01 ? '<$0.01' : n < 10 ? `$${n.toFixed(2)}` : `$${n.toFixed(1)}`)

async function addSpend(
  $: EngineInterface,
  agentId: string,
  model: string,
  usage?: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number } | null,
) {
  await update($, spend, all => {
    const was: AgentSpend = all[agentId] ?? { model: '', tokensIn: 0, tokensOut: 0, usd: 0, opusUsd: 0 }
    const priced = (rate?: { in: number; out: number; read: number }) =>
      usage && rate
        ? (usage.input_tokens * rate.in +
            usage.cache_creation_input_tokens * rate.in * 1.25 +
            usage.cache_read_input_tokens * rate.read +
            usage.output_tokens * rate.out) /
          1_000_000
        : 0
    const cost = priced(RATES[modelName(model || was.model)])
    const next: AgentSpend = {
      model: model || was.model,
      usd: was.usd + cost,
      // What the same tokens would have cost on Opus: the delegation saving.
      opusUsd: was.opusUsd + priced(RATES.opus),
      tokensIn:
        was.tokensIn +
        (usage ? usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens : 0),
      tokensOut: was.tokensOut + (usage?.output_tokens ?? 0),
    }
    // Keep the 30 newest agents' rows.
    const kept = Object.entries(all).filter(([id]) => id !== agentId).slice(-29)
    return Object.fromEntries([...kept, [agentId, next]])
  })
}

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const spin = (t: number) => SPIN[Math.floor(t / 1000) % SPIN.length]

// Light text on a dark ground blooms and reads heavier; dark text on a light
// ground thins out. So step every weight down on dark and up on light.
const typeFor = (dark: boolean) =>
  dark
    ? ({ title: 'semibold', head: 'medium', body: 'regular' } as const)
    : ({ title: 'bold', head: 'semibold', body: 'medium' } as const)

const MODES: Mode[] = ['auto', 'opus', 'sonnet', 'haiku', 'off']
const short = (t: Tier) => ({ quick: 'quick', standard: 'std', deep: 'deep', max: 'MAX' })[t]

type Action = { key: string; hotkey: string; label: string; prompt: string }
const ACTIONS: Action[] = [
  { key: 'commit', hotkey: 'c', label: 'commit', prompt: 'Commit the current changes with a concise message. Do not push.' },
  { key: 'test', hotkey: 't', label: 'test', prompt: "Run this project's tests. If any fail, fix them." },
  { key: 'review', hotkey: 'r', label: 'review', prompt: 'Review my uncommitted diff for real bugs only. Be brief.' },
  { key: 'push', hotkey: 'p', label: 'push', prompt: 'Push the current branch to its remote.' },
]

async function act($: EngineInterface, a: Action) {
  await $.prompt.submit({ text: a.prompt, asUser: true })
  $.ui.toast(`↪ ${a.label}`)
}

// Opus thinks, cheaper models type. Only the main loop gets this: it is the
// one that holds the Agent tool.
const CTO_TEXT = `# Delegation: you are the CTO (set by the user's autopilot mod)
You are running on Opus, the expensive model. Spend Opus on judgment, not on typing.
1. Do the brain work yourself: read just enough to understand the ask, find the root cause, decide the design and the exact plan.
2. Break the plan into small, well-directed tasks. Each task names the files, the exact change or question, the constraints, and how to verify it is done.
3. Hand execution to cheaper subagents with the Agent tool, passing \`model\`: "sonnet" for edits, features and tests; "haiku" for searches, lookups, renames and mechanical changes. Write each prompt so a junior engineer with no context could finish it.
4. Launch independent tasks in parallel (several Agent calls in one message); run dependent ones in order.
5. Review what comes back, fix or redirect anything off-target, and give the user the result.
Do it yourself without delegating when the whole job is a few small steps, or when explaining it would cost more than doing it.`

const TLDR_TEXT = `# Output style: TL;DR (set by the user's autopilot mod)
The user skims and dislikes reading. For every reply:
- First line: the answer or the result, in one sentence.
- Then at most 5 short bullets, only if they add something.
- No preamble, no restating the question, no recap of steps unless asked, no closing offers.
- Prefer showing a command or a code block over describing it.`

export const register: Register = on => {
  let cwd = ''

  const rel = (path: string) => (cwd && path.startsWith(cwd + '/') ? path.slice(cwd.length + 1) : path)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'ap',
      description: 'Mission control pane, or set mode: auto | opus | sonnet | haiku | off | tldr | cto',
      argumentHint: '[auto|opus|sonnet|haiku|off|tldr|cto]',
    })
    cwd = await $.session.cwd()
    const saved = (await $.store.get(STORE_XP)) as Xp | undefined
    if (saved && typeof saved.xp === 'number') await update($, xp, () => saved)
    // A reload mid-turn would otherwise leave a stale "working" row.
    await update($, live, l => ({ ...l, busy: false, tool: '', detail: '' }))
    {
      const t = await $.clock.now()
      await update($, now, () => t)
    }

    // One heartbeat: the clock every second while working, every 15s idle;
    // usage while working, agents and git on slower beats.
    let beat = 0
    $.clock.every(1000, async () => {
      beat += 1
      const isBusy = (await read($, live)).busy
      if (isBusy || beat % 15 === 0) {
        const t = await $.clock.now()
        await update($, now, () => t)
      }
      if (isBusy && beat % 3 === 0) void refreshHud($)
      if (beat % 4 === 0) void refreshAgents($)
      if (beat % 8 === 0) void refreshRepo($)
    })
    // Animation frames, only while a message is in flight.
    $.clock.every(200, async () => {
      const t = await $.clock.now()
      if ((await read($, flows)).some(f => t - f.at < FRESH_MS + 400)) await update($, now, () => t)
    })
    void refreshHud($)
    void refreshRepo($)
    void refreshTheme($)
    void $.ui.open({ id: PANE, title: TITLE })
    return next(e)
  })

  on('config.set', { key: 'theme' }, async ($, e, next) => {
    const result = await next(e)
    void refreshTheme($).catch(() => {})
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'ap' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if ((MODES as string[]).includes(arg)) {
      await update($, mode, () => arg as Mode)
      return { text: `Autopilot: ${arg}` }
    }
    if (arg === 'cto') {
      const isOn = await update($, cto, v => !v)
      return { text: `CTO mode (Opus plans, cheaper agents execute) ${isOn ? 'on' : 'off'}` }
    }
    if (arg === 'tldr') {
      const isOn = await update($, tldr, v => !v)
      return { text: `TL;DR replies ${isOn ? 'on' : 'off'}` }
    }
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Autopilot pane opened.' }
  })

  // Pick the tier for each prompt you type. `++` forces max brain, `--` forces quick.
  on('prompt.submit', async ($, e, next) => {
    if (e.command || e.isMeta || e.origin.kind !== 'composer' || !e.text.trim()) return next(e)
    if ((await read($, mode)) !== 'auto') return next(e)

    let text = e.text
    let pick: { tier: Tier; why: string }
    if (text.startsWith('++')) {
      text = text.slice(2).trimStart()
      pick = { tier: 'max', why: '++ forced' }
    } else if (text.startsWith('--')) {
      text = text.slice(2).trimStart()
      pick = { tier: 'quick', why: '-- forced' }
    } else {
      pick = await judge($, text)
    }

    let { model, effort } = TIERS[pick.tier]
    let why = pick.why
    const prev = await read($, route)
    const tokens = (await $.session.usage()).context.tokens ?? 0
    if (prev && tokens > STICKY_TOKENS && (RANK[model] ?? 1) < (RANK[prev.model] ?? 1) && !why.includes('forced')) {
      model = prev.model
      why += ', kept model (cache)'
    }
    const r: Route = { tier: pick.tier, model, effort, why }
    await update($, route, () => r)
    await update($, stats, s => ({ ...s, [pick.tier]: s[pick.tier] + 1 }))
    $.ui.status(`✈ ${model}·${effort}`)

    return next(text === e.text ? e : { ...e, text })
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const t = await $.clock.now()
      await update($, live, l => ({ ...l, busy: true, turnStartedAt: t, tools: 0, tool: '', detail: '' }))
      await update($, now, () => t)
    }
    return next(e)
  })

  // Apply the pick to every request of the main loop.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) {
      const res = yield* next(e)
      await addSpend($, e.agentId, res.usage?.model ?? e.model, res.usage)
      return res
    }
    const m = await read($, mode)
    if (m === 'off') return yield* next(e)
    if (m !== 'auto') return yield* next({ ...e, model: m })
    const r = await read($, route)
    if (!r) return yield* next(e)
    return yield* next({ ...e, model: r.model, effort: r.effort })
  })

  // Cheap agents for cheap jobs, unless the caller named a model.
  const AGENT_MODEL: Record<string, string> = {
    Explore: 'haiku',
    'claude-code-guide': 'haiku',
    'statusline-setup': 'haiku',
    Plan: 'opus',
  }
  // Under CTO mode a delegated worker the caller left unpinned runs on sonnet.
  const WORKERS = new Set(['general-purpose', 'claude'])
  on('agent.spawn', async ($, e, next) => {
    if (e.model !== undefined) return next(e)
    const m = await read($, mode)
    const pick =
      m === 'auto' ? AGENT_MODEL[e.subagentType] : undefined
    const worker = WORKERS.has(e.subagentType) && m !== 'off' && (await read($, cto)) ? 'sonnet' : undefined
    const model = pick ?? worker
    const spawned = await next(model ? { ...e, model } : e)
    if (spawned.agentId) {
      await addSpend($, spawned.agentId, spawned.model ?? '')
      await addFlow($, { kind: 'spawn', from: await nameOf($, e.parentAgentId), to: e.description, label: e.subagentType })
    }
    return spawned
  })

  on('session.send', async ($, e, next) => {
    const sent = await next(e)
    if (sent.isDelivered) {
      const to = (await $.agent.list()).find(a => a.id === e.to || a.name === e.to)
      await addFlow($, {
        kind: 'send',
        from: await nameOf($, e.agentId),
        to: to?.description ?? e.to,
        label: firstLine(e.text).slice(0, 80),
      })
    }
    return sent
  })

  on('session.receive', async ($, e, next) => {
    const result = await next(e)
    const k = e.origin.kind
    if (e.agentId === undefined && (k === 'peer' || k === 'peer-send-message')) {
      const from = (await $.agent.list()).find(a => e.text.includes(a.id))
      await addFlow($, {
        kind: from ? 'handback' : 'receive',
        from: from?.description ?? 'peer',
        to: 'main',
        label: firstLine(e.text).slice(0, 80),
      })
    }
    return result
  })

  // Every call feeds the pane: what runs now, what it touched, how it ended.
  on('tool.call', async ($, e, next) => {
    const isMain = e.agentId === undefined
    const args = e as unknown as Record<string, unknown>
    const t0 = await $.clock.now()
    if (isMain) {
      await update($, live, l => ({
        ...l,
        busy: true,
        tool: e.tool,
        detail: detailOf(e.tool, args),
        toolStartedAt: t0,
        tools: l.tools + 1,
      }))
    }

    const ran = await next(e)

    const t1 = await $.clock.now()
    const failed = ran.isError === true
    await update($, metrics, mt => ({
      ...mt,
      tools: mt.tools + 1,
      toolErrors: mt.toolErrors + (failed ? 1 : 0),
      edits: mt.edits + (!failed && EDITS.has(e.tool) ? 1 : 0),
    }))
    if (isMain) {
      await update($, live, l => (l.toolStartedAt === t0 ? { ...l, tool: '', detail: '', toolStartedAt: 0 } : l))
    }
    if (failed) {
      const err: LastError = { tool: e.tool, text: firstLine(ran.text ?? '').slice(0, 300), at: t1 }
      await update($, lastError, () => err)
    }
    if (isMain && e.tool === 'Bash') {
      const run: LastRun = {
        command: str(args.command).split('\n')[0] ?? '',
        ok: !failed,
        ms: t1 - t0,
        at: t1,
        error: failed ? firstLine(ran.text ?? '').slice(0, 300) : '',
      }
      await update($, lastRun, () => run)
    }
    if (!failed && EDITS.has(e.tool)) {
      const path = rel(str(args.file_path) || str(args.notebook_path))
      if (path) {
        await update($, files, list => {
          const hit = list.find(f => f.path === path)
          const row: FileRow = { path, edits: (hit?.edits ?? 0) + 1, at: t1 }
          return [row, ...list.filter(f => f.path !== path)].slice(0, 30)
        })
      }
    }
    if (MUTATES.has(e.tool)) void refreshRepo($)
    return ran
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined) {
      const ok = !e.isAborted && e.reason !== 'refusal'
      await update($, metrics, mt => ({
        ...mt,
        agentsDone: mt.agentsDone + (ok ? 1 : 0),
        agentsFailed: mt.agentsFailed + (ok ? 0 : 1),
        agentMs: mt.agentMs + e.durationMs,
      }))
      if (!e.isAborted) {
        const a = (await $.agent.list()).find(x => x.id === e.agentId)
        const sp = (await read($, spend))[e.agentId]
        const cost = sp ? ` · ${modelName(sp.model)} · ${tok(sp.tokensIn + sp.tokensOut)} tok · ${usd(sp.usd)}` : ''
        $.ui.toast(`🤖 done: ${a?.description ?? 'agent'}${cost}`)
        await addFlow($, { kind: 'handback', from: a?.description ?? 'agent', to: 'main', label: 'result handed back' })
        await gain($, 15)
      }
      await refreshAgents($)
      return result
    }
    const before = await read($, live)
    await update($, metrics, mt => ({ ...mt, turns: mt.turns + 1, turnMs: mt.turnMs + e.durationMs }))
    await update($, live, l => ({ ...l, busy: false, tool: '', detail: '', lastTurnMs: e.durationMs }))
    {
      const t = await $.clock.now()
      await update($, now, () => t)
    }
    void refreshHud($)
    void refreshRepo($)
    if (e.isAborted) return result
    await gain($, 10 + Math.min(before.tools, 20))
    const secs = Math.round(e.durationMs / 1000)
    if (secs >= 45) {
      const line = e.answer.split('\n').find(l => l.trim()) ?? 'Turn finished'
      await $.ui.notify(line.slice(0, 140), { title: `✅ Claude done (${secs}s)` })
    }
    return result
  })

  on('prompt.compose', async ($, e, next) => {
    const result = await next(e)
    const sections = [...result.sections]
    const isCto = /opus/i.test(e.model) && e.tools.includes('Agent') && (await read($, cto))
    if (isCto) sections.push({ id: 'autopilot:cto', text: CTO_TEXT, scope: 'session' as const })
    if (await read($, tldr)) sections.push({ id: 'autopilot:tldr', text: TLDR_TEXT, scope: 'session' as const })
    return { sections }
  })

  // ---------- band: one glanceable line, live while working ----------
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Text, Button } = $.ui.resolve(e)
    const [m, r, usage, x, list, l, t, rp, isTldr, dark, wire] = await Promise.all([
      read($, mode),
      read($, route),
      read($, hud),
      read($, xp),
      read($, agents),
      read($, live),
      read($, now),
      read($, repo),
      read($, tldr),
      read($, isDark),
      read($, flows),
    ])
    const p = paletteOf(dark)
    const flying = wire.find(f => isFresh(f, t))
    const running = list.filter(a => isLive(a.status)).length
    const wide = (e.props.bodyColumns ?? 80) >= 100
    const level = levelOf(x.xp)
    const dirty = rp.staged + rp.modified + rp.untracked
    const sep = <Text color={p.faint}> • </Text>

    const brain =
      m === 'auto' ? (r ? `${r.model}·${short(r.tier)}` : 'auto') : m === 'off' ? 'off' : `${m} 📌`

    return (
      <Box flexDirection="row">
        {l.busy && (
          <Text>
            <Text color={pulse(p, t)}>{spin(t)} </Text>
            <Text color={p.violet} weight="semibold">
              {l.tool || 'thinking'}
            </Text>
            {wide && l.detail ? <Text color={p.muted}> {l.detail.slice(0, 28)}</Text> : ''}
            <Text color={p.cyan} tabular>
              {' '}
              {dur(t - l.turnStartedAt)}
            </Text>
            {sep}
          </Text>
        )}
        {flying && (
          <Text>
            <Text color={flowColor(p, flying.kind)}>{nick(flying.from, 8)} </Text>
            {track(flying, t, 6, p).map(g => (
              <Text color={g.color}>{g.text}</Text>
            ))}
            <Text color={flowColor(p, flying.kind)}> {nick(flying.to, 8)}</Text>
            {sep}
          </Text>
        )}
        <Button key="mode" plain onPress={() => update($, mode, v => MODES[(MODES.indexOf(v) + 1) % MODES.length] ?? 'auto')}>
          <Text backgroundColor={modeColor(p, m)} color={p.ink} weight="bold">
            {' ✈ '}
            {brain}{' '}
          </Text>
        </Button>
        {sep}
        <Text color={running ? p.green : p.muted}>🤖 {running}</Text>
        {usage.ratePct != null && (
          <Text>
            {sep}
            <Text color={p.muted}>{usage.rateKind} </Text>
            <Text color={heatOf(p, usage.ratePct)} weight="semibold">
              {usage.ratePct}%
            </Text>
          </Text>
        )}
        {usage.contextPct != null && wide && (
          <Text>
            {sep}
            <Text color={p.muted}>ctx </Text>
            <Text color={p.cyan}>{usage.contextPct}%</Text>
          </Text>
        )}
        {rp.isRepo && (
          <Text>
            {sep}
            <Text color={p.amber}>⎇ {rp.branch.slice(0, 18)}</Text>
            {dirty ? <Text color={p.pink}> ●{dirty}</Text> : ''}
          </Text>
        )}
        {wide && (
          <Text>
            {sep}
            <Text color={p.violet} weight="semibold">
              Lv{level}
            </Text>
            {x.streak > 1 ? <Text color={p.amber}> 🔥{x.streak}d</Text> : ''}
          </Text>
        )}
        <Text>  </Text>
        <Button key="tldr" plain onPress={() => update($, tldr, v => !v)}>
          <Text color={isTldr ? p.green : p.muted}>{isTldr ? 'tl;dr ✓' : 'tl;dr ✗'}</Text>
        </Button>
        <Text> </Text>
        <Button key="open" plain onPress={() => $.ui.open({ id: PANE, title: TITLE })}>
          <Text color={p.cyan}>⧉</Text>
        </Button>
      </Box>
    )
  })

  // ---------- pane: mission control ----------
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const [m, r, s, usage, x, list, isTldr, l, t, rp, fl, run, err, dark, isCto, sp, mt, wire] = await Promise.all([
      read($, mode),
      read($, route),
      read($, stats),
      read($, hud),
      read($, xp),
      read($, agents),
      read($, tldr),
      read($, live),
      read($, now),
      read($, repo),
      read($, files),
      read($, lastRun),
      read($, lastError),
      read($, isDark),
      read($, cto),
      read($, spend),
      read($, metrics),
      read($, flows),
    ])
    const w = e.props.bodyColumns ?? 40
    const p = paletteOf(dark)
    const ty = typeFor(dark)
    // A meter row is a 4-cell label, the bar, then " 100%".
    const barW = Math.max(6, Math.min(20, w - 12))
    const level = levelOf(x.xp)
    const floor = 50 * (level - 1) ** 2
    const ceil = 50 * level ** 2
    const total = s.quick + s.standard + s.deep + s.max
    const dirty = rp.staged + rp.modified + rp.untracked
    const showErr = err && (!run || err.at >= run.at) ? err : null

    // Section headers are solid pills, each section its own hue.
    const eyebrow = (label: string, color: string, aside?: string) => (
      <Text size="caption">
        <Text backgroundColor={color} color={p.ink} weight="bold">
          {' '}
          {label}{' '}
        </Text>
        {aside ? (
          <Text color={p.muted}>
            {'  '}
            {aside}
          </Text>
        ) : (
          ''
        )}
      </Text>
    )
    const meter = (pct: number, ramp: string[]) =>
      segments(pct, barW, ramp, p.faint).map(g => <Text color={g.color}>{g.text}</Text>)
    const heatRamp = [p.green, p.green, p.amber, p.red]
    const toggle = (isOn: boolean) =>
      isOn ? (
        <Text backgroundColor={p.green} color={p.ink} weight="bold">
          {' on '}
        </Text>
      ) : (
        <Text color={p.muted}> off </Text>
      )

    const actions = ACTIONS.filter(a =>
      a.key === 'push' ? rp.isRepo && rp.ahead > 0 : a.key === 'test' || (rp.isRepo && dirty > 0),
    )

    return (
      <Box flexDirection="column" gap={1} backgroundColor={p.bg} paddingX={1} paddingY={1}>
        {/* NOW: the one thing to look at, in a card whose border breathes while working */}
        {l.busy ? (
          <Box flexDirection="column" borderStyle="round" borderColor={pulse(p, t)} paddingX={1} backgroundColor={p.card}>
            <Text size="heading" weight={ty.title}>
              <Text color={pulse(p, t)}>{spin(t)} </Text>
              <Text color={p.violet}>Working </Text>
              <Text tabular color={p.cyan}>
                {dur(t - l.turnStartedAt)}
              </Text>
              <Text size="footnote" weight={ty.body} color={p.muted}>
                {'  '}
                {l.tools} tool{l.tools === 1 ? '' : 's'}
              </Text>
            </Text>
            {l.tool ? (
              <Text wrap="truncate-end">
                <Text weight={ty.head} color={p.pink}>
                  {l.tool}
                </Text>{' '}
                <Text mono color={p.muted}>
                  {l.detail}
                </Text>{' '}
                <Text tabular color={p.cyan}>
                  {dur(t - l.toolStartedAt)}
                </Text>
              </Text>
            ) : (
              <Text color={p.muted} italic>
                thinking…
              </Text>
            )}
          </Box>
        ) : (
          <Box flexDirection="column" borderStyle="round" borderColor={p.green} paddingX={1} backgroundColor={p.card}>
            <Text size="heading" weight={ty.title} color={p.green}>
              ✦ Ready
            </Text>
            <Text size="footnote" color={p.muted}>
              {l.lastTurnMs != null ? `last turn ${dur(l.lastTurnMs)} · ${l.tools} tools` : 'waiting for your first prompt'}
            </Text>
          </Box>
        )}

        {/* WIRE: messages between the main loop, agents and sessions, animated in flight */}
        {wire.length > 0 &&
          (() => {
            const inFlight = wire.filter(f => isFresh(f, t)).length
            const trackW = Math.max(4, Math.min(16, w - 30))
            return (
              <Box flexDirection="column">
                {eyebrow('WIRE', inFlight ? pulse(p, t) : p.muted, inFlight ? `${inFlight} in flight` : 'quiet')}
                {wire.slice(0, 5).map(f => {
                  const c = isFresh(f, t) ? flowColor(p, f.kind) : p.muted
                  return (
                    <Box key={`flow-${f.id}`} flexDirection="column">
                      <Text wrap="truncate-end">
                        <Text color={c} weight={ty.head}>
                          {nick(f.from)}{' '}
                        </Text>
                        {track(f, t, trackW, p).map(g => (
                          <Text color={g.color}>{g.text}</Text>
                        ))}
                        <Text color={c} weight={ty.head}>
                          {' '}
                          {nick(f.to)}
                        </Text>
                      </Text>
                      <Text color={p.muted} wrap="truncate-end">
                        {'  '}
                        <Text color={c}>{FLOW_ICON[f.kind]}</Text> {f.label} · {ago(t - f.at)}
                      </Text>
                    </Box>
                  )
                })}
              </Box>
            )
          })()}

        {/* QUICK: one key, no typing */}
        {!l.busy && (
          <Box flexDirection="column" gap={1}>
            {eyebrow('QUICK', p.pink)}
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              {showErr && (
                <Button
                  key="act-fix"
                  hotkey="f"
                  variant="primary"
                  label="fix error"
                  onPress={() =>
                    act($, {
                      key: 'fix',
                      hotkey: 'f',
                      label: 'fix error',
                      prompt: `Fix this error from ${showErr.tool}: ${showErr.text}`,
                    })
                  }
                />
              )}
              {actions.map(a => (
                <Button key={`act-${a.key}`} hotkey={a.hotkey} label={a.label} onPress={() => act($, a)} />
              ))}
            </Box>
          </Box>
        )}

        {/* LAST RUN */}
        {(run || showErr) && (
          <Box flexDirection="column">
            {eyebrow('LAST RUN', p.cyan, run ? `${dur(run.ms)} · ${ago(t - run.at)}` : undefined)}
            {run && (
              <Text wrap="truncate-end">
                <Text color={run.ok ? p.green : p.red} weight={ty.head}>
                  {run.ok ? '✓ ' : '✗ '}
                </Text>
                <Text mono color={p.text}>{run.command}</Text>
              </Text>
            )}
            {showErr && (
              <Text color={p.red} wrap="truncate-end">
                ↳ {showErr.tool !== 'Bash' ? `${showErr.tool}: ` : ''}
                {showErr.text}
              </Text>
            )}
          </Box>
        )}

        {/* REPO */}
        <Box flexDirection="column">
          {eyebrow('REPO', p.amber)}
          {rp.isRepo ? (
            <Box flexDirection="column">
              <Text wrap="truncate-end">
                <Text weight={ty.head} color={p.amber}>
                  ⎇ {rp.branch}
                </Text>
                {rp.ahead > 0 && <Text color={p.cyan}> ↑{rp.ahead}</Text>}
                {rp.behind > 0 && <Text color={p.pink}> ↓{rp.behind}</Text>}
              </Text>
              <Text>
                {dirty === 0 && <Text color={p.green}>✓ clean</Text>}
                {rp.staged > 0 && <Text color={p.green}>+{rp.staged} staged  </Text>}
                {rp.modified > 0 && <Text color={p.amber}>~{rp.modified} changed  </Text>}
                {rp.untracked > 0 && <Text color={p.blue}>?{rp.untracked} new</Text>}
              </Text>
              {rp.lastCommit && (
                <Text color={p.muted} wrap="truncate-end">
                  “{rp.lastCommit}” · {ago(t - rp.lastCommitAt)}
                </Text>
              )}
            </Box>
          ) : (
            <Text color={p.muted}>not a git repo</Text>
          )}
        </Box>

        {/* FILES: press one to @mention it */}
        {fl.length > 0 && (
          <Box flexDirection="column">
            {eyebrow('TOUCHED', p.blue, 'press to @mention')}
            {fl.slice(0, 6).map(f => {
              const name = f.path.split('/').pop() ?? f.path
              const dir = f.path.slice(0, f.path.length - name.length)
              return (
                <Button
                  key={`file-${f.path}`}
                  plain
                  onPress={() => $.prompt.fill({ text: `@${f.path} `, mode: 'insert' })}
                >
                  <Text color={p.blue}>◆ </Text>
                  <Text weight={ty.head} color={p.text}>
                    {name}
                  </Text>
                  <Text mono color={p.muted}>
                    {dir ? ` ${dir.length > w - name.length - 16 ? '…' + dir.slice(-(w - name.length - 17)) : dir}` : ''}
                  </Text>
                  <Text tabular>
                    {f.edits > 1 ? <Text color={p.pink}> ×{f.edits}</Text> : ''}
                    <Text color={p.faint}> {ago(t - f.at)}</Text>
                  </Text>
                </Button>
              )
            })}
          </Box>
        )}

        {/* SCORECARD: is this session paying off? */}
        {(mt.turns > 0 || mt.agentsDone + mt.agentsFailed > 0) &&
          (() => {
            const all = Object.values(sp)
            const agentUsd = all.reduce((n, v) => n + v.usd, 0)
            const saved = all.reduce((n, v) => n + v.opusUsd, 0) - agentUsd
            const agents = mt.agentsDone + mt.agentsFailed
            const errPct = mt.tools ? Math.round((mt.toolErrors / mt.tools) * 100) : 0
            const byModel = all.reduce<Record<string, number>>((acc, v) => {
              const k = modelName(v.model) || '?'
              acc[k] = (acc[k] ?? 0) + 1
              return acc
            }, {})
            const cell = (label: string, value: string | ReturnType<typeof h>, color?: string) => (
              <Text tabular>
                <Text color={p.muted}>{label.padEnd(10)}</Text>
                <Text weight={ty.head} color={color ?? p.text}>
                  {value}
                </Text>
              </Text>
            )
            return (
              <Box flexDirection="column">
                {eyebrow('SCORECARD', p.green)}
                {mt.turns > 0 &&
                  cell('turns', `${mt.turns} · avg ${dur(mt.turnMs / mt.turns)} · ${mt.edits} edits`)}
                {mt.tools > 0 &&
                  cell(
                    'tools',
                    `${mt.tools} calls · ${errPct}% failed`,
                    errPct >= 20 ? p.red : errPct >= 10 ? p.amber : undefined,
                  )}
                {agents > 0 &&
                  cell(
                    'agents',
                    `${mt.agentsDone}/${agents} ok · avg ${dur(mt.agentMs / agents)}`,
                    mt.agentsFailed ? p.amber : p.green,
                  )}
                {all.length > 0 &&
                  cell(
                    'models',
                    <Text>
                      {Object.entries(byModel).map(([k, n], i) => (
                        <Text>
                          {i ? <Text color={p.faint}> · </Text> : ''}
                          <Text color={modelColor(p, k)}>
                            {n}× {k}
                          </Text>
                        </Text>
                      ))}
                    </Text>,
                  )}
                {agentUsd > 0 &&
                  cell('agent $', `${usd(agentUsd)}${agents ? ` · ${usd(agentUsd / agents)}/agent` : ''}`, p.amber)}
                {saved > 0.005 && cell('saved', `${usd(saved)} vs all-Opus ✨`, p.green)}
              </Box>
            )
          })()}

        {/* USAGE */}
        <Box flexDirection="column">
          {eyebrow('USAGE', p.pink, usage.costUsd != null ? `$${usage.costUsd.toFixed(2)} this session` : undefined)}
          {usage.ratePct != null ? (
            <Text tabular>
              <Text color={p.muted}>{usage.rateKind.padEnd(4)}</Text>
              {meter(usage.ratePct, heatRamp)}
              <Text color={heatOf(p, usage.ratePct)} weight={ty.head}>
                {' '}
                {usage.ratePct}%
              </Text>
            </Text>
          ) : (
            <Text color={p.muted}>no rate-limit reading yet</Text>
          )}
          {usage.contextPct != null && (
            <Text tabular>
              <Text color={p.muted}>{'ctx '}</Text>
              {meter(usage.contextPct, heatRamp)}
              <Text color={heatOf(p, usage.contextPct)} weight={ty.head}>
                {' '}
                {usage.contextPct}%
              </Text>
            </Text>
          )}
        </Box>

        {/* AGENTS */}
        {list.length > 0 && (
          <Box flexDirection="column">
            {eyebrow(
              'AGENTS',
              p.violet,
              (() => {
                const all = list.map(a => sp[a.id]).filter((v): v is AgentSpend => !!v)
                const sum = all.reduce((n, v) => n + v.tokensIn + v.tokensOut, 0)
                const dollars = all.reduce((n, v) => n + v.usd, 0)
                return sum ? `${usd(dollars)} · ${tok(sum)} tok · press to watch` : 'press to watch'
              })(),
            )}
            {list
              .slice()
              .reverse()
              .map(a => (
                <Box key={`agent-row-${a.id}`} flexDirection="column">
                  <Button key={`agent-${a.id}`} plain onPress={() => $.ui.view({ agentId: a.id })}>
                    <Text color={isLive(a.status) ? pulse(p, t) : statusColor(p, a.status)}>
                      {isLive(a.status) ? `${spin(t)} ` : a.status === 'completed' ? '● ' : '○ '}
                    </Text>
                    <Text color={p.text}>{a.description.slice(0, Math.max(10, w - 18))} </Text>
                    <Text color={statusColor(p, a.status)}>{a.status}</Text>
                  </Button>
                  {sp[a.id] && (
                    <Text tabular color={p.muted} wrap="truncate-end">
                      {'  '}
                      <Text color={modelColor(p, modelName(sp[a.id]!.model))} weight={ty.head}>
                        {modelName(sp[a.id]!.model) || '?'}
                      </Text>
                      {' · '}
                      {tok(sp[a.id]!.tokensIn)} in · {tok(sp[a.id]!.tokensOut)} out ·{' '}
                      <Text color={p.amber}>{usd(sp[a.id]!.usd)}</Text>
                    </Text>
                  )}
                </Box>
              ))}
          </Box>
        )}

        {/* BRAIN */}
        <Box flexDirection="column">
          {eyebrow('BRAIN', p.cyan, total > 0 ? `${s.quick + s.standard}/${total} skipped opus` : undefined)}
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {MODES.map(one => (
              <Button
                key={`mode-${one}`}
                label={one}
                variant={one === m ? 'primary' : 'secondary'}
                onPress={() => update($, mode, () => one)}
              />
            ))}
          </Box>
          <Text wrap="truncate-end">
            {r ? (
              <Text>
                <Text color={modelColor(p, r.model)} weight={ty.head}>
                  {r.model}
                </Text>
                <Text color={p.muted}>·{r.effort} — {r.why}</Text>
              </Text>
            ) : (
              <Text color={p.muted}>
                <Text color={p.pink}>++</Text> max brain · <Text color={p.green}>--</Text> quick
              </Text>
            )}
          </Text>
          <Button key="cto" plain onPress={() => update($, cto, v => !v)}>
            <Text color={p.muted}>CTO mode </Text>
            {toggle(isCto)}
            <Text color={p.muted}> opus plans, sonnet/haiku do</Text>
          </Button>
        </Box>

        {/* FOOTER: the level card bookends the hero */}
        <Box flexDirection="column" borderStyle="round" borderColor={p.violet} paddingX={1} backgroundColor={p.card}>
          <Text>
            <Text weight={ty.title} color={p.violet}>
              ★ Lv{level}
            </Text>
            <Text color={p.pink}> {titleOf(level)}</Text>
            {x.streak > 1 ? <Text color={p.amber}> 🔥{x.streak}d</Text> : ''}
          </Text>
          <Text tabular>
            {segments(((x.xp - floor) / (ceil - floor)) * 100, Math.max(6, barW - 2), [p.violet, p.pink, p.amber], p.faint).map(
              g => (
                <Text color={g.color}>{g.text}</Text>
              ),
            )}
            <Text color={p.muted}>
              {' '}
              {x.xp}/{ceil} xp
            </Text>
          </Text>
          <Button key="tldr" plain onPress={() => update($, tldr, v => !v)}>
            <Text color={p.muted}>TL;DR replies </Text>
            {toggle(isTldr)}
          </Button>
        </Box>
      </Box>
    )
  })
}

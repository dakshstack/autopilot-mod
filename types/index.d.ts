export type Mode = 'auto' | 'opus' | 'sonnet' | 'haiku' | 'off'
export type Tier = 'quick' | 'standard' | 'deep' | 'max'
export type Effort = 'low' | 'medium' | 'high' | 'xhigh'

export type Route = { tier: Tier; model: string; effort: Effort; why: string }
export type Stats = { quick: number; standard: number; deep: number; max: number }
export type AgentRow = { id: string; description: string; type: string; status: string }
export type Hud = {
  ratePct: number | null
  rateKind: string
  costUsd: number | null
  contextPct: number | null
}
/** Per subagent: the model it ran on and the tokens it spent, live per step. */
export type AgentSpend = { model: string; tokensIn: number; tokensOut: number; usd: number; opusUsd: number }
/** Session scorecard counters. */
export type Metrics = {
  turns: number
  turnMs: number
  tools: number
  toolErrors: number
  edits: number
  agentsDone: number
  agentsFailed: number
  agentMs: number
}
export type Xp = { xp: number; streak: number; lastDay: string }

/** What the main loop is doing right now. */
export type Live = {
  busy: boolean
  turnStartedAt: number
  tool: string
  detail: string
  toolStartedAt: number
  tools: number
  lastTurnMs: number | null
}
export type Repo = {
  isRepo: boolean
  branch: string
  ahead: number
  behind: number
  staged: number
  modified: number
  untracked: number
  lastCommit: string
  lastCommitAt: number
}
export type FileRow = { path: string; edits: number; at: number }
export type LastRun = { command: string; ok: boolean; ms: number; at: number; error: string }
export type LastError = { tool: string; text: string; at: number }
/** One message moving between the main loop, its agents and other sessions. */
export type Flow = {
  id: string
  kind: 'spawn' | 'send' | 'handback' | 'receive'
  from: string
  to: string
  label: string
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    autopilot: {
      mode: Mode
      tldr: boolean
      route: Shaped<Route | null>
      stats: Shaped<Stats>
      agents: Shaped<AgentRow[]>
      hud: Shaped<Hud>
      xp: Shaped<Xp>
      live: Shaped<Live>
      now: number
      repo: Shaped<Repo>
      files: Shaped<FileRow[]>
      lastRun: Shaped<LastRun | null>
      lastError: Shaped<LastError | null>
      isDark: boolean
      cto: boolean
      spend: Shaped<Record<string, AgentSpend>>
      metrics: Shaped<Metrics>
      flows: Shaped<Flow[]>
    }
  }
}

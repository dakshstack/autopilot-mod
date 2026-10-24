import { expect, mock, test } from 'claude-code/testing'

const BAND = {
  plugin: 'autopilot',
  component: 'AbovePrompt',
  requestId: 'band',
  props: { bodyColumns: 120, hasSurvey: false, view: {} },
} as const

const composer = { kind: 'composer' } as const

let sent = ''
function engine(on: any) {
  mock.clock(on, { now: 1_760_000_000_000 })
  mock.store(on)
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 1000, window: 200000, percent: 1 }, rateLimits: [{ kind: 'five_hour', percentUsed: 42 }] },
  }))
  on('prompt.submit', (_: unknown, e: any) => {
    sent = e.text
    return { text: e.text }
  })
}

test('a short ask routes to haiku, a hard one to opus, ++ forces max', async ($, on) => {
  engine(on)
  await $.prompt.submit({ text: 'rename foo to bar', wait: false, origin: composer } as any)
  let ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect((await ui.find({ type: 'Text', text: /haiku/ }))?.text).toContain('haiku')
  await ui.unmount()

  await $.prompt.submit({ text: 'refactor the auth layer to support SSO across services', wait: false, origin: composer } as any)
  ui = await $.ui.mount({ ...BAND, surface: 'desktop' } as any)
  expect((await ui.find({ type: 'Text', text: /opus/ }))?.text).toContain('deep')
  await ui.unmount()

  await $.prompt.submit({ text: '++ whatever', wait: false, origin: composer } as any)
  ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect((await ui.find({ type: 'Text', text: /opus/ }))?.text).toContain('MAX')
  await ui.unmount()
})

test('a -- without a space after is not a prefix', async ($, on) => {
  engine(on)
  await $.prompt.submit({ text: '--verbose flag? does it print the full output of every step in ci', wait: false, origin: composer } as any)
  expect(sent).toBe('--verbose flag? does it print the full output of every step in ci')
  const ui = await $.ui.mount({ ...BAND, surface: 'terminal' } as any)
  expect((await ui.find({ type: 'Text', text: /✈/ }))?.text).not.toContain('quick')
  await ui.unmount()
})

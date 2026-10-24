import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'autopilot',
  component: 'Pane',
  requestId: 'autopilot',
  props: { title: '✈ Autopilot', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: {}, view: {} },
} as const

test('a message in flight animates on the wire', async ($, on) => {
  mock.clock(on, { now: 1_760_000_000_000 })
  mock.store(on)
  on('agent.list', () => ({ value: [{ id: 'a1', description: 'Research BRICS', type: 'general-purpose', status: 'running' }] }))
  on('session.send', () => ({ isDelivered: true }))

  await $.session.send({ to: 'a1', text: 'also check the dates' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect((await ui.find({ type: 'Text', text: /WIRE/ }))?.text).toContain('WIRE')
  expect((await ui.find({ type: 'Text', text: /●/ }))?.text).toContain('●')
  expect((await ui.find({ type: 'Text', text: /also check the dates/ }))?.text).toContain('message')
  await ui.unmount()

})

test('an agent spawned with an explicit model still shows on the wire', async ($, on) => {
  mock.clock(on, { now: 1_760_000_000_000 })
  mock.store(on)
  on('agent.list', () => ({ value: [] }))
  on('agent.spawn', () => ({ model: 'sonnet', agentId: 'a1' }))

  await $.agent.spawn({ subagentType: 'general-purpose', description: 'Do it', prompt: 'go', model: 'sonnet' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect((await ui.find({ type: 'Text', text: /spawn/ }))?.text).toContain('spawn')
  await ui.unmount()
})

import { expect, test } from 'claude-code/testing'

const ask = (model: string, tools: string[]) =>
  ({ model, promptModel: model, surfaces: [], tools, outputStyle: null, traits: [] }) as any

test('opus with the Agent tool gets the CTO section; sonnet and subagents do not', async ($, on) => {
  on('prompt.compose', () => ({ sections: [] }))
  const opus = await $.prompt.compose(ask('claude-opus-5-5', ['Agent', 'Bash']))
  expect(opus.sections.map(s => s.id)).toContain('autopilot:cto')
  const sonnet = await $.prompt.compose(ask('claude-sonnet-5-5', ['Agent', 'Bash']))
  expect(sonnet.sections.map(s => s.id)).not.toContain('autopilot:cto')
  const sub = await $.prompt.compose(ask('claude-opus-5-5', ['Bash']))
  expect(sub.sections.map(s => s.id)).not.toContain('autopilot:cto')
})

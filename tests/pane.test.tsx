import { expect, mock, test } from 'claude-code/testing'

const PANE = {
  plugin: 'autopilot',
  component: 'Pane',
  requestId: 'autopilot',
  props: { title: '✈ Autopilot', isFocused: false, bodyColumns: 44, placement: 'dock', scroll: {}, view: {} },
} as const

test('the pane shows the repo, the last run and offers a fix', async ($, on) => {
  mock.clock(on, { now: 1_760_000_000_000 })
  mock.store(on)
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: 1000, window: 200000, percent: 12 }, rateLimits: [{ kind: 'five_hour', percentUsed: 64 }] },
  }))
  on('process.run', (_: unknown, e: any) => ({
    value:
      e.argv.includes('status')
        ? { exitCode: 0, stdout: '# branch.head main\n# branch.ab +2 -0\n1 .M N... 100644 100644 100644 a b src/app.ts\n? notes.md\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
        : { exitCode: 0, stdout: '1759999000\tfix auth flow\n', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('tool.call', () => ({ ref: 1, result: {}, text: 'Exit code 1\nTypeError: boom', isError: true }))

  await $.tool.call({ tool: 'Bash', command: 'npm test' } as any)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' } as any)
  expect((await ui.find({ type: 'Text', text: /npm test/ }))?.text).toContain('npm test')
  expect((await ui.find({ type: 'Text', text: /TypeError: boom/ }))?.text).toContain('boom')
  expect((await ui.find({ type: 'Text', text: /main/ }))?.text).toContain('⎇ main')
  await ui.unmount()

  const term = await $.ui.mount({ ...PANE, surface: 'terminal' } as any)
  expect((await term.find({ type: 'Text', text: /REPO/ }))?.text).toContain('REPO')
  await term.unmount()
})

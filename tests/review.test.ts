import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On, SessionMessage, UiPane } from 'claude-code'

const props = (bodyRows = 30, bodyColumns = 80) => ({
  title: 'Review',
  isFocused: true,
  bodyColumns,
  placement: 'dock',
  scroll: { offset: 0, bodyRows },
  view: {},
} as const)

const prompt = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [] })
const reply = (text: string, toolUses: SessionMessage['toolUses'] = []): SessionMessage => ({ role: 'assistant', text, toolUses })

const SESSION: SessionMessage[] = [
  prompt('first ask'),
  reply('Working on it.'),
  reply('## First answer\n\nAll done.'),
  prompt('second ask'),
  reply('', [{ tool_use_id: 't1', tool: 'TaskCreate', input: { subject: 'Write the mod' }, text: 'ok' }]),
  reply('', [{ tool_use_id: 't2', tool: 'TaskUpdate', input: { taskId: '1', status: 'in_progress' }, text: 'ok' }]),
  reply('', [{ tool_use_id: 'p1', tool: 'ExitPlanMode', input: { plan: '1. Build the pane' }, text: 'approved' }]),
  reply('Second answer, the latest.'),
]

const TOGGLE = {
  command: 'claude-review',
  args: '',
  origin: { kind: 'composer' },
  presentation: { isFullscreen: true, columns: 200 },
} as const

// the test kit leaves panes to the test: a minimal host that tracks open ids
function fakePanes(on: On): void {
  const open = new Map<string, UiPane>()
  on('ui.open', (_$, e) => {
    open.set(e.id, { id: e.id, title: e.title ?? e.id, isShown: true, isFocused: false, isPlaced: true })
    return { value: { isPlaced: true } }
  })
  on('ui.close', (_$, e) => {
    open.delete(e.id)
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: [...open.values()] }))
}

const turnEnd = { answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer' } as const
const mountTerminal = ($: Engine, bodyRows?: number, bodyColumns?: number) =>
  $.ui.mount({ plugin: 'review-pane', surface: 'terminal', component: 'Pane', requestId: 'claude-review', props: props(bodyRows, bodyColumns) })

test('the terminal pane draws the CLI layout: wordmark rule, the reply in a padded column, key row', async ($, on) => {
  fakePanes(on)
  on('session.messages', () => ({ value: SESSION }))
  on('turn.complete', () => ({ text: '' }))
  await $.command.run(TOGGLE)
  await $.turn.complete(turnEnd)

  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'claude review' })).toBeDefined()
  const answer = await ui.find({ type: 'Text', text: 'Second answer, the latest.' })
  expect(answer?.text.startsWith('    Second answer')).toBe(true) // the 4-cell gutter
  expect(await ui.find({ type: 'Text', text: '○ idle' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'f freeze · h l turns · m more' })).toBeDefined()
  // response leads; the approved plan and the tasks are tabs beside it
  expect(await ui.find({ type: 'Text', text: /t response · plan · tasks/ })).toBeDefined()
  await ui.unmount()
})

test('the tree is the body rows plus one, every row a single line', async ($, on) => {
  fakePanes(on)
  on('session.messages', () => ({ value: [prompt('ask'), reply(Array.from({ length: 80 }, (_, i) => `Line ${i}.`).join('\n\n'))] }))
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($, 20)
  const drawn = await ui.drawn() as { children: { type: string; children?: unknown[] }[] }
  const screen = drawn.children[0] as { children: unknown[] }
  // top rule, 17 body rows, bottom rule, key row; then the hidden spacer row
  expect(screen.children.length).toBe(20)
  expect(await ui.find({ type: 'Text', text: /▼ 0%/ })).toBeDefined()
  await ui.unmount()
})

test('scrolling moves the column under pinned chrome and shows both overflow cues', async ($, on) => {
  fakePanes(on)
  on('ui.scroll', () => ({}))
  on('session.messages', () => ({ value: [prompt('ask'), reply(Array.from({ length: 80 }, (_, i) => `Line ${i}.`).join('\n\n'))] }))
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($, 20)
  await $.ui.scroll({ component: 'Pane', requestId: 'claude-review', offset: 1, by: 5, bodyRows: 20, contentRows: 21, origin: { kind: 'person' } })
  expect(await ui.find({ type: 'Text', text: /claude review.*▲/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▼ \d+%/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Line 0.' })).toBeUndefined()
  // End jumps to the last row, where nothing is left below
  await $.ui.scroll({ component: 'Pane', requestId: 'claude-review', offset: 1, by: 21, bodyRows: 20, contentRows: 21, origin: { kind: 'person' } })
  expect(await ui.find({ type: 'Text', text: 'Line 79.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▼/ })).toBeUndefined()
  await ui.unmount()
})

test('h steps back with the prompt it answered, l returns to live, f freezes', async ($, on) => {
  fakePanes(on)
  on('session.messages', () => ({ value: SESSION }))
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($)
  await ui.press({ key: 'key-h' })
  expect(await ui.find({ type: 'Text', text: '› first ask' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'First answer' })).toBeDefined()

  await ui.press({ key: 'key-l' })
  expect(await ui.find({ type: 'Text', text: 'Second answer, the latest.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '› second ask' })).toBeUndefined()

  await ui.press({ key: 'key-f' })
  expect(await ui.find({ type: 'Text', text: '■ frozen' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'f unfreeze' })).toBeDefined()
  await ui.unmount()
})

test('a frozen view holds while a reply lands, flags it, and catches up on unfreeze', async ($, on) => {
  fakePanes(on)
  let messages = SESSION
  on('session.messages', () => ({ value: messages }))
  on('turn.complete', () => ({ text: '' }))
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($)
  await ui.press({ key: 'key-f' })
  messages = [...SESSION, prompt('third ask'), reply('Third answer.')]
  await $.turn.complete(turnEnd)
  expect(await ui.find({ type: 'Text', text: 'Second answer, the latest.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /new reply/ })).toBeDefined()

  await ui.press({ key: 'key-f' })
  expect(await ui.find({ type: 'Text', text: 'Third answer.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /new reply/ })).toBeUndefined()
  await ui.unmount()
})

test('t walks the surfaces and m opens the guide, which any other key closes', async ($, on) => {
  fakePanes(on)
  on('session.messages', () => ({ value: SESSION }))
  on('session.id', () => ({ value: 'a1b2c3' }))
  on('session.model', () => ({ value: 'us.anthropic.claude-opus-5-5[1m]' }))
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($, 40)
  await ui.press({ key: 'key-t' })
  expect(await ui.find({ type: 'Text', text: '1 Build the pane' })).toBeDefined()
  await ui.press({ key: 'key-t' })
  expect(await ui.find({ type: 'Text', text: '▸  Write the mod' })).toBeDefined()

  await ui.press({ key: 'key-m' })
  expect(await ui.find({ type: 'Text', text: 'DIAGNOSTICS' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /session +a1b2c3/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /model +opus-5-5\[1m\]/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /project +\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '↑↓ scroll · m close' })).toBeDefined()
  await ui.press({ key: 'key-h' })
  expect(await ui.find({ type: 'Text', text: 'DIAGNOSTICS' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: '▸  Write the mod' })).toBeDefined()
  await ui.unmount()
})

test('a pending AskUserQuestion leads as the question surface', async ($, on) => {
  fakePanes(on)
  on('session.messages', () => ({ value: [
    prompt('pick one'),
    reply('', [{ tool_use_id: 'q1', tool: 'AskUserQuestion', input: { questions: [{ header: 'Color', question: 'Which color?', options: [{ label: 'Blue', description: 'calm' }] }] } }]),
  ] }))
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'Color' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Blue: calm' })).toBeDefined()
  await ui.unmount()
})

for (const key of ['later', 'earlier'] as const) {
  test(`${key} pressed before the first turn leaves the pane following`, async ($, on) => {
    fakePanes(on)
    let messages: SessionMessage[] = []
    on('session.messages', () => ({ value: messages }))
    on('turn.complete', () => ({ text: '' }))
    await $.command.run(TOGGLE)

    const ui = await mountTerminal($)
    expect(await ui.find({ type: 'Text', text: '(no response yet)' })).toBeDefined()
    await ui.press({ key: key === 'later' ? 'key-l' : 'key-h' })

    messages = [prompt('first ask'), reply('The first answer.')]
    await $.turn.complete(turnEnd)
    expect(await ui.find({ type: 'Text', text: 'The first answer.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '○ idle' })).toBeDefined()
    await ui.unmount()
  })
}

test('other surfaces draw the reply with their own Markdown and buttons', async ($, on) => {
  fakePanes(on)
  on('session.messages', () => ({ value: SESSION }))
  await $.command.run(TOGGLE)

  const ui = await $.ui.mount({ plugin: 'review-pane', surface: 'desktop', component: 'Pane', requestId: 'claude-review', props: props() })
  expect((await ui.find({ key: 'body' }))?.text).toContain('Second answer, the latest.')
  await ui.press({ key: 'earlier' })
  expect((await ui.find({ key: 'body' }))?.text).toContain('First answer')
  await ui.unmount()
})

test('/claude-review toggles the pane, and a closed pane stops refreshing', async ($, on) => {
  fakePanes(on)
  let reads = 0
  on('session.messages', () => {
    reads += 1
    return { value: SESSION }
  })
  on('turn.complete', () => ({ text: '' }))

  expect((await $.command.run(TOGGLE)).text).toBe('Review pane opened.')
  const afterOpen = reads
  await $.turn.complete(turnEnd)
  expect(reads).toBe(afterOpen + 1)

  expect((await $.command.run(TOGGLE)).text).toBe('Review pane closed.')
  await $.turn.complete(turnEnd)
  expect(reads).toBe(afterOpen + 1)
})

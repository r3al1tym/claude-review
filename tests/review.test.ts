import { expect, mock, test } from 'claude-code/testing'
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

// the lamp and the settle run on the clock and paint by blits; a test holds
// the clock and keeps every blit
function light(on: On) {
  const clock = mock.clock(on, { now: 1_000_000 })
  const blits: { key: string; cells: string }[] = []
  on('ui.blit', (_$, e) => {
    if ('cells' in e) blits.push({ key: e.key, cells: e.cells })
    return { value: {} }
  })
  return { clock, blits }
}

const SETTLED = 1000 // past the longest settle

const turnEnd = { answer: '', durationMs: 1, isAborted: false, turnId: 'x', reason: 'answer' } as const
const mountTerminal = ($: Engine, bodyRows?: number, bodyColumns?: number) =>
  $.ui.mount({ plugin: 'review-pane', surface: 'terminal', component: 'Pane', requestId: 'claude-review', props: props(bodyRows, bodyColumns) })

test('the terminal pane draws the page: the lamp, the reply in a set column, the key row', async ($, on) => {
  fakePanes(on)
  light(on)
  on('session.messages', () => ({ value: SESSION }))
  on('turn.complete', () => ({ text: '' }))
  await $.command.run(TOGGLE)
  await $.turn.complete(turnEnd)

  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Raster', key: 'lamp' })).toBeDefined()
  const answer = await ui.find({ type: 'Text', text: 'Second answer, the latest.' })
  expect(answer?.text.startsWith('    Second answer')).toBe(true) // the 4-cell gutter
  expect(await ui.find({ type: 'Text', text: /^done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'f freeze · h l turns · m more' })).toBeDefined()
  // response leads; the approved plan and the tasks are tabs beside it
  expect(await ui.find({ type: 'Text', text: /t response · plan · tasks/ })).toBeDefined()
  await ui.unmount()
})

test('the tree is the body rows plus one: lamp, head, body, air, key row', async ($, on) => {
  fakePanes(on)
  light(on)
  on('session.messages', () => ({ value: [prompt('ask'), reply(Array.from({ length: 80 }, (_, i) => `Line ${i}.`).join('\n\n'))] }))
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($, 20)
  type Node = { type: string; props?: Record<string, unknown>; children: Node[] }
  const drawn = await ui.drawn() as Node
  const rows = drawn.children[0]!.children
  expect(rows.map(r => r.type)).toEqual(['Raster', 'Text', 'Box', 'Text', 'Text'])
  // 16 body rows beside the fore-edge, then the hidden spacer row: 20 + 1
  const [column, edge] = rows[2]!.children
  expect(column!.children.length).toBe(16)
  expect(edge?.props?.rows).toBe(16)
  expect(drawn.children.length).toBe(3)
  await ui.unmount()
})

test('scrolling moves the column under the pinned lamp and key row', async ($, on) => {
  fakePanes(on)
  light(on)
  on('ui.scroll', () => ({}))
  on('session.messages', () => ({ value: [prompt('ask'), reply(Array.from({ length: 80 }, (_, i) => `Line ${i}.`).join('\n\n'))] }))
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($, 20)
  await $.ui.scroll({ component: 'Pane', requestId: 'claude-review', offset: 1, by: 5, bodyRows: 20, contentRows: 21, origin: { kind: 'person' } })
  expect(await ui.find({ type: 'Raster', key: 'edge' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Line 0.' })).toBeUndefined()
  // End jumps to the last row, where nothing is left below
  await $.ui.scroll({ component: 'Pane', requestId: 'claude-review', offset: 1, by: 21, bodyRows: 20, contentRows: 21, origin: { kind: 'person' } })
  expect(await ui.find({ type: 'Text', text: 'Line 79.' })).toBeDefined()
  await ui.unmount()
})

test('h steps back with the prompt it answered, l returns to live, f freezes', async ($, on) => {
  fakePanes(on)
  light(on)
  on('session.messages', () => ({ value: SESSION }))
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($)
  await ui.press({ key: 'key-h' })
  expect(await ui.find({ type: 'Text', text: '› first ask' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'First answer' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Turn 1 of 2' })).toBeDefined()

  await ui.press({ key: 'key-l' })
  expect(await ui.find({ type: 'Text', text: 'Second answer, the latest.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '› second ask' })).toBeUndefined()

  await ui.press({ key: 'key-f' })
  expect(await ui.find({ type: 'Text', text: /^frozen/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'f unfreeze' })).toBeDefined()
  await ui.unmount()
})

test('a frozen view holds while a reply lands, flags it, and catches up on unfreeze', async ($, on) => {
  fakePanes(on)
  const { clock } = light(on)
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
  await clock.advance(SETTLED)
  expect(await ui.find({ type: 'Text', text: 'Third answer.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /new reply/ })).toBeUndefined()
  await ui.unmount()
})

test('t walks the surfaces and m opens the guide, which any other key closes', async ($, on) => {
  fakePanes(on)
  light(on)
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

test('a pending AskUserQuestion leads as the question surface, under the lamp at full', async ($, on) => {
  fakePanes(on)
  light(on)
  on('session.messages', () => ({ value: [
    prompt('pick one'),
    reply('', [{ tool_use_id: 'q1', tool: 'AskUserQuestion', input: { questions: [{ header: 'Color', question: 'Which color?', options: [{ label: 'Blue', description: 'calm' }] }] } }]),
  ] }))
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'Color' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Blue: calm' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Waiting for your answer' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^waiting/ })).toBeDefined()
  await ui.unmount()
})

for (const key of ['later', 'earlier'] as const) {
  test(`${key} pressed before the first turn leaves the pane following`, async ($, on) => {
    fakePanes(on)
    const { clock } = light(on)
    let messages: SessionMessage[] = []
    on('session.messages', () => ({ value: messages }))
    on('turn.complete', () => ({ text: '' }))
    await $.command.run(TOGGLE)

    const ui = await mountTerminal($)
    expect(await ui.find({ type: 'Text', text: '(no response yet)' })).toBeDefined()
    await ui.press({ key: key === 'later' ? 'key-l' : 'key-h' })

    messages = [prompt('first ask'), reply('The first answer.')]
    await $.turn.complete(turnEnd)
    await clock.advance(SETTLED)
    expect(await ui.find({ type: 'Text', text: 'The first answer.' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^done/ })).toBeDefined()
    await ui.unmount()
  })
}

test('other surfaces draw the reply with their own Markdown and buttons', async ($, on) => {
  fakePanes(on)
  light(on)
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
  light(on)
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

test('a new reply settles in: the page paints as cells, then lands as Text', async ($, on) => {
  fakePanes(on)
  const { clock, blits } = light(on)
  let messages: SessionMessage[] = [prompt('first ask'), reply('The first answer.')]
  on('session.messages', () => ({ value: messages }))
  on('turn.complete', () => ({ text: '' }))
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'The first answer.' })).toBeDefined()
  messages = [...messages, prompt('second ask'), reply('The second answer.')]
  await $.turn.complete(turnEnd)
  expect(await ui.find({ type: 'Raster', key: 'page' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'The second answer.' })).toBeUndefined()

  await clock.advance(300)
  expect(blits.some(b => b.key === 'page')).toBe(true)
  await clock.advance(SETTLED)
  expect(await ui.find({ type: 'Raster', key: 'page' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'The second answer.' })).toBeDefined()
  await ui.unmount()
})

test('while a new prompt runs, the last answer stays on the page, dimmed, and the lamp breathes', async ($, on) => {
  fakePanes(on)
  const { clock, blits } = light(on)
  on('session.messages', () => ({ value: [prompt('first ask'), reply('The first answer.'), prompt('second ask')] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.command.run(TOGGLE)

  await $.turn.start({ text: 'second ask', turnId: 'main' })
  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'The last answer, until the new one lands' })).toBeDefined()
  expect(await ui.find({ type: 'Raster', key: 'page' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^working/ })).toBeDefined()

  await clock.advance(400)
  const lamp = blits.filter(b => b.key === 'lamp')
  expect(lamp.length).toBeGreaterThan(3)
  expect(new Set(lamp.map(b => b.cells)).size).toBeGreaterThan(1) // the light moves
  await ui.unmount()
})

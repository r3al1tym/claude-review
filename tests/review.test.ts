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
function light(on: On, env: Record<string, string> = { COLORTERM: 'truecolor' }) {
  mock.env(on, env)
  const clock = mock.clock(on, { now: 1_000_000 })
  const blits: { key: string; cells: string }[] = []
  on('ui.blit', (_$, e) => {
    if ('cells' in e) blits.push({ key: e.key, cells: e.cells })
    return { value: {} }
  })
  return { clock, blits }
}

const SETTLED = 1300 // past the longest settle

// one row of a Raster's cells, as text
function rowText(cells: string, columns: number, row: number): string {
  const bytes = Uint8Array.from(atob(cells), c => c.charCodeAt(0))
  const words = new Uint32Array(bytes.buffer)
  let out = ''
  for (let x = 0; x < columns; x++) out += String.fromCodePoint(words[(row * columns + x) * 3]!)
  return out
}

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
  // the lamp at rest is Text at full colour depth, its light running smooth from the centre
  const lamp = await ui.find({ type: 'Text', text: /▆{72}/ })
  const backs = (lamp?.children ?? []).flatMap(c => (typeof c === 'object' && c !== null && 'props' in c ? [String((c as { props: Record<string, unknown> }).props.backgroundColor)] : []))
  expect(backs.some(b => [1, 3, 5].some(i => Number.parseInt(b.slice(i, i + 2), 16) % 17 !== 0))).toBe(true)
  const answer = await ui.find({ type: 'Text', text: 'Second answer, the latest.' })
  expect(answer?.text.startsWith('    Second answer')).toBe(true) // the 4-cell gutter
  expect(await ui.find({ type: 'Text', text: /^done/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'f freeze · h l turns · m keys' })).toBeDefined()
  // response leads; the approved plan and the tasks are tabs beside it
  expect(await ui.find({ type: 'Text', text: /t response · plan · tasks/ })).toBeDefined()
  await ui.unmount()
})

test('the tree is the body rows plus one: lamp, head and body, air, key row', async ($, on) => {
  fakePanes(on)
  light(on)
  on('session.messages', () => ({ value: [prompt('ask'), reply(Array.from({ length: 80 }, (_, i) => `Line ${i}.`).join('\n\n'))] }))
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($, 20)
  type Node = { type: string; props?: Record<string, unknown>; children: Node[] }
  const drawn = await ui.drawn() as Node
  const rows = drawn.children[0]!.children
  expect(rows.map(r => r.type)).toEqual(['Text', 'Box', 'Text', 'Text']) // the lamp at rest is a Text row
  // the head row and 16 body rows beside the fore-edge, then the hidden spacer row: 20 + 1
  const [column, edge] = rows[1]!.children
  expect(column!.children.length).toBe(17)
  expect(edge!.children[1]?.props?.rows).toBe(16)
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

test('h steps back and freezes, r jumps to the latest, l returns to live, f freezes', async ($, on) => {
  fakePanes(on)
  light(on)
  on('session.messages', () => ({ value: SESSION }))
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($)
  await ui.press({ key: 'key-h' })
  expect(await ui.find({ type: 'Text', text: '› first ask' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'First answer' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Turn 1 of 2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'r latest · h l turns · a ask · m keys' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^frozen/ })).toBeDefined()
  await ui.press({ key: 'key-h' })
  await ui.press({ key: 'key-r' })
  expect(await ui.find({ type: 'Text', text: 'Second answer, the latest.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /r latest/ })).toBeUndefined()

  await ui.press({ key: 'key-h' })
  await ui.press({ key: 'key-l' })
  expect(await ui.find({ type: 'Text', text: 'Second answer, the latest.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '› second ask' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^frozen/ })).toBeUndefined()

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
  // the question heads its options; the tab label stays on Claude Code's tab
  expect(await ui.find({ type: 'Text', text: 'Which color?' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Color' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Blue: calm' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Waiting for your answer' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^waiting/ })).toBeDefined()
  // the question's words stay in the lamp's warm light until it is answered
  const ask = await ui.find({ type: 'Text', text: 'Which color?' })
  const inks = (ask?.children ?? [])
    .filter((c): c is { props: Record<string, unknown> } => typeof c === 'object')
    .flatMap(c => (typeof c.props.color === 'string' ? [c.props.color] : []))
  expect(inks.length).toBeGreaterThan(0)
  expect(inks.every(c => Number.parseInt(c.slice(1, 3), 16) > Number.parseInt(c.slice(5, 7), 16))).toBe(true)
  await ui.unmount()
})

test('in a 256-colour terminal a waiting question stays grey, since the nearest warm greys are pinks', async ($, on) => {
  fakePanes(on)
  light(on, { COLORTERM: 'truecolor', TMUX: '/tmp/tmux-1000/default,1,0' })
  on('session.messages', () => ({ value: [
    prompt('pick one'),
    reply('', [{ tool_use_id: 'q1', tool: 'AskUserQuestion', input: { questions: [{ header: 'Color', question: 'Which color?', options: [{ label: 'Blue', description: 'calm' }] }] } }]),
  ] }))
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($)
  const ask = await ui.find({ type: 'Text', text: 'Which color?' })
  const inks = (ask?.children ?? [])
    .filter((c): c is { props: Record<string, unknown> } => typeof c === 'object')
    .flatMap(c => (typeof c.props.color === 'string' ? [c.props.color] : []))
  expect(inks.length).toBeGreaterThan(0)
  expect(inks.every(c => c.slice(1, 3) === c.slice(5, 7))).toBe(true)
  await ui.unmount()
})

test('a code block is set in the grey ramp: keywords bold, strings a step down, comments quiet and italic', async ($, on) => {
  fakePanes(on)
  light(on)
  on('session.messages', () => ({ value: [prompt('show me'), reply('```ts\nconst x = "hi" // a note\n```')] }))
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($)
  const line = await ui.find({ type: 'Text', text: 'const x = "hi" // a note' })
  const parts = (line?.children ?? []).filter((c): c is { props: Record<string, unknown>; children: unknown[] } => typeof c === 'object')
  const style = (text: string) => parts.find(c => c.children.join('') === text)?.props
  expect(style('const')).toMatchObject({ color: '#eeeeee', bold: true })
  expect(style('"hi"')).toMatchObject({ color: '#aaaaaa' })
  expect(style('// a note')).toMatchObject({ color: '#888888', italic: true })
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
    expect(await ui.find({ type: 'Text', text: 'The reply appears here as Claude writes it.' })).toBeDefined()
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
  messages = [...messages, prompt('second ask'), reply('The second answer, with `code` in it.')]
  await $.turn.complete(turnEnd)
  const raster = await ui.find({ type: 'Raster', key: 'page' }) as unknown as { props: { columns: number } } | undefined
  expect(raster).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'The second answer, with code in it.' })).toBeUndefined()

  await clock.advance(300)
  const frames = blits.filter(b => b.key === 'page')
  expect(frames.length).toBeGreaterThan(0)
  // a line arrives and leaves whole: in every frame a row's glyphs all show, or none do
  const columns = raster!.props.columns
  for (const f of frames) {
    const w = new Uint32Array(Uint8Array.from(atob(f.cells), c => c.charCodeAt(0)).buffer)
    for (let y = 0; y < w.length / (columns * 3); y++) {
      const shows = new Set<boolean>()
      for (let x = 0; x < columns; x++) {
        const i = (y * columns + x) * 3
        if (w[i] !== 0x20) shows.add(w[i + 1] !== 0x222222)
      }
      expect(shows.size).toBeLessThan(2)
    }
  }
  await clock.advance(SETTLED)
  expect(await ui.find({ type: 'Raster', key: 'page' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'The second answer, with code in it.' })).toBeDefined()
  await ui.unmount()
})

test('a new prompt leaves the last answer as it was, names itself quietly in the head row, and the lamp breathes', async ($, on) => {
  fakePanes(on)
  const { clock, blits } = light(on)
  let messages = [prompt('first ask'), reply('The first answer.')]
  on('session.messages', () => ({ value: messages }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.command.run(TOGGLE)
  const ui = await mountTerminal($)

  messages = [...messages, prompt('second ask')]
  await $.turn.start({ text: 'second ask', turnId: 'main' })
  await $.turn.complete(turnEnd) // another turn's end reads the session while main runs
  // no settle: the page holds, the answer at full ink
  expect(await ui.find({ type: 'Raster', key: 'page' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'Previous answer' })).toBeUndefined()
  const answer = await ui.find({ type: 'Text', text: 'The first answer.' })
  const words = (answer?.children ?? []).filter((c): c is { props: Record<string, unknown> } => typeof c === 'object')
  expect(words.length).toBeGreaterThan(0)
  expect(words.every(w => w.props.color === '#cccccc')).toBe(true)
  const head = await ui.find({ type: 'Text', text: '› second ask' })
  const ink = (head?.children ?? []).filter((c): c is { props: Record<string, unknown> } => typeof c === 'object')
  expect(ink.some(w => w.props.color === '#888888' && w.props.italic === true)).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^working/ })).toBeDefined()

  await clock.advance(400)
  const lamp = blits.filter(b => b.key === 'lamp')
  expect(lamp.length).toBeGreaterThan(3)
  expect(new Set(lamp.map(b => b.cells)).size).toBeGreaterThan(1) // the light moves
  await ui.unmount()
})

test('a new prompt keeps your place in a long answer, and a long prompt takes one row, cut with an ellipsis', async ($, on) => {
  fakePanes(on)
  light(on)
  on('ui.scroll', () => ({}))
  const ask = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ')
  let messages = [prompt('first ask'), reply(Array.from({ length: 80 }, (_, i) => `Line ${i}.`).join('\n\n'))]
  on('session.messages', () => ({ value: messages }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.command.run(TOGGLE)
  const ui = await mountTerminal($, 20)
  await $.ui.scroll({ component: 'Pane', requestId: 'claude-review', offset: 1, by: 5, bodyRows: 20, contentRows: 21, origin: { kind: 'person' } })
  expect(await ui.find({ type: 'Text', text: 'Line 0.' })).toBeUndefined()

  messages = [...messages, prompt(ask)]
  await $.turn.start({ text: ask, turnId: 'main' })
  await $.turn.complete(turnEnd)
  expect(await ui.find({ type: 'Text', text: 'Line 0.' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^ {4}› word0 word1.*…$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {6}word\d+ word\d+/ })).toBeUndefined()
  await ui.unmount()
})

test('in a 256-colour terminal the lamp keeps palette colours and breathes by its weight', async ($, on) => {
  fakePanes(on)
  const { clock, blits } = light(on, { COLORTERM: 'truecolor', TMUX: '/tmp/tmux-1000/default,1,0' })
  on('session.messages', () => ({ value: [prompt('first ask'), reply('The first answer.'), prompt('second ask')] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  await $.command.run(TOGGLE)
  await $.turn.start({ text: 'second ask', turnId: 'main' })
  const ui = await mountTerminal($)

  await clock.advance(2000)
  const words = (cells: string) => new Uint32Array(Uint8Array.from(atob(cells), c => c.charCodeAt(0)).buffer)
  const lit = blits.filter(b => b.key === 'lamp').map(b => words(b.cells).slice(120, 123)) // the ember, at the centre
  expect(new Set(lit.map(w => w[0])).size).toBeGreaterThan(1) // the glyph, so the weight, changes
  expect(lit.every(w => w[1] === 0x875f00 || w[2] === 0x875f00)).toBe(true) // one palette brown throughout
  await ui.unmount()
})

test('the lamp gathers into an ember while Claude works and opens across the column when the turn is done', async ($, on) => {
  fakePanes(on)
  const { clock } = light(on)
  on('session.messages', () => ({ value: [prompt('first ask'), reply('The first answer.')] }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  await $.command.run(TOGGLE)
  const ui = await mountTerminal($)
  // moving, the lamp is a Raster; at rest, a Text row
  const lampRow = async () => {
    const raster = await ui.find({ type: 'Raster', key: 'lamp' }) as unknown as { props: { columns: number; cells: string } } | undefined
    if (raster) return rowText(raster.props.cells, raster.props.columns, 0)
    return (await ui.find({ type: 'Text', text: /[▀▁-▆▔]{10}/ }))?.text ?? ''
  }
  // 80 columns: the column is cells 4 to 75, the ember the middle ten
  expect((await lampRow()).slice(4, 76).trim().length).toBe(72)

  await $.turn.start({ text: 'second ask', turnId: 'main' })
  await clock.advance(SETTLED)
  await ui.redraw()
  expect((await lampRow()).trim().length).toBe(10)
  // the ember burns even: one colour across its ten cells
  const ember = await ui.find({ type: 'Raster', key: 'lamp' }) as unknown as { props: { cells: string } }
  const w = new Uint32Array(Uint8Array.from(atob(ember.props.cells), c => c.charCodeAt(0)).buffer)
  expect(new Set(Array.from({ length: 10 }, (_, k) => w[(35 + k) * 3 + 2])).size).toBe(1)

  await $.turn.complete({ ...turnEnd, turnId: 'main' })
  await clock.advance(SETTLED)
  await ui.redraw()
  expect((await lampRow()).slice(4, 76).trim().length).toBe(72)
  await ui.unmount()
})

// ---------------------------------------------------------------- exchanges

const PERSON = { kind: 'composer' } as const
const SCHEDULE = { kind: 'scheduled-trigger' } as const
const NOTIFICATION = { kind: 'task-notification' } as const
const SWEEP = 'Orchestrator sweep: run the sweep in the orchestrator skill.'
const NOTICE = '<task-notification>\n<task-id>b1</task-id>\n<summary>The build finished</summary>\n</task-notification>'

type Origin = Parameters<Engine['prompt']['submit']>[0]['origin']
const text = (t: string) => [{ type: 'text', text: t }]

// A conversation the test drives as a session does: each prompt passes
// prompt.submit, each row is appended through the plugins, and what
// $.session.messages() reads is the rows a session lets it read (a hidden
// prompt's row, a scheduled one or one folded into a running turn, is not).
function conversation(on: On, { store = true } = {}) {
  if (store) mock.store(on)
  const rows: SessionMessage[] = []
  const session = { id: 'test-session' }
  on('session.messages', () => ({ value: [...rows] }))
  on('session.id', () => ({ value: session.id }))
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('turn.complete', () => ({ text: '' }))
  let n = 0
  const uuid = () => `row-${++n}`
  const submit = ($: Engine, t: string, origin: Origin, turnId?: string) =>
    $.prompt.submit({ text: t, origin, wait: false, ...(turnId ? { turnId } : {}) })
  return {
    rows,
    session,
    // rows the pane never saw appended: history from before it loaded
    seen: (...more: SessionMessage[]) => void rows.push(...more),
    async prompt($: Engine, t: string, origin: Origin = PERSON, turnId?: string) {
      await submit($, t, origin, turnId)
      rows.push(prompt(t))
      await $.session.append({ message: { type: 'user', role: 'user', content: text(t) }, door: 'prompt', origin, uuid: uuid() })
    },
    // a prompt that starts a turn under a row the person never sees
    async hidden($: Engine, t: string, origin: Origin) {
      await submit($, t, origin)
      await $.session.append({ message: { type: 'user', role: 'user', isMeta: true, content: text(t) }, door: 'prompt', origin, uuid: uuid() })
    },
    // a prompt typed while a turn runs, folded into it at the next tool
    // boundary; the engine writes its queue record first, a row the
    // conversation never keeps
    async delivered($: Engine, t: string, origin: Origin = PERSON, { queued = false } = {}) {
      await submit($, t, origin, 'running')
      if (queued) await $.session.append({ message: { type: 'user', role: 'user', content: text(t) }, door: 'queue', origin, uuid: uuid() })
      await $.session.append({ message: { type: 'attachment', name: 'queued_command', content: text(t) }, door: 'delivery', origin: { kind: 'engine' }, uuid: uuid() })
    },
    async reply($: Engine, t: string) {
      rows.push(reply(t))
      await $.session.append({ message: { type: 'assistant', role: 'assistant', content: text(t) }, door: 'response', origin: { kind: 'model', model: 'claude' }, uuid: uuid() })
    },
    // a tool call and its result
    async tool($: Engine, id: string) {
      rows.push(reply('', [{ tool_use_id: id, tool: 'Bash', input: { command: 'ls' }, text: 'ok' }]))
      await $.session.append({ message: { type: 'assistant', role: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] }, door: 'response', origin: { kind: 'model', model: 'claude' }, uuid: uuid() })
      rows.push({ role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: id, text: 'ok', isError: false }] })
      await $.session.append({ message: { type: 'user', role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, door: 'tool-result', origin: { kind: 'tool', tool: 'Bash' }, uuid: uuid() })
    },
  }
}

const texts = async (ui: Awaited<ReturnType<typeof mountTerminal>>, pattern: RegExp) =>
  (await ui.findAll({ type: 'Text', text: pattern })).filter(t => t.text.startsWith('    ')).length

test('a notification after an answer keeps the answer, under it and labelled', async ($, on) => {
  fakePanes(on)
  const { clock } = light(on)
  const c = conversation(on)
  await $.command.run(TOGGLE)
  await c.prompt($, 'what is the plan?')
  await c.reply($, 'The plan is three steps.')
  await c.prompt($, NOTICE, NOTIFICATION)
  await c.reply($, 'The build finished cleanly.')
  await $.turn.complete(turnEnd)
  await clock.advance(SETTLED)

  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'The plan is three steps.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'after a task notification' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'The build finished cleanly.' })).toBeDefined()
  // one exchange: the notification is no turn of its own to step to
  expect(await ui.find({ type: 'Text', text: 'f freeze · a ask · m keys' })).toBeDefined()
  await ui.unmount()
})

test('a scheduled prompt never becomes the live exchange; its reply lands under a label and lights new reply', async ($, on) => {
  fakePanes(on)
  const { clock } = light(on)
  const c = conversation(on)
  await $.command.run(TOGGLE)
  await c.prompt($, 'first ask')
  await c.reply($, 'First answer.')
  await $.turn.complete(turnEnd)
  await clock.advance(SETTLED)
  const ui = await mountTerminal($)
  await ui.press({ key: 'key-f' })

  // a sweep with text, then one with none: the second adds nothing
  await c.hidden($, SWEEP, SCHEDULE)
  await c.tool($, 't1')
  await c.reply($, 'Sweep: two workers are still running.')
  await c.hidden($, SWEEP, SCHEDULE)
  await c.tool($, 't2')
  await $.turn.complete(turnEnd)
  expect(await ui.find({ type: 'Text', text: /new reply/ })).toBeDefined()

  await ui.press({ key: 'key-f' })
  await clock.advance(SETTLED)
  expect(await ui.find({ type: 'Text', text: 'First answer.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Sweep: two workers are still running.' })).toBeDefined()
  expect(await texts(ui, /after a scheduled prompt/)).toBe(1)
  // still the person's one exchange: no earlier turn to step to, none later
  expect(await ui.find({ type: 'Text', text: 'f freeze · a ask · m keys' })).toBeDefined()
  await ui.press({ key: 'key-h' })
  expect(await ui.find({ type: 'Text', text: /Turn 1 of/ })).toBeUndefined()
  await ui.unmount()
})

test('back-to-back prompts both show with their answers: one folded into the turn joins it, one run as its own turn begins the next', async ($, on) => {
  fakePanes(on)
  const { clock } = light(on)
  const c = conversation(on)
  await $.command.run(TOGGLE)
  await c.prompt($, 'first question')
  await c.reply($, 'First answer.')
  await c.tool($, 't1')
  // typed while the turn ran: one folded into it at the tool boundary, one
  // the engine held until the turn ended and ran as a turn of its own
  await c.delivered($, 'and a second question')
  await c.reply($, 'Second answer.')
  await c.prompt($, 'and a third question', PERSON, 'running')
  await c.reply($, 'Third answer.')
  await $.turn.complete(turnEnd)
  await clock.advance(SETTLED)

  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'Third answer.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'First answer.' })).toBeUndefined()
  await ui.press({ key: 'key-h' })
  expect(await ui.find({ type: 'Text', text: 'Turn 1 of 2' })).toBeDefined()
  for (const t of ['› first question', 'First answer.', '› and a second question', 'Second answer.']) {
    expect(await ui.find({ type: 'Text', text: t })).toBeDefined()
  }
  expect(await ui.find({ type: 'Text', text: 'Third answer.' })).toBeUndefined()
  await ui.unmount()
})

test('a prompt typed during a background turn starts an exchange of its own', async ($, on) => {
  fakePanes(on)
  const { clock } = light(on)
  const c = conversation(on)
  await $.command.run(TOGGLE)
  await c.prompt($, 'first ask')
  await c.reply($, 'First answer.')
  await c.hidden($, SWEEP, SCHEDULE)
  await c.tool($, 't1')
  await c.reply($, 'Sweep: nothing new.')
  await c.tool($, 't2')
  await c.delivered($, 'what about the deploy?')
  await c.reply($, 'The deploy is green.')
  await $.turn.complete(turnEnd)
  await clock.advance(SETTLED)

  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'The deploy is green.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Sweep: nothing new.' })).toBeUndefined()
  await ui.press({ key: 'key-h' })
  expect(await ui.find({ type: 'Text', text: '› first ask' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Sweep: nothing new.' })).toBeDefined()
  await ui.unmount()
})

test('prompts sent together are one exchange, so going back to the first shows the reply', async ($, on) => {
  fakePanes(on)
  const { clock } = light(on)
  const c = conversation(on)
  await $.command.run(TOGGLE)
  await c.prompt($, 'first ask')
  await c.reply($, 'First answer.')
  await $.turn.complete(turnEnd)
  // queued while the last turn ran, then sent to the model in one request
  await c.prompt($, 'recut the repo')
  await c.prompt($, 'and the sounds are too loud')
  await c.prompt($, NOTICE, NOTIFICATION)
  await c.tool($, 't1')
  await c.reply($, 'Recut, with the sounds brought down.')
  await $.turn.complete(turnEnd)
  await clock.advance(SETTLED)

  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'Recut, with the sounds brought down.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '› and the sounds are too loud' })).toBeDefined()
  expect(await texts(ui, /after a task notification/)).toBe(0)
  await ui.press({ key: 'key-h' })
  expect(await ui.find({ type: 'Text', text: 'Turn 1 of 2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'First answer.' })).toBeDefined()
  await ui.unmount()
})

test('an exchange keeps every text the assistant wrote, intermediate ones included', async ($, on) => {
  fakePanes(on)
  light(on)
  on('session.messages', () => ({ value: [
    prompt('fix the build'),
    reply('Reading the failing test first.'),
    reply('', [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'npm test' }, text: 'ok' }]),
    reply('## Fixed\n\nThe import path was wrong.'),
  ] }))
  await $.command.run(TOGGLE)
  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'Reading the failing test first.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Fixed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'The import path was wrong.' })).toBeDefined()
  await ui.unmount()
})

test('rows with no recorded origin fall back to their words: a leading < or [ is background, plain text the person', async ($, on) => {
  fakePanes(on)
  light(on)
  on('session.messages', () => ({ value: [
    prompt('first ask'),
    reply('First answer.'),
    prompt(NOTICE),
    reply('Noted the build.'),
    prompt('<command-name>/claude-review</command-name>'),
    prompt('[Cross-session idle notice] The worker session is idle.'),
    reply('The worker is idle.'),
    prompt('second ask'),
    reply('Second answer.'),
  ] }))
  await $.command.run(TOGGLE)
  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'Second answer.' })).toBeDefined()
  await ui.press({ key: 'key-h' })
  expect(await ui.find({ type: 'Text', text: 'Turn 1 of 2' })).toBeDefined()
  for (const t of ['First answer.', 'after a task notification', 'Noted the build.', 'after a message from another session', 'The worker is idle.']) {
    expect(await ui.find({ type: 'Text', text: t })).toBeDefined()
  }
  await ui.unmount()
})

test('origins are kept in the store, so a resumed session still knows a scheduled prompt from the person', async ($, on) => {
  fakePanes(on)
  light(on)
  mock.store(on, { 'prompts:resumed': { at: 1, prompts: [{ text: 'Check the queue.', from: 'schedule', landed: true }] } })
  on('session.id', () => ({ value: 'resumed' }))
  on('session.messages', () => ({ value: [prompt('first ask'), reply('First answer.'), prompt('Check the queue.'), reply('The queue is empty.')] }))
  await $.command.run(TOGGLE)
  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'First answer.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'after a scheduled prompt' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'The queue is empty.' })).toBeDefined()
  await ui.unmount()
})

test('a session with no prompt from the person reads a turn at each plain-text prompt, as before', async ($, on) => {
  fakePanes(on)
  light(on)
  on('session.messages', () => ({ value: [
    prompt('[Message from: a peer] build the thing'), reply('Built it.'),
    prompt('[Message from: a peer] now test it'), reply('Tested it.'),
  ] }))
  await $.command.run(TOGGLE)
  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'Tested it.' })).toBeDefined()
  await ui.press({ key: 'key-h' })
  expect(await ui.find({ type: 'Text', text: 'Built it.' })).toBeDefined()
  await ui.unmount()
})

// the drawn page as rows of text: the lamp, the head row and body, the key row
async function pageText(ui: Awaited<ReturnType<typeof mountTerminal>>): Promise<string[]> {
  type Node = { type: string; children: (Node | string)[] }
  const flat = (n: Node | string): string => (typeof n === 'string' ? n : n.children.map(flat).join(''))
  const rows = ((await ui.drawn()) as Node).children[0] as Node
  const [lamp, page, , keys] = rows.children as Node[]
  const column = (page!.children[0] as Node).children as Node[]
  return [flat(lamp!), ...column.map(flat), '', flat(keys!)].map(r => r.trimEnd())
}

test('the page reads as one exchange: the answer, a later prompt where it arrived, a background reply under its label', async ($, on) => {
  fakePanes(on)
  const { clock } = light(on)
  const c = conversation(on)
  await $.command.run(TOGGLE)
  await c.prompt($, 'is the deploy safe to ship?')
  await c.reply($, 'Checking the gates first.')
  await c.tool($, 't1')
  await c.reply($, 'Yes. All **12 gates** pass and the canary is clean.')
  await c.tool($, 't2')
  await c.delivered($, 'and the rollback plan?')
  await c.reply($, 'The rollback is one command: `deploy --revert`.')
  await c.hidden($, SWEEP, SCHEDULE)
  await c.tool($, 't3')
  await c.reply($, 'Sweep: the two workers are still running.')
  await $.turn.complete(turnEnd)
  await clock.advance(SETTLED)

  const ui = await mountTerminal($, 18, 64)
  const [lamp, ...page] = await pageText(ui)
  expect(lamp).toMatch(/^ {4}▆{56}$/)
  expect(page).toEqual([
    '',
    '    Checking the gates first.',
    '',
    '    Yes. All 12 gates pass and the canary is clean.',
    '',
    '    › and the rollback plan?',
    '',
    '    The rollback is one command: deploy --revert.',
    '',
    '    after a scheduled prompt',
    '    Sweep: the two workers are still running.',
    '', '', '', '',
    '',
    '    done                           f freeze · a ask · m keys',
  ])
  // no new colours: the label in the quiet italic of the running head, the
  // later prompt in the ink an earlier turn's prompt leads with
  const inkOf = async (t: string) => ((await ui.find({ type: 'Text', text: `    ${t}` }))?.children ?? [])
    .filter((ch): ch is { props: Record<string, unknown> } => typeof ch === 'object' && ch !== null)[0]?.props
  expect(await inkOf('after a scheduled prompt')).toMatchObject({ color: '#888888', italic: true })
  expect(await inkOf('› and the rollback plan?')).toMatchObject({ color: '#999999' })
  await ui.unmount()
})

test('a reply that grows the exchange below relights only what is new, though the fore-edge moves', async ($, on) => {
  fakePanes(on)
  const { clock } = light(on)
  const c = conversation(on)
  await $.command.run(TOGGLE)
  await c.prompt($, 'first ask')
  await c.reply($, 'First answer.')
  await $.turn.complete(turnEnd)
  await clock.advance(SETTLED)
  const ui = await mountTerminal($, 10)

  await c.hidden($, SWEEP, SCHEDULE)
  await c.tool($, 't1')
  await c.reply($, Array.from({ length: 6 }, (_, i) => `Worker ${i} is still running.`).join('\n\n'))
  await $.turn.complete(turnEnd)
  const raster = await ui.find({ type: 'Raster', key: 'page' }) as unknown as { props: { columns: number; rows: number; cells: string } } | undefined
  expect(raster).toBeDefined()
  const { columns, rows, cells } = raster!.props
  const words = new Uint32Array(Uint8Array.from(atob(cells), ch => ch.charCodeAt(0)).buffer)
  const row = Array.from({ length: rows }, (_, y) => y).find(y => rowText(cells, columns, y).includes('First answer.'))!
  const inks = Array.from({ length: columns - 2 }, (_, x) => (row * columns + x) * 3).filter(i => words[i] !== 0x20).map(i => words[i + 1])
  expect(inks.length).toBeGreaterThan(0)
  expect(inks.every(ink => ink === 0xcccccc)).toBe(true) // at its ink from the first frame
  // the reply now runs past the pane, so the fore-edge stands beside it
  expect(Array.from({ length: rows }, (_, y) => rowText(cells, columns, y)).some(r => r.endsWith('▎'))).toBe(true)
  await clock.advance(SETTLED)
  expect(await ui.find({ type: 'Text', text: 'Worker 0 is still running.' })).toBeDefined()
  await ui.unmount()
})

// ---------------------------------------------------------------- review round

test('a queue record moves no print: a prompt folded in after one is still placed where it arrived', async ($, on) => {
  fakePanes(on)
  const { clock } = light(on)
  const c = conversation(on)
  await $.command.run(TOGGLE)
  await c.prompt($, 'first question')
  await c.reply($, 'First answer.')
  await c.tool($, 't1')
  await c.delivered($, 'and a second question', PERSON, { queued: true })
  await c.reply($, 'Second answer.')
  await $.turn.complete(turnEnd)
  await clock.advance(SETTLED)
  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: '› and a second question' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Second answer.' })).toBeDefined()
  await ui.unmount()
})

test('with no rows followed (a reload) the print is read back from the messages, so a hidden prompt is still placed', async ($, on) => {
  fakePanes(on)
  const { clock } = light(on)
  const c = conversation(on)
  await $.command.run(TOGGLE)
  c.seen(prompt('first ask'), reply('First answer.'))
  await c.hidden($, SWEEP, SCHEDULE)
  await c.reply($, 'Sweep: nothing new.')
  await $.turn.complete(turnEnd)
  await clock.advance(SETTLED)
  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'First answer.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'after a scheduled prompt' })).toBeDefined()
  await ui.unmount()
})

test('after a /clear the last session\'s print is not used: a hidden prompt is placed in the new conversation', async ($, on) => {
  fakePanes(on)
  const { clock } = light(on)
  const c = conversation(on)
  await $.command.run(TOGGLE)
  await c.prompt($, 'old ask')
  await c.reply($, 'Old answer.')
  await c.hidden($, SWEEP, SCHEDULE)
  await c.reply($, 'Old sweep.')
  // /clear: a new session id and a new conversation
  c.session.id = 'cleared-session'
  c.rows.length = 0
  c.seen(prompt('fresh ask'), reply('Fresh answer.'))
  await c.hidden($, SWEEP, SCHEDULE)
  await c.reply($, 'Fresh sweep.')
  await $.turn.complete(turnEnd)
  await clock.advance(SETTLED)
  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'Fresh answer.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'after a scheduled prompt' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Fresh sweep.' })).toBeDefined()
  await ui.unmount()
})

test('a hidden prompt from the person that begins a turn begins an exchange; the engine carrying it on does not', async ($, on) => {
  fakePanes(on)
  const { clock } = light(on)
  const c = conversation(on)
  await $.command.run(TOGGLE)
  await c.prompt($, 'first ask')
  await c.reply($, 'First answer.')
  await c.hidden($, 'how is the deploy going?', { kind: 'slack-ping' })
  await c.reply($, 'The deploy is green.')
  await c.hidden($, 'Continue from where you left off.', { kind: 'auto-continuation' })
  await c.reply($, 'Carrying on with the rollout.')
  await $.turn.complete(turnEnd)
  await clock.advance(SETTLED)
  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'The deploy is green.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'Carrying on with the rollout.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'First answer.' })).toBeUndefined()
  await ui.press({ key: 'key-h' })
  expect(await ui.find({ type: 'Text', text: 'Turn 1 of 2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'First answer.' })).toBeDefined()
  await ui.unmount()
})

test('an unrecorded prompt that opens with a bracket is the person\'s: [Image #1] and pasted markup begin exchanges', async ($, on) => {
  fakePanes(on)
  light(on)
  on('session.messages', () => ({ value: [
    prompt('first ask'), reply('First answer.'),
    prompt('[Image #1] what is in this screenshot?'), reply('A login form.'),
    prompt('<div class="card">why is this misaligned?</div>'), reply('The card has no width.'),
  ] }))
  await $.command.run(TOGGLE)
  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'The card has no width.' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'A login form.' })).toBeUndefined()
  await ui.press({ key: 'key-h' })
  expect(await ui.find({ type: 'Text', text: 'Turn 2 of 3' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'A login form.' })).toBeDefined()
  await ui.unmount()
})

test('turns before the person\'s first prompt stay as they were: a worker driven by another session keeps its replies', async ($, on) => {
  fakePanes(on)
  const { clock } = light(on)
  const c = conversation(on)
  await $.command.run(TOGGLE)
  // a window that opens mid-exchange, then two turns another session asked for
  c.seen(reply('Picked up where the window opens.'))
  await c.hidden($, 'Another Claude session sent a message:\n<cross-session-message from="orchestrator">build the map</cross-session-message>', { kind: 'peer' })
  await c.reply($, 'Built the map.')
  await c.hidden($, 'Another Claude session sent a message:\n<cross-session-message from="orchestrator">test the map</cross-session-message>', { kind: 'peer' })
  await c.reply($, 'Tested the map.')
  await c.prompt($, 'what did you change?')
  await c.reply($, 'Only the map layer.')
  await $.turn.complete(turnEnd)
  await clock.advance(SETTLED)
  const ui = await mountTerminal($)
  expect(await ui.find({ type: 'Text', text: 'Only the map layer.' })).toBeDefined()
  await ui.press({ key: 'key-h' })
  for (const t of ['Picked up where the window opens.', 'Built the map.', 'Tested the map.']) {
    expect(await ui.find({ type: 'Text', text: t })).toBeDefined()
  }
  await ui.unmount()
})

// A store as the engine keeps one: refuses a write that takes it past 4 MiB
// of JSON, and logs every write and delete.
function limitedStore(on: On, seed: Record<string, unknown>) {
  const map = new Map<string, unknown>(Object.entries(seed))
  const ops: string[] = []
  const size = () => new TextEncoder().encode(JSON.stringify(Object.fromEntries(map))).length
  on('store.get', (_$, e) => ({ value: map.get(e.key) }))
  on('store.keys', () => ({ value: [...map.keys()] }))
  on('store.delete', (_$, e) => {
    ops.push(`delete ${e.key}`)
    map.delete(e.key)
    return { value: undefined }
  })
  on('store.set', (_$, e) => {
    const was = map.get(e.key)
    map.set(e.key, JSON.parse(JSON.stringify(e.value)))
    if (size() > 4 * 1024 * 1024) {
      map.set(e.key, was)
      throw new Error('the store would pass 4 MiB')
    }
    ops.push(`set ${e.key}`)
    return { value: undefined }
  })
  return { map, ops }
}

test('the store is pruned by when each session last wrote, never deleting this session\'s record before it is written', async ($, on) => {
  fakePanes(on)
  light(on)
  const own = { at: 0, prompts: [{ text: 'first ask', from: 'person', landed: true }] }
  const others = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`prompts:other-${i + 1}`, { at: i + 1, prompts: [] }]))
  const { map, ops } = limitedStore(on, { 'prompts:test-session': own, ...others })
  conversation(on, { store: false })
  on('command.register', () => ({ value: { command: 'claude-review' } }))
  on('session.surfaces', () => ({ value: [] }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  await $.session.start({ cwd: '/', surface: null, isInteractive: false })

  expect(ops.includes('delete prompts:test-session')).toBe(false)
  expect(map.get('prompts:test-session')).toEqual(own)
  const left = [...map.keys()].filter(k => k.startsWith('prompts:other-'))
  expect(left.length).toBe(23)
  expect(left.every(k => Number(k.slice('prompts:other-'.length)) > 7)).toBe(true) // the oldest seven went
})

test('a session\'s record is capped by bytes, the oldest dropped, so the store never passes its limit', async ($, on) => {
  fakePanes(on)
  light(on)
  const { map, ops } = limitedStore(on, {})
  const c = conversation(on, { store: false })
  for (let n = 0; n < 120; n++) await c.prompt($, `${n} ${'✓'.repeat(236)}`)
  const stored = map.get('prompts:test-session') as { prompts: { text: string }[] }
  expect(new TextEncoder().encode(JSON.stringify(stored.prompts)).length).toBeLessThanOrEqual(64 * 1024)
  expect(stored.prompts.at(-1)?.text.startsWith('119 ')).toBe(true)
  expect(ops.filter(o => o === 'set prompts:test-session').length).toBeGreaterThan(100)
})

// ---------------------------------------------------------------- side questions

const USAGE = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }

function sides(on: On, answer: { isAnswered: true; text: string } | { isAnswered: false; reason: string; status?: number }) {
  const forks: string[] = []
  const sent: string[] = []
  on('model.fork', (_$, e) => {
    forks.push(e.prompt)
    return { value: { ...answer, usage: USAGE } } as never
  })
  on('prompt.submit', (_$, e) => {
    sent.push(String(e.text))
    return { drop: 'test' } as never
  })
  on('ui.focus', () => ({ value: {} }) as never)
  return { forks, sent }
}

test('a asks about what is in view: the view freezes, a fork answers into the aside, and the session gets nothing', async ($, on) => {
  fakePanes(on)
  light(on)
  on('session.messages', () => ({ value: SESSION }))
  const { forks, sent } = sides(on, { isAnswered: true, text: 'It means the second turn finished.' })
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($)
  await ui.press({ key: 'key-h' }) // the first turn, frozen
  await ui.press({ key: 'key-a' })
  expect(await ui.find({ key: 'ask' })).toBeDefined()
  // the field takes the key row's place
  expect(await ui.find({ type: 'Text', text: /m keys/ })).toBeUndefined()
  await ui.input({ key: 'ask', text: 'what does all done cover?' })

  expect(forks.length).toBe(1)
  expect(forks[0]).toContain('Turn 1 of 2, which answered the prompt: "first ask"')
  expect(forks[0]).toContain('All done.')
  expect(forks[0]).toContain('Question: what does all done cover?')
  expect(sent).toEqual([])
  // the aside leads, the question set as a prompt above its answer
  expect(await ui.find({ type: 'Text', text: /› what does all done cover\?/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /It means the second turn finished\./ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /t response · aside|t aside/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /s send/ })).toBeDefined()

  // a follow-up carries the earlier exchange
  await ui.press({ key: 'key-a' })
  await ui.input({ key: 'ask', text: 'and the first part?' })
  expect(forks[1]).toContain('Q: what does all done cover?')
  expect(forks[1]).toContain('A: It means the second turn finished.')

  // s hands the last one to the session as the person's prompt, with its anchor
  await ui.press({ key: 'key-s' })
  expect(sent.length).toBe(1)
  expect(sent[0]).toContain('and the first part?')
  expect(sent[0]).toContain('Asked from the review pane about turn 1')
  await ui.unmount()
})

test('a question asked on the live turn freezes it, so a reply that lands keeps the page you asked about', async ($, on) => {
  fakePanes(on)
  light(on)
  let messages = SESSION
  on('session.messages', () => ({ value: messages }))
  on('turn.complete', () => ({ text: '' }))
  sides(on, { isAnswered: true, text: 'Yes.' })
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($)
  await ui.press({ key: 'key-a' })
  messages = [...SESSION, prompt('third ask'), reply('Third answer.')]
  await $.turn.complete(turnEnd)
  await ui.input({ key: 'ask', text: 'is that final?' })
  expect(await ui.find({ type: 'Text', text: /^frozen/ })).toBeDefined()
  await ui.press({ key: 'key-t' }) // back to the response the question was about
  expect(await ui.find({ type: 'Text', text: /Second answer, the latest\./ })).toBeDefined()
  await ui.unmount()
})

test('a fork with no answer says why, and an empty question closes the field', async ($, on) => {
  fakePanes(on)
  light(on)
  on('session.messages', () => ({ value: SESSION }))
  const { forks } = sides(on, { isAnswered: false, reason: 'api-error', status: 529 })
  await $.command.run(TOGGLE)

  const ui = await mountTerminal($)
  await ui.press({ key: 'key-a' })
  await ui.input({ key: 'ask', text: '   ' })
  expect(forks.length).toBe(0)
  expect(await ui.find({ key: 'ask' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /m keys/ })).toBeDefined() // the key row is back

  await ui.press({ key: 'key-a' })
  await ui.input({ key: 'ask', text: 'why?' })
  expect(await ui.find({ type: 'Text', text: /No answer: api-error 529\./ })).toBeDefined()
  await ui.unmount()
})

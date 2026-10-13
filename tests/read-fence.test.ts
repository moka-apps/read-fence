import { expect, test } from 'claude-code/testing'

const HOME = '/home/v'
const settings = (on: boolean) => ({ value: JSON.stringify({ on }) })

// Wires a fake session. `env` answers env.get by name; tool calls that get through return "ran".
function wire(on: any, opts: { state: () => boolean; env?: Record<string, string>; ran?: () => void; root?: () => string }) {
  const env = { HOME, ...opts.env }
  on('env.get', (_$: any, e: any) => ({ value: env[e.name as string] }))
  on('session.root', () => ({ value: (opts.root ?? (() => '/repo'))() }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('fs.read', () => settings(opts.state()))
  on('fs.stat', (_$: any, e: any) => ({ value: { realPath: e.path } }))
  on('tool.call', () => { opts.ran?.(); return { result: 'ran' } })
}

test('off: a fenced path reads; on: it is refused and an allowed path still reads', async ($, on) => {
  let state = false
  let ran = 0
  wire(on, { state: () => state, ran: () => { ran += 1 } })

  const skill = `${HOME}/.claude/skills/foo/SKILL.md`
  expect((await $.tool.call({ tool: 'Read', file_path: skill })).deny).toBeUndefined()
  expect(ran).toBe(1)

  state = true
  const refused = await $.tool.call({ tool: 'Read', file_path: skill })
  expect(refused.deny).toContain('Read Fence refused Read')
  expect(ran).toBe(1)

  expect((await $.tool.call({ tool: 'Grep', pattern: 'x', path: '/repo/.claude/rules' })).deny).toContain('fenced')
  expect((await $.tool.call({ tool: 'Bash', command: `cat ${HOME}/.claude/plugins/cache/a/b/c/SKILL.md` })).deny).toContain('fenced')

  expect((await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.py' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: '/repo/CLAUDE.md' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: `${HOME}/.claude/projects/-p/memory/MEMORY.md` })).deny).toBeUndefined()
  expect(ran).toBe(4)
})

test('the invoked skill folder is exempt while on', async ($, on) => {
  wire(on, { state: () => true })
  on('skill.prompt', () => ({ text: 'x' }))

  await $.skill.prompt({ skill: 'foo', text: `Base directory for this skill: ${HOME}/.claude/skills/foo\n\n# Foo` })
  expect((await $.tool.call({ tool: 'Read', file_path: `${HOME}/.claude/skills/foo/ref.md` })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: `${HOME}/.claude/skills/bar/SKILL.md` })).deny).toContain('fenced')
})

test('a relative Glob pattern and $HOME in a Bash command are fenced', async ($, on) => {
  wire(on, { state: () => true })

  expect((await $.tool.call({ tool: 'Glob', pattern: '.claude/rules/*.md' })).deny).toContain('fenced')
  expect((await $.tool.call({ tool: 'Glob', pattern: 'src/*.ts' })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'cat $HOME/.claude/skills/foo/SKILL.md' })).deny).toContain('fenced')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls ${HOME}/.claude/rules' })).deny).toContain('fenced')
})

test('CLAUDE_CONFIG_DIR moves the fenced folders and the memory exemption', async ($, on) => {
  wire(on, { state: () => true, env: { CLAUDE_CONFIG_DIR: '/cfg/' } })

  expect((await $.tool.call({ tool: 'Read', file_path: '/cfg/skills/foo/SKILL.md' })).deny).toContain('fenced')
  expect((await $.tool.call({ tool: 'Read', file_path: `${HOME}/.claude/skills/foo/SKILL.md` })).deny).toBeUndefined()
  expect((await $.tool.call({ tool: 'Read', file_path: '/cfg/projects/-p/memory/MEMORY.md' })).deny).toBeUndefined()
})

test('a failure inside the fence lets the call through', async ($, on) => {
  wire(on, { state: () => true, root: () => { throw new Error('boom') } })

  expect((await $.tool.call({ tool: 'Read', file_path: `${HOME}/.claude/skills/foo/SKILL.md` })).deny).toBeUndefined()
})

test('/read-fence reports and saves the setting in the config folder', async ($, on) => {
  let state = false
  let written = ''
  wire(on, { state: () => state, env: { CLAUDE_CONFIG_DIR: '/cfg' } })
  on('fs.write', (_$: any, e: any) => { written = e.path; state = true; return { value: true } })

  expect((await $.command.run({ command: 'read-fence', args: '' })).text).toBe('read-fence is off')
  expect((await $.command.run({ command: 'read-fence', args: 'on' })).text).toBe('read-fence on')
  expect(written).toBe('/cfg/read-fence.json')
  expect((await $.command.run({ command: 'read-fence' })).text).toBe('read-fence is on')
})

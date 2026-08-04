/**
 * The kit now owns EmbeddedScanner, but mercado keeps its own copy
 * until M2 (mercado is out of scope for v1 and its scanner files carry
 * parallel WIP). Two copies of one component drift silently, so this
 * pins the public contract: every prop and every emit mercado's copy
 * declares must still exist here, with the same runtime type.
 *
 * Compiled through vue/compiler-sfc rather than regexed, so the check
 * sees what Vue sees — and doubles as the only thing in the repo that
 * proves these SFCs still compile.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parse, compileScript } from 'vue/compiler-sfc'

const KIT = resolve(__dirname, '../src/EmbeddedScanner.vue')
const MERCADO = resolve(
  __dirname, '../../mercado/frontend/src/components/EmbeddedScanner.vue',
)

interface Contract {
  props: Record<string, { type: string; required: boolean }>
  emits: string[]
}

function contractOf(file: string): Contract {
  const { descriptor, errors } = parse(readFileSync(file, 'utf8'), { filename: file })
  expect(errors, `${file} must parse`).toHaveLength(0)
  const compiled = compileScript(descriptor, { id: file })

  const props: Contract['props'] = {}
  const propsBlock = compiled.content.match(/props:\s*\{([\s\S]*?)\n\s*\},/)
  for (const line of (propsBlock?.[1] ?? '').split('\n')) {
    const m = line.match(/^\s*(\w+):\s*\{\s*type:\s*(\w+),\s*required:\s*(true|false)/)
    if (m) props[m[1]!] = { type: m[2]!, required: m[3] === 'true' }
  }
  const emitsBlock = compiled.content.match(/emits:\s*\[([^\]]*)\]/)
  const emits = (emitsBlock?.[1] ?? '')
    .split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)

  return { props, emits }
}

describe('EmbeddedScanner: kit contract', () => {
  const kit = contractOf(KIT)

  it('compiles and declares the documented props', () => {
    expect(Object.keys(kit.props).sort()).toEqual(
      ['active', 'dedupPolicy', 'sameCodeCooldownMs', 'sameCodeHoldMs'],
    )
    expect(kit.props.active).toEqual({ type: 'Boolean', required: true })
  })

  it('accepts BOTH dedup prop names (§21 B8)', () => {
    expect(kit.props.sameCodeHoldMs?.type).toBe('Number')
    expect(kit.props.sameCodeCooldownMs?.type).toBe('Number')
  })

  it('emits code + status', () => {
    expect(kit.emits.sort()).toEqual(['code', 'status'])
  })

  it("adds 'idle' to the status union as a superset (§21 B2)", () => {
    const src = readFileSync(KIT, 'utf8')
    const union = src.match(/type EmbeddedStatus\s*=([\s\S]*?)\n\n/)?.[1] ?? ''
    for (const s of ['idle', 'starting', 'running', 'denied', 'unsupported', 'error']) {
      expect(union, `status union must include '${s}'`).toContain(`'${s}'`)
    }
  })
})

describe.skipIf(!existsSync(MERCADO))('EmbeddedScanner: no drift from mercado', () => {
  it('keeps every prop mercado declares, with the same runtime type', () => {
    const kit = contractOf(KIT)
    const mercado = contractOf(MERCADO)
    for (const [name, def] of Object.entries(mercado.props)) {
      expect(kit.props[name], `kit dropped prop "${name}"`).toBeDefined()
      expect(kit.props[name]!.type).toBe(def.type)
      expect(kit.props[name]!.required).toBe(def.required)
    }
  })

  it('keeps every emit mercado declares', () => {
    const kit = contractOf(KIT)
    const mercado = contractOf(MERCADO)
    for (const e of mercado.emits) expect(kit.emits).toContain(e)
  })
})

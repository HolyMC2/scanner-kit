import { afterEach, describe, expect, it } from 'vitest'
import {
  BUILTIN_PREFIXES, LOCKED_PREFIXES, getPrefix, isKnownPrefix, listPrefixes,
  parsePrefix, registerPrefix, resetPrefixRegistry, unregisterPrefix,
} from '../src/prefixRegistry'

afterEach(() => { resetPrefixRegistry() })

describe('prefixRegistry: built-ins', () => {
  it('ships every historical prefix plus SCT', () => {
    for (const p of ['ITM', 'BAR', 'UBI', 'ORD', 'CST', 'INV', 'WH', 'MOV', 'SCT']) {
      expect(BUILTIN_PREFIXES).toContain(p)
      expect(isKnownPrefix(p)).toBe(true)
    }
  })

  it('flags the docname-carries-prefix cases', () => {
    expect(getPrefix('UBI')?.idIncludesPrefix).toBe(true)
    expect(getPrefix('SCT')?.idIncludesPrefix).toBe(true)
    expect(getPrefix('ITM')?.idIncludesPrefix).toBeFalsy()
  })

  it('refuses to redefine a built-in', () => {
    expect(() => registerPrefix('ITM', { type: 'customer' })).toThrow(/built-in/i)
  })

  it('accepts an identical re-registration of a built-in as a no-op', () => {
    expect(() => registerPrefix('UBI', { type: 'ubicacion', idIncludesPrefix: true }))
      .not.toThrow()
    expect(getPrefix('UBI')?.builtin).toBe(true)
  })

  it('never lets a built-in be unregistered', () => {
    expect(unregisterPrefix('ITM')).toBe(false)
    expect(isKnownPrefix('ITM')).toBe(true)
  })
})

describe('prefixRegistry: reserved + locked', () => {
  it('recognizes reserved tokens without a resolver', () => {
    for (const p of ['RMA', 'LOTE', 'SER', 'CUP']) {
      expect(isKnownPrefix(p)).toBe(true)
      expect(getPrefix(p)?.type).toBe('unknown')
    }
  })

  it('lets a host claim a reserved token', () => {
    registerPrefix('RMA', { type: 'rma' })
    expect(getPrefix('RMA')?.type).toBe('rma')
  })

  it('refuses TIU/TBM — live doctype autoname prefixes', () => {
    for (const p of LOCKED_PREFIXES) {
      expect(isKnownPrefix(p)).toBe(true)
      expect(() => registerPrefix(p, { type: 'item' })).toThrow(/reserved/i)
    }
  })
})

describe('prefixRegistry: collisions', () => {
  it('registers a new prefix', () => {
    const e = registerPrefix('rep', { type: 'reparacion' })
    expect(e.prefix).toBe('REP')
    expect(isKnownPrefix('REP')).toBe(true)
  })

  it('is idempotent for an identical definition', () => {
    registerPrefix('REP', { type: 'reparacion' })
    expect(() => registerPrefix('REP', { type: 'reparacion' })).not.toThrow()
    expect(listPrefixes().filter((p) => p.prefix === 'REP')).toHaveLength(1)
  })

  it('throws when a second feature claims the same prefix', () => {
    registerPrefix('REP', { type: 'reparacion' })
    expect(() => registerPrefix('REP', { type: 'orden' })).toThrow(/already registered/i)
  })

  it('rejects malformed prefixes', () => {
    expect(() => registerPrefix('R', { type: 'x' })).toThrow(/invalid prefix/i)
    expect(() => registerPrefix('TOOLONG', { type: 'x' })).toThrow(/invalid prefix/i)
    expect(() => registerPrefix('R3P', { type: 'x' })).toThrow(/invalid prefix/i)
  })

  it('unregister restores a reserved token instead of deleting it', () => {
    registerPrefix('RMA', { type: 'rma' })
    expect(unregisterPrefix('RMA')).toBe(true)
    expect(isKnownPrefix('RMA')).toBe(true)
    expect(getPrefix('RMA')?.type).toBe('unknown')
  })

  it('unregister removes a host-only prefix entirely', () => {
    registerPrefix('REP', { type: 'reparacion' })
    expect(unregisterPrefix('REP')).toBe(true)
    expect(isKnownPrefix('REP')).toBe(false)
  })
})

describe('parsePrefix sees the registry', () => {
  it('does not recognize an unregistered token', () => {
    expect(parsePrefix('REP-42')).toEqual({ prefix: null, id: 'REP-42' })
  })

  it('recognizes it once registered', () => {
    registerPrefix('REP', { type: 'reparacion' })
    expect(parsePrefix('REP-42')).toEqual({ prefix: 'REP', id: '42' })
  })
})

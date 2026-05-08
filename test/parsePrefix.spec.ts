import { describe, expect, it } from 'vitest'
import { parsePrefix } from '../src/scanResolver'

describe('parsePrefix', () => {
  it('detects ITM-', () => {
    expect(parsePrefix('ITM-MOD00001')).toEqual({ prefix: 'ITM', id: 'MOD00001' })
  })

  it('uppercases lowercase prefixes', () => {
    expect(parsePrefix('itm-MOD00001')).toEqual({ prefix: 'ITM', id: 'MOD00001' })
  })

  it('returns null prefix for unknown short codes', () => {
    expect(parsePrefix('XX-foo')).toEqual({ prefix: null, id: 'XX-foo' })
  })

  it('returns null prefix for bare item codes', () => {
    expect(parsePrefix('MLPT000042')).toEqual({ prefix: null, id: 'MLPT000042' })
  })

  it('preserves id case (Frappe names are case-sensitive)', () => {
    expect(parsePrefix('UBI-A-2-3')).toEqual({ prefix: 'UBI', id: 'A-2-3' })
  })

  it('handles all reserved prefixes without crashing', () => {
    for (const p of ['ITM', 'BAR', 'UBI', 'ORD', 'CST', 'INV', 'WH', 'MOV', 'RMA', 'LOTE', 'SER', 'CUP']) {
      const r = parsePrefix(`${p}-XYZ`)
      expect(r.prefix).toBe(p)
      expect(r.id).toBe('XYZ')
    }
  })

  it('trims whitespace', () => {
    expect(parsePrefix('  ITM-MOD00001  ')).toEqual({ prefix: 'ITM', id: 'MOD00001' })
  })

  it('returns null prefix for empty input', () => {
    expect(parsePrefix('')).toEqual({ prefix: null, id: '' })
  })
})

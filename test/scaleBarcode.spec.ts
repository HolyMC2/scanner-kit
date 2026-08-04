import { describe, expect, it } from 'vitest'
import { eanCheckDigit, parseScaleBarcode } from '../src/scaleBarcode'

// Defaults from Scanner Settings §4.2: prefix 2, 5 item digits,
// 5 value digits, weight — 1 + 5 + 5 + check = 12, so a real EAN-13
// layout uses a 2-digit prefix or 6 value digits. Both are exercised.
const s13 = { prefix: '2', itemDigits: 5, valueDigits: 6, totalLength: 13 }

describe('parseScaleBarcode: structure', () => {
  it('parses prefix / item / value / check', () => {
    // 2 | 01234 | 001250 | 7
    const r = parseScaleBarcode('2012340012507', s13)
    expect(r).not.toBeNull()
    expect(r!.itemDigits).toBe('01234')
    expect(r!.rawValue).toBe(1250)
    expect(r!.value).toBeCloseTo(1.25)
    expect(r!.checkDigit).toBe('7')
  })

  it('discards the parse on a prefix mismatch instead of guessing', () => {
    expect(parseScaleBarcode('7501055361020', s13)).toBeNull()
  })

  it('rejects the wrong length', () => {
    expect(parseScaleBarcode('20123400125', s13)).toBeNull()
    expect(parseScaleBarcode('2012340012507', { ...s13, totalLength: 14 })).toBeNull()
  })

  it('rejects non-digits', () => {
    expect(parseScaleBarcode('2ABC340012507', s13)).toBeNull()
  })

  it('honours enabled: false', () => {
    expect(parseScaleBarcode('2012340012507', { ...s13, enabled: false })).toBeNull()
  })
})

describe('parseScaleBarcode: 1-indexed segments', () => {
  it('reads decimals AFTER the segment, extending the window', () => {
    // value segment: start 7, 3 integer chars + 3 decimals → '001' + '250'
    const r = parseScaleBarcode('2012340012507', {
      ...s13,
      valueSegment: { start: 7, length: 3, decimals: 3 },
    })
    expect(r!.rawValue).toBe(1250)
    // Explicit decimals mean the point is already placed — no divisor.
    expect(r!.value).toBeCloseTo(1.25)
  })

  it('reads the item segment from a 1-indexed start', () => {
    const r = parseScaleBarcode('2012340012507', {
      ...s13,
      itemSegment: { start: 2, length: 5 },
    })
    expect(r!.itemDigits).toBe('01234')
  })

  it('returns null when a segment runs past the end', () => {
    expect(parseScaleBarcode('2012340012507', {
      ...s13, valueSegment: { start: 10, length: 8 },
    })).toBeNull()
  })
})

describe('parseScaleBarcode: value scaling', () => {
  it('divides by 1000 for weight (grams)', () => {
    expect(parseScaleBarcode('2012340025004', s13)!.value).toBeCloseTo(2.5)
  })

  it('divides by 100 for money (centavos)', () => {
    const r = parseScaleBarcode('2012340025004', { ...s13, valueIsWeight: false })
    expect(r!.value).toBeCloseTo(25)
    expect(r!.isWeight).toBe(false)
  })

  it('honours an explicit divisor', () => {
    const r = parseScaleBarcode('2012340025004', { ...s13, valueDivisor: 1 })
    expect(r!.value).toBe(2500)
  })
})

describe('eanCheckDigit: 1-indexed, even positions x3', () => {
  it('matches known EAN-13 codes', () => {
    expect(eanCheckDigit('400638133393')).toBe(1)   // 4006381333931
    expect(eanCheckDigit('978030640615')).toBe(7)   // 9780306406157
  })

  it('validates when asked and discards a corrupt code', () => {
    const digits = '201234001250'
    const good = digits + String(eanCheckDigit(digits))
    const bad = digits + String((eanCheckDigit(digits) + 1) % 10)
    const opts = { ...s13, validateCheckDigit: true }
    expect(parseScaleBarcode(good, opts)?.checkDigitValid).toBe(true)
    expect(parseScaleBarcode(bad, opts)).toBeNull()
  })

  it('leaves validity null when validation was not requested', () => {
    expect(parseScaleBarcode('2012340012507', s13)!.checkDigitValid).toBeNull()
  })
})

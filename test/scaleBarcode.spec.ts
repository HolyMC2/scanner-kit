import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SCALE_SETTINGS, eanCheckDigit, parseScaleBarcode,
} from '../src/scaleBarcode'

// Scanner Settings §4.2: prefix 2, 5 item digits, 6 value digits,
// weight — 1 + 5 + 6 + check = 13, a real EAN-13.
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

/**
 * The server mirror (`scanner_kit.services.scale_barcode`) derives the
 * code length as prefix + item + value + check, which is what §9.2's
 * structural match states. A hardcoded 13 here would disagree with it
 * on every layout that does not happen to sum to 13 — starting with
 * the one W3 found. Deriving makes the two agree by construction
 * instead of relying on the PWA passing the right number.
 */
describe('parseScaleBarcode: totalLength derives from the layout', () => {
  it('matches the server formula on the shipped defaults', () => {
    const derived = DEFAULT_SCALE_SETTINGS.prefix.length
      + DEFAULT_SCALE_SETTINGS.itemDigits + DEFAULT_SCALE_SETTINGS.valueDigits + 1
    expect(derived).toBe(13)
    // No totalLength given, so the parser must derive the same 13.
    const r = parseScaleBarcode('2012340012507', {})
    expect(r).not.toBeNull()
    expect(r!.itemDigits).toBe('01234')
  })

  it('accepts a 12-char layout with no totalLength stated', () => {
    const twelve = { prefix: '2', itemDigits: 5, valueDigits: 5 }
    const r = parseScaleBarcode('201234012508', twelve)
    expect(r).not.toBeNull()
    expect(r!.itemDigits).toBe('01234')
    expect(r!.value).toBeCloseTo(1.25)
    // …and rejects a 13-char code under that same layout.
    expect(parseScaleBarcode('2012340012507', twelve)).toBeNull()
  })

  it('drops the check digit from the derivation when it is disabled', () => {
    const noCheck = {
      prefix: '2', itemDigits: 5, valueDigits: 5, checkDigitPosition: 0,
    }
    const r = parseScaleBarcode('20123401250', noCheck)   // 1+5+5 = 11
    expect(r).not.toBeNull()
    expect(r!.checkDigit).toBeNull()
    expect(parseScaleBarcode('201234012508', noCheck)).toBeNull()
  })

  it('derives from explicit segments too', () => {
    const r = parseScaleBarcode('2012340012507', {
      prefix: '2',
      itemSegment: { start: 2, length: 5 },
      valueSegment: { start: 7, length: 3, decimals: 3 },
    })
    expect(r).not.toBeNull()
    expect(r!.value).toBeCloseTo(1.25)
  })

  it('an explicit totalLength still wins', () => {
    expect(parseScaleBarcode('2012340012507', { ...s13, totalLength: 14 })).toBeNull()
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

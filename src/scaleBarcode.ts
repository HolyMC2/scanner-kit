/**
 * Weight/price-embedded EAN parser (SPEC §7.6, §9.2).
 *
 * A scale prints `<prefix><item digits><value digits><check>`. Because
 * the embedded value changes with every package, the full 13-digit code
 * can NEVER match an `Item Barcode` row — and the resolver's zero-strip
 * tier would happily mangle it into a different code. So the cascade
 * matches on STRUCTURE first (prefix + length), then looks up only the
 * embedded item digits.
 *
 * Layout positions are 1-indexed, matching how a scale's manual and
 * POSAwesome's barcode format table both describe them. `decimals` are
 * the characters read immediately AFTER the segment — they extend the
 * window, they are not carved out of `length`.
 */

import type { ScaleBarcodeParse } from './types'

export interface ScaleSegment {
  /** 1-indexed position of the first character. */
  start: number
  /** Number of integer characters. */
  length: number
  /** Characters read after the segment, interpreted as decimals. */
  decimals?: number
}

export interface ScaleBarcodeSettings {
  enabled?: boolean
  /** Leading digits that mark a scale code. Mismatch discards the parse. */
  prefix?: string
  /** Shorthand layout — ignored when itemSegment/valueSegment are given. */
  itemDigits?: number
  valueDigits?: number
  itemSegment?: ScaleSegment
  valueSegment?: ScaleSegment
  /** Weight (kg) when true, money when false. */
  valueIsWeight?: boolean
  /**
   * Raw value divisor. Defaults: 1 when the layout declares decimals,
   * else 1000 for weight (grams) and 100 for money (centavos). Stating
   * it is what stops a 10x inventory error.
   */
  valueDivisor?: number
  /**
   * Full code length. DERIVED from the layout when omitted —
   * `prefix + item + value + check`, which is what §9.2's structural
   * match states. Hardcoding 13 here would silently disagree with the
   * server's parser on any layout that does not happen to sum to 13.
   */
  totalLength?: number
  /** 1-indexed. Default = totalLength. 0 disables the check digit. */
  checkDigitPosition?: number
  validateCheckDigit?: boolean
}

const DIGITS = /^\d+$/

/**
 * SPEC §4.2. 1 prefix + 5 item + 6 value + 1 check = 13, a real EAN-13.
 * The v1 draft's 5 value digits summed to 12 and could never match one.
 */
export const DEFAULT_SCALE_SETTINGS: Required<
  Pick<ScaleBarcodeSettings, 'prefix' | 'itemDigits' | 'valueDigits' | 'valueIsWeight'>
> = {
  prefix: '2',
  itemDigits: 5,
  valueDigits: 6,
  valueIsWeight: true,
}

/** Last 1-indexed position a segment reads, decimals included. */
function segmentEnd(seg: ScaleSegment): number {
  return seg.start - 1 + seg.length + (seg.decimals ?? 0)
}

/** EAN check digit over `digits`, 1-indexed, even positions weighted 3. */
export function eanCheckDigit(digits: string): number {
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    const d = digits.charCodeAt(i) - 48
    sum += (i + 1) % 2 === 0 ? d * 3 : d
  }
  return (10 - (sum % 10)) % 10
}

function readWindow(
  code: string,
  seg: ScaleSegment,
): { raw: string; intPart: string; decPart: string } | null {
  const from = seg.start - 1
  const decimals = seg.decimals ?? 0
  const to = from + seg.length + decimals
  if (from < 0 || seg.length <= 0 || to > code.length) return null
  const intPart = code.slice(from, from + seg.length)
  const decPart = code.slice(from + seg.length, to)
  return { raw: intPart + decPart, intPart, decPart }
}

/**
 * Structural match + parse. Returns null whenever the code is not a
 * scale barcode under these settings — including a prefix mismatch,
 * which must discard the parse rather than fall back to "any EAN-13".
 */
export function parseScaleBarcode(
  code: string,
  settings: ScaleBarcodeSettings = {},
): ScaleBarcodeParse | null {
  if (settings.enabled === false) return null
  const raw = (code || '').trim()
  if (!raw || !DIGITS.test(raw)) return null

  const prefix = settings.prefix ?? DEFAULT_SCALE_SETTINGS.prefix
  const itemDigits = settings.itemDigits ?? DEFAULT_SCALE_SETTINGS.itemDigits
  const valueDigits = settings.valueDigits ?? DEFAULT_SCALE_SETTINGS.valueDigits
  const itemSeg = settings.itemSegment
    ?? { start: prefix.length + 1, length: itemDigits }
  const valueSeg = settings.valueSegment
    ?? { start: prefix.length + 1 + itemDigits, length: valueDigits }

  // Derive the code length from the layout unless the host states one,
  // so the kit and `scanner_kit.services.scale_barcode` agree by
  // construction rather than by both being wired the same way.
  const hasCheckDigit = settings.checkDigitPosition !== 0
  const totalLength = settings.totalLength
    ?? Math.max(segmentEnd(itemSeg), segmentEnd(valueSeg)) + (hasCheckDigit ? 1 : 0)
  if (raw.length !== totalLength) return null

  if (prefix && !raw.startsWith(prefix)) return null

  const itemWindow = readWindow(raw, itemSeg)
  const valueWindow = readWindow(raw, valueSeg)
  if (!itemWindow || !valueWindow) return null

  const checkPos = settings.checkDigitPosition ?? totalLength
  const checkDigit = checkPos > 0 && checkPos <= raw.length ? raw[checkPos - 1]! : null
  let checkDigitValid: boolean | null = null
  if (checkDigit !== null && settings.validateCheckDigit) {
    checkDigitValid = eanCheckDigit(raw.slice(0, checkPos - 1)) === Number(checkDigit)
    if (!checkDigitValid) return null
  }

  const isWeight = settings.valueIsWeight ?? DEFAULT_SCALE_SETTINGS.valueIsWeight
  const decimals = valueSeg.decimals ?? 0
  const divisor = settings.valueDivisor
    ?? (decimals > 0 ? 1 : isWeight ? 1000 : 100)
  const rawValue = Number(valueWindow.raw)
  const placed = decimals > 0
    ? Number(`${valueWindow.intPart}.${valueWindow.decPart}`)
    : rawValue

  return {
    prefix,
    itemDigits: itemWindow.raw,
    rawValue,
    value: divisor === 1 ? placed : placed / divisor,
    isWeight,
    checkDigit,
    checkDigitValid,
  }
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useHidWedge } from '../src/hidWedge'

let clock = 0
const scans: string[] = []

function key(k: string, gapMs = 10, target?: EventTarget): void {
  clock += gapMs
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
  ;(target ?? window).dispatchEvent(ev)
}

/** A wedge sends its payload at machine speed then Enter. */
function burst(text: string, gapMs = 10): void {
  for (const c of text) key(c, gapMs)
  key('Enter', gapMs)
}

beforeEach(() => {
  clock = 1_000_000
  scans.length = 0
  vi.spyOn(Date, 'now').mockImplementation(() => clock)
})

afterEach(() => { vi.restoreAllMocks() })

describe('useHidWedge', () => {
  it('emits a fast burst terminated by Enter', () => {
    const w = useHidWedge({ onScan: (c) => scans.push(c) })
    w.start()
    burst('MOD00001')
    w.stop()
    expect(scans).toEqual(['MOD00001'])
  })

  it('ignores human typing speed', () => {
    const w = useHidWedge({ onScan: (c) => scans.push(c) })
    w.start()
    for (const c of 'MOD00001') key(c, 120)
    key('Enter', 120)
    w.stop()
    expect(scans).toEqual([])
  })

  it('has NO content-shape gate — alpha Code 128 and prefixed codes pass', () => {
    const w = useHidWedge({ onScan: (c) => scans.push(c) })
    w.start()
    burst('UBI-3700')
    burst('ITM-MOD00001')
    burst('1HGCM82633A004352')
    w.stop()
    expect(scans).toEqual(['UBI-3700', 'ITM-MOD00001', '1HGCM82633A004352'])
  })

  it('drops bursts shorter than minLength', () => {
    const w = useHidWedge({ onScan: (c) => scans.push(c), minLength: 6 })
    w.start()
    burst('AB1')
    burst('ABC123')
    w.stop()
    expect(scans).toEqual(['ABC123'])
  })

  it('stops a host keydown handler from also seeing the burst', () => {
    const host = vi.fn()
    const w = useHidWedge({ onScan: (c) => scans.push(c) })
    w.start()
    // Registered after the wedge, same phase + target → runs second,
    // unless stopImmediatePropagation ran first.
    window.addEventListener('keydown', host, true)
    burst('MOD00001')
    window.removeEventListener('keydown', host, true)
    w.stop()
    expect(scans).toEqual(['MOD00001'])
    // Only the first character of the burst is let through.
    expect(host).toHaveBeenCalledTimes(1)
  })

  it('never eats what the operator types into a field', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    const w = useHidWedge({ onScan: (c) => scans.push(c) })
    w.start()
    for (const c of 'ABC123') key(c, 5, input)
    key('Enter', 5, input)
    w.stop()
    input.remove()
    expect(scans).toEqual([])
  })

  it('honours the enabled() gate', () => {
    let on = false
    const w = useHidWedge({ onScan: (c) => scans.push(c), enabled: () => on })
    w.start()
    burst('MOD00001')
    on = true
    burst('MOD00002')
    w.stop()
    expect(scans).toEqual(['MOD00002'])
  })

  it('accepts a custom terminator and gap', () => {
    const w = useHidWedge({
      onScan: (c) => scans.push(c), terminator: 'Tab', maxGapMs: 60,
    })
    w.start()
    for (const c of 'ABC123') key(c, 45)
    key('Tab', 45)
    w.stop()
    expect(scans).toEqual(['ABC123'])
  })

  it('stop() detaches — no emissions after it', () => {
    const w = useHidWedge({ onScan: (c) => scans.push(c) })
    w.start()
    w.stop()
    burst('MOD00001')
    expect(scans).toEqual([])
    expect(w.active.value).toBe(false)
  })
})

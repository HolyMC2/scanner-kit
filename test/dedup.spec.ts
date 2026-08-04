import { describe, expect, it } from 'vitest'
import { createDedupGate, resolveDedupWindow, type DedupPolicy } from '../src/dedup'

function gate(policy: DedupPolicy, win: number) {
  return createDedupGate(() => policy, () => win)
}

describe('dedup: rolling-gap (counting screens)', () => {
  it('emits once while a code is held in front of the lens', () => {
    const g = gate('rolling-gap', 450)
    // Decode frames of a held code arrive every ~150ms.
    expect(g.accept('X', 0)).toBe(true)
    expect(g.accept('X', 150)).toBe(false)
    expect(g.accept('X', 300)).toBe(false)
    expect(g.accept('X', 450)).toBe(false)
    expect(g.accept('X', 600)).toBe(false)
  })

  it('emits again for the next identical unit — the 2026-07-03 undercount fix', () => {
    const g = gate('rolling-gap', 450)
    expect(g.accept('X', 0)).toBe(true)
    expect(g.accept('X', 150)).toBe(false)
    // Code pulled away, next unit presented 500ms after the last frame.
    expect(g.accept('X', 650)).toBe(true)
  })

  it('never blocks a different code', () => {
    const g = gate('rolling-gap', 450)
    expect(g.accept('X', 0)).toBe(true)
    expect(g.accept('Y', 10)).toBe(true)
  })
})

describe('dedup: fixed-cooldown (navigating scanner)', () => {
  it('blocks for the whole window measured from the emit', () => {
    const g = gate('fixed-cooldown', 1500)
    expect(g.accept('X', 0)).toBe(true)
    expect(g.accept('X', 150)).toBe(false)
    expect(g.accept('X', 900)).toBe(false)
    // Swallowed frames must NOT push the window forward.
    expect(g.accept('X', 1500)).toBe(true)
  })

  it('is the difference between the two policies', () => {
    const rolling = gate('rolling-gap', 1000)
    const fixed = gate('fixed-cooldown', 1000)
    for (const t of [0, 500, 900]) {
      rolling.accept('X', t)
      fixed.accept('X', t)
    }
    // Rolling re-armed at 900 → still inside the window at 1200.
    expect(rolling.accept('X', 1200)).toBe(false)
    // Fixed measured from the emit at 0 → window elapsed.
    expect(fixed.accept('X', 1200)).toBe(true)
  })
})

describe('dedup: reset + prop aliasing', () => {
  it('reset re-arms', () => {
    const g = gate('fixed-cooldown', 1500)
    g.accept('X', 0)
    g.reset()
    expect(g.accept('X', 10)).toBe(true)
  })

  it('accepts either prop name, hold wins when both are given', () => {
    expect(resolveDedupWindow(450, undefined, 1500)).toBe(450)
    expect(resolveDedupWindow(undefined, 1200, 1500)).toBe(1200)
    expect(resolveDedupWindow(undefined, undefined, 1500)).toBe(1500)
    expect(resolveDedupWindow(300, 1200, 1500)).toBe(300)
  })
})

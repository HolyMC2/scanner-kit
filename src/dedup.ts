/**
 * Repeat-scan policy (SPEC §7.4).
 *
 * The two scanner components need genuinely different semantics and the
 * difference is not a tunable number, so it is a named policy:
 *
 *   rolling-gap     Every swallowed frame RE-ARMS the timer. Holding one
 *                   code in front of the lens emits once; pulling it away
 *                   for longer than the gap and presenting the next unit
 *                   emits again. Counting stock means "cada lectura suma
 *                   +1" — a fixed cooldown swallowed those deliberate
 *                   re-scans and undercounted same-SKU stock (2026-07-03).
 *
 *   fixed-cooldown  An identical code is blocked for the whole window
 *                   measured from the last EMITTED decode. Right for the
 *                   navigating scanner, where re-emitting the same code
 *                   just re-triggers a route change.
 */

export type DedupPolicy = 'rolling-gap' | 'fixed-cooldown'

export interface DedupGate {
  /** True when the decode should be emitted. */
  accept(text: string, now?: number): boolean
  reset(): void
}

export function createDedupGate(
  policy: () => DedupPolicy,
  windowMs: () => number,
): DedupGate {
  let last: { text: string; at: number } | null = null

  return {
    accept(text: string, now = Date.now()): boolean {
      const win = windowMs()
      if (last && last.text === text && now - last.at < win) {
        // rolling-gap measures the gap between FRAMES, so a swallowed
        // frame pushes the window forward; fixed-cooldown measures from
        // the emit and must not be extended by the frames it blocks.
        if (policy() === 'rolling-gap') last.at = now
        return false
      }
      last = { text, at: now }
      return true
    },
    reset() {
      last = null
    },
  }
}

/**
 * Both prop names refer to the same knob (§21 B8): EmbeddedScanner
 * shipped `sameCodeHoldMs`, QrScanner shipped `sameCodeCooldownMs`.
 * Each component keeps its own default and accepts either name.
 */
export function resolveDedupWindow(
  holdMs: number | undefined,
  cooldownMs: number | undefined,
  fallback: number,
): number {
  return holdMs ?? cooldownMs ?? fallback
}

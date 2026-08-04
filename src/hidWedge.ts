/**
 * HID keyboard-wedge listener (SPEC §7.5).
 *
 * A wedge scanner types its payload as keystrokes and ends with Enter.
 * Detection is by SPEED only — 25 ms between characters is beyond human
 * typing — never by content shape. A `/^\d$/` gate would kill Code 128
 * alpha SKUs, ISBN-X, VINs and every `ITM-`/`UBI-` prefixed code, which
 * is most of what this fleet scans.
 *
 * Keystrokes are ignored entirely while an editable element has focus,
 * so the wedge never eats what the operator is typing into a field. The
 * first character of a burst is allowed through (nothing identifies it
 * as a scan yet); from the second fast character on, the burst and its
 * terminator are swallowed via stopImmediatePropagation so a host
 * keydown handler does not also see them.
 */

import { getCurrentInstance, onBeforeUnmount, onMounted, ref, type Ref } from 'vue'

export interface HidWedgeOptions {
  onScan: (code: string) => void
  /** Shortest payload worth emitting. Default 3. */
  minLength?: number
  /** Max ms between keystrokes that still counts as machine speed. */
  maxGapMs?: number
  /** Key that ends a scan. Default 'Enter'. */
  terminator?: string
  /** Where to listen. Default `window`. */
  target?: EventTarget | null
  /** Return false to pause the wedge without unmounting it. */
  enabled?: () => boolean
  /** Listen even while an input/textarea/contenteditable has focus. */
  captureInInputs?: boolean
}

export interface HidWedge {
  start: () => void
  stop: () => void
  active: Ref<boolean>
  /** Characters buffered so far — diagnostics only. */
  buffer: Ref<string>
}

function isEditable(el: EventTarget | null): boolean {
  const node = el as HTMLElement | null
  if (!node || typeof node.tagName !== 'string') return false
  const tag = node.tagName.toUpperCase()
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  return node.isContentEditable === true
}

export function useHidWedge(opts: HidWedgeOptions): HidWedge {
  const minLength = opts.minLength ?? 3
  const maxGapMs = opts.maxGapMs ?? 25
  const terminator = opts.terminator ?? 'Enter'
  const active = ref(false)
  const buffer = ref('')

  let lastAt = 0
  let fast = false

  function reset(): void {
    buffer.value = ''
    lastAt = 0
    fast = false
  }

  function onKeyDown(ev: Event): void {
    const e = ev as KeyboardEvent
    if (opts.enabled && !opts.enabled()) return reset()
    if (!opts.captureInInputs && isEditable(e.target)) return reset()

    const now = Date.now()
    const gap = lastAt ? now - lastAt : Number.POSITIVE_INFINITY

    if (e.key === terminator) {
      const code = buffer.value
      const wasFast = fast
      reset()
      if (wasFast && gap <= maxGapMs && code.length >= minLength) {
        e.preventDefault()
        e.stopImmediatePropagation()
        opts.onScan(code)
      }
      return
    }

    // Modifier combos and navigation keys are never part of a wedge burst.
    if (e.key.length !== 1 || e.ctrlKey || e.metaKey || e.altKey) {
      reset()
      return
    }

    if (gap > maxGapMs) {
      // Too slow to be a scanner — this is a fresh burst, and its first
      // character is let through since nothing yet says it is a scan.
      buffer.value = e.key
      fast = false
    } else {
      buffer.value += e.key
      fast = true
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    lastAt = now
  }

  function start(): void {
    const target = opts.target ?? (typeof window !== 'undefined' ? window : null)
    if (active.value || !target) return
    // Capture phase: the host's own keydown handlers must not run first.
    target.addEventListener('keydown', onKeyDown, true)
    active.value = true
  }

  function stop(): void {
    const target = opts.target ?? (typeof window !== 'undefined' ? window : null)
    if (!active.value || !target) return
    target.removeEventListener('keydown', onKeyDown, true)
    active.value = false
    reset()
  }

  if (getCurrentInstance()) {
    onMounted(start)
    onBeforeUnmount(stop)
  }

  return { start, stop, active, buffer }
}

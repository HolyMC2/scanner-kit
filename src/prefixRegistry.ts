/**
 * Runtime prefix registry (SPEC §7.2, §9.1).
 *
 * `ITM-`, `UBI-`, … used to be a hard-coded array inside the resolver,
 * so a host could neither teach the kit a new prefix nor find out which
 * ones exist. This module owns that set:
 *
 *   - built-ins ship with resolvers wired to the NetworkAdapter and
 *     cannot be redefined;
 *   - reserved tokens (RMA/LOTE/SER/CUP) are recognized syntactically
 *     and a host may claim them with `registerPrefix`;
 *   - locked tokens (TIU/TBM) are live Frappe autoname prefixes and are
 *     never claimable — a scan of `TIU-0007` must not dispatch anywhere;
 *   - anything else is free for hosts.
 *
 * Collisions throw rather than silently overwriting: two features
 * claiming one prefix is a bug that must surface at boot, not a race
 * decided by import order.
 */

import type { ScanPrefix, ScanType } from './types'

export interface PrefixLookupContext {
  /** Full normalized code, e.g. `UBI-3700`. */
  normalized: string
  /** Code with the prefix stripped, e.g. `3700`. */
  id: string
  /** Whether the host believes the network is reachable right now. */
  online: boolean
}

export interface PrefixLookupHit {
  /** Resolved entity id. Defaults to the key the lookup was called with. */
  id?: string
  payload?: Record<string, unknown> | null
}

export interface PrefixDefinition {
  /** `ScanResult.type` produced when this prefix resolves. */
  type: ScanType
  /**
   * True when the Frappe docname CONTAINS the prefix (`UBI-3700`,
   * `SCT-202608-0001`). The lookup then runs against the full normalized
   * string instead of the stripped id — the fix for finding #6, where
   * every cajón QR resolved as unknown.
   */
  idIncludesPrefix?: boolean
  /** Host-supplied resolver. Return null on a miss (never throw). */
  lookup?: (key: string, ctx: PrefixLookupContext) => Promise<PrefixLookupHit | null>
}

export interface RegisteredPrefix extends PrefixDefinition {
  prefix: string
  /** Kit-owned, resolver wired inside scanResolver. Not redefinable. */
  builtin: boolean
  /** Reserved for the platform; registerPrefix always refuses. */
  locked: boolean
}

export const PREFIX_PATTERN = /^([A-Za-z]{2,4})-(.+)$/

const VALID_PREFIX = /^[A-Z]{2,4}$/

/** Prefixes the kit resolves itself. */
const BUILTINS: Array<[string, PrefixDefinition]> = [
  ['ITM', { type: 'item' }],
  ['BAR', { type: 'barcode' }],
  ['UBI', { type: 'ubicacion', idIncludesPrefix: true }],
  ['ORD', { type: 'orden' }],
  ['CST', { type: 'customer' }],
  ['INV', { type: 'invoice' }],
  ['WH', { type: 'warehouse' }],
  ['MOV', { type: 'movimiento' }],
  ['SCT', { type: 'task', idIncludesPrefix: true }],
]

/** Recognized, resolver-less, claimable by a host. */
const RESERVED = ['RMA', 'LOTE', 'SER', 'CUP']

/**
 * Autoname prefixes of platform doctypes (Taller Item Ubicacion, Taller
 * Bin Movement). Recognized so `TIU-0007` reports its prefix, never
 * claimable so no host can make an internal row scan-dispatchable.
 */
export const LOCKED_PREFIXES = ['TIU', 'TBM']

export const BUILTIN_PREFIXES = BUILTINS.map(([p]) => p)
export const RESERVED_PREFIXES = [...RESERVED, ...LOCKED_PREFIXES]

const registry = new Map<string, RegisteredPrefix>()

function seed(): void {
  registry.clear()
  for (const [prefix, def] of BUILTINS) {
    registry.set(prefix, { ...def, prefix, builtin: true, locked: false })
  }
  for (const prefix of RESERVED) {
    registry.set(prefix, { prefix, type: 'unknown', builtin: false, locked: false })
  }
  for (const prefix of LOCKED_PREFIXES) {
    registry.set(prefix, { prefix, type: 'unknown', builtin: false, locked: true })
  }
}
seed()

function normalizePrefix(prefix: string): string {
  const p = (prefix || '').trim().toUpperCase()
  if (!VALID_PREFIX.test(p)) {
    throw new Error(
      `scanner-kit: invalid prefix "${prefix}" — expected 2-4 letters (A-Z).`,
    )
  }
  return p
}

function sameShape(a: RegisteredPrefix, b: PrefixDefinition): boolean {
  return (
    a.type === b.type
    && Boolean(a.idIncludesPrefix) === Boolean(b.idIncludesPrefix)
    && a.lookup === b.lookup
  )
}

/**
 * Teach the kit a prefix. Idempotent for an identical definition,
 * throws on a conflicting one (same discipline as registerOutboxHandler
 * for actions, except handlers may legitimately be swapped and a prefix
 * meaning may not).
 */
export function registerPrefix(prefix: string, def: PrefixDefinition): RegisteredPrefix {
  const p = normalizePrefix(prefix)
  if (!def || !def.type) {
    throw new Error(`scanner-kit: prefix "${p}" needs a type.`)
  }
  const existing = registry.get(p)
  if (existing?.locked) {
    throw new Error(
      `scanner-kit: prefix "${p}" is reserved by the platform and cannot be registered.`,
    )
  }
  if (existing?.builtin) {
    if (sameShape(existing, def)) return existing
    throw new Error(
      `scanner-kit: prefix "${p}" is a built-in and cannot be redefined.`,
    )
  }
  if (existing && existing.type !== 'unknown') {
    if (sameShape(existing, def)) return existing
    throw new Error(
      `scanner-kit: prefix "${p}" is already registered as "${existing.type}"; `
      + `refusing to redefine it as "${def.type}".`,
    )
  }
  const entry: RegisteredPrefix = {
    ...def, prefix: p, builtin: false, locked: false,
  }
  registry.set(p, entry)
  return entry
}

/** Drop a host-registered prefix. Built-ins and locked tokens survive. */
export function unregisterPrefix(prefix: string): boolean {
  const p = normalizePrefix(prefix)
  const existing = registry.get(p)
  if (!existing || existing.builtin || existing.locked) return false
  if (RESERVED.includes(p)) {
    registry.set(p, { prefix: p, type: 'unknown', builtin: false, locked: false })
    return true
  }
  return registry.delete(p)
}

export function getPrefix(prefix: string): RegisteredPrefix | null {
  const p = (prefix || '').trim().toUpperCase()
  return registry.get(p) ?? null
}

export function isKnownPrefix(prefix: string): boolean {
  return getPrefix(prefix) !== null
}

export function listPrefixes(): RegisteredPrefix[] {
  return [...registry.values()].sort((a, b) => a.prefix.localeCompare(b.prefix))
}

/** Restore the shipped set. Test helper — also useful for hot reload. */
export function resetPrefixRegistry(): void {
  seed()
}

/**
 * Convenience factory: parses a code without doing any IO. Useful for
 * tests and for code paths that just need to know the prefix.
 */
export function parsePrefix(raw: string): { prefix: ScanPrefix | null; id: string } {
  const trimmed = (raw || '').trim()
  const m = trimmed.match(PREFIX_PATTERN)
  if (!m) return { prefix: null, id: trimmed }
  const candidate = m[1]!.toUpperCase()
  if (isKnownPrefix(candidate)) return { prefix: candidate, id: m[2]! }
  return { prefix: null, id: trimmed }
}

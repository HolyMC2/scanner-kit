/**
 * Scan resolver — turns a raw scanned string into a typed ScanResult.
 *
 * Resolution order (SPEC §9.2 — kit and server `lookup.resolve` must
 * agree exactly):
 *
 *   prefix dispatch
 *     → on a prefix-dispatch MISS: retry the FULL original string
 *       through the bare cascade (§7.2b)
 *     → scale-EAN structural match (when enabled)
 *     → barcode
 *     → Item.name
 *     → zero-stripped barcode
 *     → unknown
 *
 * The fallthrough is load-bearing: `INV` is a registered prefix and
 * `INV-TEST-ITEM-OK` is a real Item, so without it every item code
 * shaped like a prefix is permanently unscannable.
 *
 * Network calls are abstracted via a NetworkAdapter so the kit stays
 * independent of frappe-ui / fetch / whatever the host SPA uses. Each
 * SPA wires its own adapter at app boot.
 */

import { getByBarcode, getItem, getUbicacion, isStale } from './idbCache'
import {
  PREFIX_PATTERN, getPrefix, type RegisteredPrefix,
} from './prefixRegistry'
import { parseScaleBarcode, type ScaleBarcodeSettings } from './scaleBarcode'
import type {
  AppContext, CachedItem, CachedUbicacion, ScanFormat, ScanResult,
} from './types'

export { parsePrefix } from './prefixRegistry'

/**
 * Network adapter — host SPA passes one of these in. Methods return
 * null when the lookup misses (NOT throws), so resolveScan can decide
 * how to communicate "unknown" to the user.
 */
export interface NetworkAdapter {
  lookupItem?: (code: string) => Promise<CachedItem | null>
  lookupBarcode?: (barcode: string) => Promise<CachedItem | null>
  lookupUbicacion?: (name: string) => Promise<CachedUbicacion | null>
  lookupOrder?: (name: string) => Promise<{ name: string; status?: string } | null>
  lookupCustomer?: (name: string) => Promise<{ name: string; customer_name?: string } | null>
  lookupInvoice?: (name: string) => Promise<{ name: string } | null>
  lookupWarehouse?: (name: string) => Promise<{ name: string } | null>
  lookupMovimiento?: (name: string) => Promise<{ name: string } | null>
  lookupTask?: (name: string) => Promise<{ name: string; status?: string } | null>
  /** True when the adapter can reach the network right now. */
  online?: () => boolean
}

export interface ResolveOptions {
  context: AppContext
  network: NetworkAdapter
  format?: ScanFormat
  /** Scale-barcode layout from `Scanner Settings`; omit to disable. */
  scale?: ScaleBarcodeSettings
}

/** Public entry point. */
export async function resolveScan(
  raw: string,
  opts: ResolveOptions,
): Promise<ScanResult> {
  const trimmed = (raw || '').trim()
  const base: ScanResult = {
    raw,
    normalized: trimmed,
    format: opts.format ?? 'unknown',
    type: 'unknown',
    id: null,
    prefix: null,
    source: 'prefix-only',
    resolvedAt: Date.now(),
  }

  if (!trimmed) return base

  // 1. Detect prefix (case-insensitive on the prefix, preserve id case
  // because some Frappe names are case-sensitive).
  const m = trimmed.match(PREFIX_PATTERN)
  const entry = m ? getPrefix(m[1]!) : null

  if (entry && m) {
    const id = m[2]!
    const prefixed: ScanResult = {
      ...base, normalized: `${entry.prefix}-${id}`, prefix: entry.prefix,
    }
    const hit = await dispatchPrefixed(entry, id, prefixed, opts)
    if (hit) return hit
    // §7.2b — the prefix reading was wrong for this code. Retry the full
    // original string as a bare code; on success the prefix reading is
    // dropped, on failure it is kept so hosts routing by prefix (taller's
    // cajón fallback) behave exactly as before.
    const viaCascade = await runBareCascade(trimmed, base, opts)
    return viaCascade ?? markOfflineMiss(prefixed, opts)
  }

  const hit = await runBareCascade(trimmed, base, opts)
  return hit ?? markOfflineMiss(base, opts)
}

// ──────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────

/** Returns null on a miss so the caller can fall through. */
async function dispatchPrefixed(
  entry: RegisteredPrefix,
  id: string,
  base: ScanResult,
  opts: ResolveOptions,
): Promise<ScanResult | null> {
  // Docnames that carry their own prefix (UBI-3700, SCT-202608-0001)
  // must be looked up whole — stripping is what made every cajón QR
  // resolve as unknown (finding #6).
  const key = entry.idIncludesPrefix ? base.normalized : id

  if (entry.lookup) {
    const hit = await entry
      .lookup(key, { normalized: base.normalized, id, online: isOnline(opts) })
      .catch(() => null)
    if (!hit) return null
    return {
      ...base,
      type: entry.type,
      id: hit.id ?? key,
      payload: hit.payload ?? null,
      source: 'network',
    }
  }

  switch (entry.prefix) {
    case 'ITM': {
      const r = await runWithCache<CachedItem>(
        () => getItem(key),
        () => opts.network.lookupItem?.(key) ?? Promise.resolve(null),
        opts,
      )
      return r.value ? finishItem(base, r.value, r.source, 'item') : null
    }
    case 'BAR': {
      const r = await runWithCache<CachedItem>(
        () => getByBarcode(key),
        () => opts.network.lookupBarcode?.(key) ?? Promise.resolve(null),
        opts,
      )
      return r.value ? finishItem(base, r.value, r.source, 'barcode') : null
    }
    case 'UBI': {
      const r = await runWithCache<CachedUbicacion>(
        () => getUbicacion(key),
        () => opts.network.lookupUbicacion?.(key) ?? Promise.resolve(null),
        opts,
      )
      return r.value
        ? {
            ...base, type: 'ubicacion', id: key,
            payload: r.value as unknown as Record<string, unknown>,
            source: r.source,
          }
        : null
    }
    case 'ORD':
      return await fromNetwork(base, key, opts.network.lookupOrder, 'orden')
    case 'CST':
      return await fromNetwork(base, key, opts.network.lookupCustomer, 'customer')
    case 'INV':
      return await fromNetwork(base, key, opts.network.lookupInvoice, 'invoice')
    case 'WH':
      return await fromNetwork(base, key, opts.network.lookupWarehouse, 'warehouse')
    case 'MOV':
      return await fromNetwork(base, key, opts.network.lookupMovimiento, 'movimiento')
    case 'SCT':
      return await fromNetwork(base, key, opts.network.lookupTask, 'task')
    // Reserved prefixes — recognized syntactically, no resolver wired.
    default:
      return null
  }
}

async function fromNetwork(
  base: ScanResult,
  key: string,
  fn: ((name: string) => Promise<Record<string, unknown> | null>) | undefined,
  type: ScanResult['type'],
): Promise<ScanResult | null> {
  const v = (await fn?.(key)?.catch(() => null)) ?? null
  return v ? { ...base, type, id: key, payload: v, source: 'network' } : null
}

/**
 * The bare-code cascade. Order matters; first hit wins. Returns null
 * when nothing matched so callers can decide what "unknown" means.
 */
async function runBareCascade(
  code: string,
  base: ScanResult,
  opts: ResolveOptions,
): Promise<ScanResult | null> {
  // 0. Scale-printed EAN. Runs BEFORE the lookups: the embedded value
  // changes per package so the full code can never match a barcode row,
  // and the zero-strip tier below would mangle it into a different one.
  const scale = opts.scale ? parseScaleBarcode(code, opts.scale) : null
  if (scale) {
    const r = await lookupItemOrBarcode(scale.itemDigits, opts)
    if (r.value) {
      return { ...finishItem(base, r.value, r.source, r.kind), scale }
    }
  }

  // 1. Barcode lookup (covers ~83% of doco items, mostly because the
  //    printed item_code is registered as a barcode literal).
  const fromBarcode = await runWithCache<CachedItem>(
    () => getByBarcode(code),
    () => opts.network.lookupBarcode?.(code) ?? Promise.resolve(null),
    opts,
  )
  if (fromBarcode.value) {
    return finishItem(base, fromBarcode.value, fromBarcode.source, 'barcode')
  }

  // 2. Direct Item.name lookup (covers items without an Item Barcode
  //    row at all — all 213 mumu items + the 965 doco items).
  const fromItem = await runWithCache<CachedItem>(
    () => getItem(code),
    () => opts.network.lookupItem?.(code) ?? Promise.resolve(null),
    opts,
  )
  if (fromItem.value) {
    return finishItem(base, fromItem.value, fromItem.source, 'item')
  }

  // 3. Fuzzy barcode — strip leading zeros (EAN-13 padding edge case
  //    where systems print '07501055361020' on the label but the Item
  //    Barcode row has '7501055361020').
  if (/^0+/.test(code)) {
    const stripped = code.replace(/^0+/, '')
    if (stripped && stripped !== code) {
      const fuzzy = await runWithCache<CachedItem>(
        () => getByBarcode(stripped),
        () => opts.network.lookupBarcode?.(stripped) ?? Promise.resolve(null),
        opts,
      )
      if (fuzzy.value) {
        return finishItem(base, fuzzy.value, fuzzy.source, 'barcode')
      }
    }
  }

  return null
}

async function lookupItemOrBarcode(
  code: string,
  opts: ResolveOptions,
): Promise<CacheRunResult<CachedItem> & { kind: 'item' | 'barcode' }> {
  const bc = await runWithCache<CachedItem>(
    () => getByBarcode(code),
    () => opts.network.lookupBarcode?.(code) ?? Promise.resolve(null),
    opts,
  )
  if (bc.value) return { ...bc, kind: 'barcode' }
  const it = await runWithCache<CachedItem>(
    () => getItem(code),
    () => opts.network.lookupItem?.(code) ?? Promise.resolve(null),
    opts,
  )
  return { ...it, kind: 'item' }
}

interface CacheRunResult<T> {
  value: T | null
  source: 'cache' | 'network' | 'prefix-only'
}

/**
 * Try cache first. If miss (or stale + online), call network and
 * return that. Cache hits beat the network — the consumer gets a
 * sub-50ms response and a background revalidation can refresh later.
 */
async function runWithCache<T extends CachedItem | CachedUbicacion>(
  cacheFn: () => Promise<T | null>,
  networkFn: () => Promise<T | null>,
  opts: ResolveOptions,
): Promise<CacheRunResult<T>> {
  const cached = await cacheFn().catch(() => null)
  if (cached) {
    const cachedAt = (cached as { cached_at?: number }).cached_at ?? 0
    if (!isStale(cachedAt) || !isOnline(opts)) {
      return { value: cached, source: 'cache' }
    }
    // Stale + online → fall through to refresh, but keep the stale
    // value around as a fallback if the network call fails.
    const fresh = await networkFn().catch(() => null)
    return fresh
      ? { value: fresh, source: 'network' }
      : { value: cached, source: 'cache' }
  }
  if (!isOnline(opts)) return { value: null, source: 'cache' }
  const fresh = await networkFn().catch(() => null)
  return fresh
    ? { value: fresh, source: 'network' }
    : { value: null, source: 'network' }
}

function isOnline(opts: ResolveOptions): boolean {
  if (typeof opts.network.online === 'function') {
    return opts.network.online()
  }
  return typeof navigator !== 'undefined' ? navigator.onLine : true
}

/**
 * An unresolved code means two very different things depending on the
 * radio: "the server says no such code" vs "we never got to ask".
 */
function markOfflineMiss(r: ScanResult, opts: ResolveOptions): ScanResult {
  return isOnline(opts) ? r : { ...r, offlineMiss: true }
}

function finishItem(
  base: ScanResult,
  item: CachedItem,
  source: 'cache' | 'network' | 'prefix-only',
  type: 'item' | 'barcode',
): ScanResult {
  return {
    ...base,
    type,
    id: item.item_code,
    payload: item as unknown as Record<string, unknown>,
    source,
  }
}

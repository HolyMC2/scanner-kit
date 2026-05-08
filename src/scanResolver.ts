/**
 * Scan resolver — turns a raw scanned string into a typed ScanResult.
 *
 * Handles the prefix scheme + the cascade fallback for bare codes,
 * exactly as documented in mercado/docs/scanner/ARCHITECTURE.md §6.
 *
 * Network calls are abstracted via a NetworkAdapter so the kit stays
 * independent of frappe-ui / fetch / whatever the host SPA uses. Each
 * SPA wires its own adapter at app boot.
 */

import { getByBarcode, getItem, getUbicacion, isStale } from './idbCache'
import type {
  AppContext, CachedItem, CachedUbicacion, ScanFormat,
  ScanPrefix, ScanResult,
} from './types'

const KNOWN_PREFIXES: ScanPrefix[] = [
  'ITM', 'BAR', 'UBI', 'ORD', 'CST', 'INV', 'WH', 'MOV',
  'RMA', 'LOTE', 'SER', 'CUP',
]
const PREFIX_PATTERN = /^([A-Z]{2,4})-(.+)$/i

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
  /** True when the adapter can reach the network right now. */
  online?: () => boolean
}

export interface ResolveOptions {
  context: AppContext
  network: NetworkAdapter
  format?: ScanFormat
}

/** Public entry point. */
export async function resolveScan(
  raw: string,
  opts: ResolveOptions,
): Promise<ScanResult> {
  const trimmed = (raw || '').trim()
  const format = opts.format ?? 'unknown'
  const base: ScanResult = {
    raw,
    normalized: trimmed,
    format,
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
  let prefix: ScanPrefix | null = null
  let id: string = trimmed
  if (m) {
    const candidate = m[1]!.toUpperCase() as ScanPrefix
    if ((KNOWN_PREFIXES as readonly string[]).includes(candidate)) {
      prefix = candidate
      id = m[2]!
    }
  }
  base.normalized = prefix ? `${prefix}-${id}` : trimmed
  base.prefix = prefix

  // 2. Prefix-driven resolution.
  if (prefix) {
    return await dispatchPrefixed(prefix, id, base, opts)
  }

  // 3. No prefix → cascade. Order matters; first hit wins.
  // 3.a barcode lookup (covers ~83% of doco items, mostly because
  //     the printed item_code is registered as a barcode literal).
  const fromBarcode = await runWithCache<CachedItem>(
    () => getByBarcode(trimmed),
    () => opts.network.lookupBarcode?.(trimmed) ?? Promise.resolve(null),
    opts,
  )
  if (fromBarcode.value) {
    return finishItem(base, fromBarcode.value, fromBarcode.source, 'barcode')
  }

  // 3.b direct Item.name lookup (covers items without an Item Barcode
  //     row at all — all 213 mumu items + the 965 doco items).
  const fromItem = await runWithCache<CachedItem>(
    () => getItem(trimmed),
    () => opts.network.lookupItem?.(trimmed) ?? Promise.resolve(null),
    opts,
  )
  if (fromItem.value) {
    return finishItem(base, fromItem.value, fromItem.source, 'item')
  }

  // 3.c fuzzy barcode — strip leading zeros (EAN-13 padding edge
  //     case where systems print '07501055361020' on the label but
  //     the Item Barcode row has '7501055361020').
  if (/^0+/.test(trimmed)) {
    const stripped = trimmed.replace(/^0+/, '')
    if (stripped && stripped !== trimmed) {
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

  // 3.d nothing matched.
  return base
}

// ──────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────

async function dispatchPrefixed(
  prefix: ScanPrefix,
  id: string,
  base: ScanResult,
  opts: ResolveOptions,
): Promise<ScanResult> {
  switch (prefix) {
    case 'ITM': {
      const r = await runWithCache<CachedItem>(
        () => getItem(id),
        () => opts.network.lookupItem?.(id) ?? Promise.resolve(null),
        opts,
      )
      return r.value ? finishItem(base, r.value, r.source, 'item') : base
    }
    case 'BAR': {
      const r = await runWithCache<CachedItem>(
        () => getByBarcode(id),
        () => opts.network.lookupBarcode?.(id) ?? Promise.resolve(null),
        opts,
      )
      return r.value ? finishItem(base, r.value, r.source, 'barcode') : base
    }
    case 'UBI': {
      const r = await runWithCache<CachedUbicacion>(
        () => getUbicacion(id),
        () => opts.network.lookupUbicacion?.(id) ?? Promise.resolve(null),
        opts,
      )
      return r.value
        ? {
            ...base, type: 'ubicacion', id,
            payload: r.value as unknown as Record<string, unknown>,
            source: r.source,
          }
        : base
    }
    case 'ORD': {
      const v = (await opts.network.lookupOrder?.(id)) ?? null
      return v
        ? { ...base, type: 'orden', id, payload: v, source: 'network' }
        : base
    }
    case 'CST': {
      const v = (await opts.network.lookupCustomer?.(id)) ?? null
      return v
        ? { ...base, type: 'customer', id, payload: v, source: 'network' }
        : base
    }
    case 'INV': {
      const v = (await opts.network.lookupInvoice?.(id)) ?? null
      return v
        ? { ...base, type: 'invoice', id, payload: v, source: 'network' }
        : base
    }
    case 'WH': {
      const v = (await opts.network.lookupWarehouse?.(id)) ?? null
      return v
        ? { ...base, type: 'warehouse', id, payload: v, source: 'network' }
        : base
    }
    case 'MOV': {
      const v = (await opts.network.lookupMovimiento?.(id)) ?? null
      return v
        ? { ...base, type: 'movimiento', id, payload: v, source: 'network' }
        : base
    }
    // Reserved prefixes — recognized syntactically but no resolver wired.
    default:
      return base
  }
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

/**
 * Convenience factory: parses a code without doing any IO. Useful
 * for tests and for code paths that just need to know the prefix.
 */
export function parsePrefix(raw: string): { prefix: ScanPrefix | null; id: string } {
  const trimmed = (raw || '').trim()
  const m = trimmed.match(PREFIX_PATTERN)
  if (!m) return { prefix: null, id: trimmed }
  const candidate = m[1]!.toUpperCase() as ScanPrefix
  if ((KNOWN_PREFIXES as readonly string[]).includes(candidate)) {
    return { prefix: candidate, id: m[2]! }
  }
  return { prefix: null, id: trimmed }
}

/**
 * Public types for the scanner kit. Mirrors the contract documented in
 * mercado/docs/scanner/ARCHITECTURE.md §2 + §5 + §6.
 */

export type AppContext = 'mercado' | 'taller'

export type ScanFormat =
  | 'qr_code'
  | 'ean_13'
  | 'ean_8'
  | 'upc_a'
  | 'code_128'
  | 'code_39'
  | 'data_matrix'
  | 'unknown'

/**
 * Known prefix tokens. Reserved-but-unused entries are kept here so
 * the type-checker forces us to think about them when adding new
 * resolvers later (RMA-, LOTE-, SER-, CUP-).
 */
export type ScanPrefix =
  | 'ITM'
  | 'BAR'
  | 'UBI'
  | 'ORD'
  | 'CST'
  | 'INV'
  | 'WH'
  | 'MOV'
  // reserved for future use:
  | 'RMA'
  | 'LOTE'
  | 'SER'
  | 'CUP'

export type ScanType =
  | 'item'
  | 'barcode'
  | 'ubicacion'
  | 'orden'
  | 'customer'
  | 'invoice'
  | 'warehouse'
  | 'movimiento'
  | 'unknown'

export type ScanSource = 'cache' | 'network' | 'prefix-only'

export interface ScanResult {
  /** What the camera actually decoded, before normalization. */
  raw: string
  /** Normalized (uppercase prefix + trimmed). */
  normalized: string
  format: ScanFormat
  type: ScanType
  /** Resolved entity id (item_code, ubicacion name, etc.). null when unknown. */
  id: string | null
  /** Detected prefix; null when no recognized prefix was present. */
  prefix: ScanPrefix | null
  /** Optional resolved payload — depends on type; populated when source != 'prefix-only'. */
  payload?: Record<string, unknown> | null
  /** Where the resolution came from. */
  source: ScanSource
  /** Date.now() when resolved. */
  resolvedAt: number
  /** True when the cache hit but the cache is past its freshness window. */
  stale?: boolean
}

/** Cached item row (mirrors §7 schema). */
export interface CachedItem {
  item_code: string
  item_name: string
  item_group: string | null
  brand: string | null
  image: string | null
  prices: Record<string, number>
  stock_by_wh: Record<string, number>
  barcodes: string[]
  search_blob: string
  cached_at: number
}

export interface CachedUbicacion {
  name: string
  label: string
  parent: string | null
  hierarchy: string[]
  cached_at: number
}

/** Outbox entry for offline writes (§7). */
export interface OutboxEntry {
  /** Auto-incremented PK assigned by Dexie. */
  id?: number
  /** Domain action — every consumer must use one of the registered handlers. */
  action: string
  /** Idempotency key so the server can dedupe across retries. */
  uuid: string
  payload: Record<string, unknown>
  status: 'pending' | 'syncing' | 'failed'
  attempts: number
  last_error?: string
  ts: number
}

/** Snapshot meta returned by the API. */
export interface SnapshotMeta {
  /** Unix epoch ms of the most recent Item.modified included. */
  cursor: number
  /** Total items returned in this batch. */
  count: number
  /** True if more pages remain (caller should re-fetch with since=cursor). */
  has_more: boolean
}

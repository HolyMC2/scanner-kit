/**
 * Public types for the scanner kit. Mirrors the contract documented in
 * mercado/docs/scanner/ARCHITECTURE.md §2 + §5 + §6 and scanner_kit
 * docs/SPEC.md §7 + §9.
 */

/**
 * Host application identifier. Free-form: the kit never branches on it
 * (asserted by test/contextOpaque.spec.ts), it only travels with the
 * result so hosts can tell their own scanners apart.
 */
export type AppContext = string

export type ScanFormat =
  | 'qr_code'
  | 'ean_13'
  | 'ean_8'
  | 'upc_a'
  | 'code_128'
  | 'code_39'
  | 'data_matrix'
  | 'unknown'

/** Prefix tokens the kit ships resolvers for. */
export type BuiltinScanPrefix =
  | 'ITM'
  | 'BAR'
  | 'UBI'
  | 'ORD'
  | 'CST'
  | 'INV'
  | 'WH'
  | 'MOV'
  | 'SCT'

/** Recognized syntactically, registrable by hosts, no resolver shipped. */
export type ReservedScanPrefix = 'RMA' | 'LOTE' | 'SER' | 'CUP'

/**
 * Any 2-4 letter token may be registered at runtime (see prefixRegistry),
 * so this is `string` — the literals are kept for editor completion.
 */
export type ScanPrefix = BuiltinScanPrefix | ReservedScanPrefix | (string & {})

export type BuiltinScanType =
  | 'item'
  | 'barcode'
  | 'ubicacion'
  | 'orden'
  | 'customer'
  | 'invoice'
  | 'warehouse'
  | 'movimiento'
  | 'task'
  | 'unknown'

/** Widened for the same reason as ScanPrefix — hosts register their own. */
export type ScanType = BuiltinScanType | (string & {})

export type ScanSource = 'cache' | 'network' | 'prefix-only'

/** Weight/price embedded in a scale-printed EAN (§9.2). */
export interface ScaleBarcodeParse {
  /** The leading digits that identified the code as a scale barcode. */
  prefix: string
  /** Digits carrying the item reference — what the lookup ran against. */
  itemDigits: string
  /** Embedded value before scaling (e.g. 1250 for 1.250 kg). */
  rawValue: number
  /** Scaled value: kilograms when isWeight, currency units otherwise. */
  value: number
  isWeight: boolean
  /** null when the layout declares no check digit. */
  checkDigit: string | null
  /** null when validation was not requested. */
  checkDigitValid: boolean | null
}

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
  /**
   * True when the code stayed unresolved *because* the device is offline
   * and the cache missed — as opposed to a code the server would also
   * reject. Hosts show "sin conexión" instead of "código desconocido".
   */
  offlineMiss?: boolean
  /** Present when the code parsed as a scale barcode (§9.2). */
  scale?: ScaleBarcodeParse
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
  /**
   * Session user that authored the entry. The server keys its dedupe
   * ledger on (user, uuid), and a shared tablet must never replay one
   * operator's queue under the next operator's session.
   */
  user?: string | null
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

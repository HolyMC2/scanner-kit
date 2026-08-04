/**
 * Dexie-backed cache for the scanner.
 *
 * IndexedDB is per-ORIGIN, and `/scan`, `/taller` and `/mercado` are one
 * origin — so the database NAME is the only thing keeping two SPAs from
 * sharing a cache and, worse, an outbox (each would accumulate the
 * other's undrainable entries behind a badge that never reaches zero).
 * Hosts therefore call `configureCache({ dbName })` once at boot and
 * every accessor honours it; passing a name to `openCache()` does the
 * same thing.
 *
 * Schema: items + ubicaciones + a barcode → item_code lookup table + a
 * sync_meta key/value table + the offline-write outbox (owned by
 * offlineQueue.ts, declared here so opening the database never has to
 * close and re-version itself at runtime).
 */

import Dexie, { type Table } from 'dexie'
import type { CachedItem, CachedUbicacion, OutboxEntry } from './types'

interface BarcodeRow {
  barcode: string
  item_code: string
}

interface SyncMetaRow {
  key: string
  value: number | string
  updated_at: number
}

const STORES = {
  // PK on item_code; multi-entry index on barcodes for membership tests.
  items: 'item_code, *barcodes, item_group, brand',
  ubicaciones: 'name, parent',
  // PK = barcode for O(1) lookup; secondary index on item_code for
  // reverse traversal (which barcodes does this item have?).
  barcodes: 'barcode, item_code',
  sync_meta: 'key',
  outbox: '++id, action, status, ts',
}

export class ScannerCacheDB extends Dexie {
  items!: Table<CachedItem, string>
  ubicaciones!: Table<CachedUbicacion, string>
  barcodes!: Table<BarcodeRow, string>
  sync_meta!: Table<SyncMetaRow, string>
  outbox!: Table<OutboxEntry, number>

  constructor(name: string) {
    super(name)
    // v1 and v2 declare the same stores. v2 exists because shipped
    // clients ran the old runtime `close() → version(2) → open()` dance
    // to add `outbox`, and Dexie refuses to open a database whose stored
    // version is higher than the highest declared one.
    this.version(1).stores(STORES)
    this.version(2).stores(STORES)
  }
}

export const DEFAULT_DB_NAME = 'scanner-cache-v1'

let _dbName = DEFAULT_DB_NAME
let _db: ScannerCacheDB | null = null

export interface CacheConfig {
  /** IndexedDB database name. One per SPA sharing the origin. */
  dbName?: string
}

/**
 * Name the cache. Call once at boot, before anything reads or writes.
 * Switching names closes the previous handle so the two never interleave.
 */
export function configureCache(config: CacheConfig = {}): void {
  const next = config.dbName?.trim()
  if (!next || next === _dbName) return
  _dbName = next
  if (_db && _db.name !== _dbName) {
    try { _db.close() } catch { /* already closed */ }
    _db = null
  }
}

/** Currently configured database name. */
export function cacheDbName(): string {
  return _dbName
}

/**
 * Open (or reopen) the cache. Passing a name is shorthand for
 * `configureCache({ dbName })` — it sticks, so later no-argument calls
 * from inside the kit reach the same database.
 */
export function openCache(dbName?: string): ScannerCacheDB {
  if (dbName) configureCache({ dbName })
  if (_db && _db.name === _dbName) return _db
  _db = new ScannerCacheDB(_dbName)
  return _db
}

export async function getItem(code: string): Promise<CachedItem | null> {
  const db = openCache()
  return (await db.items.get(code)) ?? null
}

export async function getByBarcode(barcode: string): Promise<CachedItem | null> {
  const db = openCache()
  const row = await db.barcodes.get(barcode)
  if (!row) return null
  return (await db.items.get(row.item_code)) ?? null
}

export async function getUbicacion(name: string): Promise<CachedUbicacion | null> {
  const db = openCache()
  return (await db.ubicaciones.get(name)) ?? null
}

/**
 * Bulk-load. Caller hands us already-normalized rows from the
 * snapshot endpoint; we put them in a single transaction so the
 * write is atomic from the consumer's perspective.
 */
export async function ingestItems(rows: CachedItem[]): Promise<void> {
  if (!rows.length) return
  const db = openCache()
  await db.transaction('rw', db.items, db.barcodes, async () => {
    await db.items.bulkPut(rows)
    const bcRows: BarcodeRow[] = []
    for (const r of rows) {
      // Always register item_code itself as a barcode hit — covers
      // the operator workflow where the printed item_code IS the
      // barcode (4755/4779 doco items, 213/213 mumu items).
      bcRows.push({ barcode: r.item_code, item_code: r.item_code })
      for (const bc of r.barcodes || []) {
        if (bc) bcRows.push({ barcode: bc, item_code: r.item_code })
      }
    }
    if (bcRows.length) await db.barcodes.bulkPut(bcRows)
  })
}

export async function ingestUbicaciones(rows: CachedUbicacion[]): Promise<void> {
  if (!rows.length) return
  const db = openCache()
  await db.ubicaciones.bulkPut(rows)
}

export async function getSyncMeta(key: string): Promise<number | string | null> {
  const db = openCache()
  const row = await db.sync_meta.get(key)
  return row ? row.value : null
}

export async function setSyncMeta(key: string, value: number | string): Promise<void> {
  const db = openCache()
  await db.sync_meta.put({ key, value, updated_at: Date.now() })
}

/** Drop everything — used when the user signs out or hits "reset cache". */
export async function clearCache(): Promise<void> {
  const db = openCache()
  await db.transaction(
    'rw',
    db.items, db.ubicaciones, db.barcodes, db.sync_meta,
    async () => {
      await db.items.clear()
      await db.ubicaciones.clear()
      await db.barcodes.clear()
      await db.sync_meta.clear()
    },
  )
}

/**
 * Stale window — anything older than this is still served (so we
 * keep working offline) but the consumer can choose to flag it.
 */
export const STALE_AFTER_MS = 5 * 60 * 1000
export const ABANDON_AFTER_MS = 24 * 60 * 60 * 1000

export function isStale(cached_at: number, now = Date.now()): boolean {
  return now - cached_at > STALE_AFTER_MS
}

export function isAbandoned(cached_at: number, now = Date.now()): boolean {
  return now - cached_at > ABANDON_AFTER_MS
}

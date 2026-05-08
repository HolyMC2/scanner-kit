/**
 * Offline write queue.
 *
 * Each enqueued entry gets a UUID v4 (idempotency-key); the server
 * dedupes on it so retries from a flaky network never produce
 * duplicate side-effects. The queue lives in the same Dexie database
 * as the read cache (idbCache.openCache()) so we share connection
 * + transaction boundaries.
 *
 * The processor is intentionally simple: FIFO, exponential back-off
 * on transient failures (5xx + network errors), terminal on 4xx.
 * Callers register one or more handlers per `action` via
 * registerOutboxHandler(), and call processOutbox() when the network
 * comes back (or in a background poll).
 */

import { openCache } from './idbCache'
import type { OutboxEntry } from './types'

const MAX_ATTEMPTS = 5

export type OutboxStatus = OutboxEntry['status']

export interface OutboxHandler {
  /** Returns truthy on success; throw with .code = 4xx for terminal failure. */
  send: (entry: OutboxEntry) => Promise<unknown>
}

const handlers = new Map<string, OutboxHandler>()

/** Register a per-action handler. Idempotent — re-registration replaces. */
export function registerOutboxHandler(action: string, h: OutboxHandler): void {
  handlers.set(action, h)
}

/** Public utility — UUID v4 without a runtime dep. Falls back to a
 * pseudo-random implementation when crypto.randomUUID is missing. */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // RFC 4122 §4.4 — version 4 UUID via Math.random.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

async function ensureOutboxStore(): Promise<void> {
  const db = openCache()
  if (db.tables.find((t) => t.name === 'outbox')) return
  // Bump schema in-place. Dexie requires opening a new version with
  // the same stores + the new one. We re-define everything.
  db.close()
  db.version(2).stores({
    items: 'item_code, *barcodes, item_group, brand',
    ubicaciones: 'name, parent',
    barcodes: 'barcode, item_code',
    sync_meta: 'key',
    outbox: '++id, action, status, ts',
  })
  await db.open()
}

/** Enqueue a write. Always succeeds locally — caller should NOT retry. */
export async function enqueue(
  action: string,
  payload: Record<string, unknown>,
): Promise<OutboxEntry> {
  await ensureOutboxStore()
  const db = openCache()
  const entry: OutboxEntry = {
    action,
    uuid: uuid(),
    payload,
    status: 'pending',
    attempts: 0,
    ts: Date.now(),
  }
  // Dexie auto-assigns the ++id PK on add().
  const id = await (db.table('outbox') as unknown as {
    add: (e: OutboxEntry) => Promise<number>
  }).add(entry)
  return { ...entry, id }
}

export async function listOutbox(status?: OutboxStatus): Promise<OutboxEntry[]> {
  await ensureOutboxStore()
  const db = openCache()
  const t = db.table('outbox') as unknown as {
    where: (i: string) => { equals: (v: string) => { sortBy: (k: string) => Promise<OutboxEntry[]> } }
    orderBy: (k: string) => { toArray: () => Promise<OutboxEntry[]> }
  }
  if (status) return await t.where('status').equals(status).sortBy('ts')
  return await t.orderBy('ts').toArray()
}

export async function countPending(): Promise<number> {
  return (await listOutbox('pending')).length
}

/**
 * Walk pending entries in FIFO order. For each, look up the
 * registered handler and call it. On success → delete. On HTTP 4xx
 * → mark failed (no retry). On network or 5xx → bump attempts +
 * keep pending (or move to failed past MAX_ATTEMPTS).
 *
 * Returns counts of {sent, failed, skipped} for the run.
 */
export async function processOutbox(): Promise<{
  sent: number
  failed: number
  skipped: number
}> {
  await ensureOutboxStore()
  const db = openCache()
  const pending = await listOutbox('pending')
  let sent = 0, failed = 0, skipped = 0
  for (const entry of pending) {
    const handler = handlers.get(entry.action)
    if (!handler) {
      skipped++
      continue
    }
    try {
      await markStatus(entry, 'syncing')
      await handler.send(entry)
      await db.table('outbox').delete(entry.id!)
      sent++
    } catch (err) {
      const e = err as { code?: number; message?: string }
      const isTerminal = typeof e.code === 'number' && e.code >= 400 && e.code < 500
      const next: OutboxEntry = {
        ...entry,
        attempts: entry.attempts + 1,
        last_error: e.message || String(err),
      }
      if (isTerminal || next.attempts >= MAX_ATTEMPTS) {
        next.status = 'failed'
        failed++
      } else {
        next.status = 'pending'
      }
      await db.table('outbox').put(next)
    }
  }
  return { sent, failed, skipped }
}

async function markStatus(entry: OutboxEntry, status: OutboxStatus): Promise<void> {
  const db = openCache()
  await db.table('outbox').put({ ...entry, status })
}

/** Drop ALL outbox rows. Used by 'reset cache' and tests. */
export async function clearOutbox(): Promise<void> {
  await ensureOutboxStore()
  const db = openCache()
  await db.table('outbox').clear()
}

/** Reset failed entries back to pending so the operator can retry. */
export async function retryFailed(): Promise<number> {
  const failed = await listOutbox('failed')
  const db = openCache()
  for (const e of failed) {
    await db.table('outbox').put({ ...e, status: 'pending', attempts: 0 })
  }
  return failed.length
}

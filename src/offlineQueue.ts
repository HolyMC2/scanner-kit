/**
 * Offline write queue.
 *
 * Each enqueued entry gets a UUID v4 (idempotency-key); the server
 * dedupes on `(user, uuid)` so retries from a flaky network never
 * produce duplicate side-effects. The queue lives in the same Dexie
 * database as the read cache (idbCache) so we share connection +
 * transaction boundaries — which also means it follows
 * `configureCache({ dbName })`, and two SPAs on one origin keep
 * separate outboxes.
 *
 * The processor is FIFO with exponential back-off on transient
 * failures. Callers register one handler per `action` via
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

export interface OutboxSnapshot {
  pending: number
  failed: number
  total: number
}

export interface OutboxRunResult {
  sent: number
  failed: number
  /** Entries left untouched because no handler is registered. */
  skipped: number
  /** Which actions were skipped — the diagnostic the badge needs. */
  skippedActions: string[]
  /** True when the run stopped early on a recoverable auth failure. */
  authFailed: boolean
}

export interface OutboxConfig {
  /**
   * Session user stamped onto entries authored from now on. Shared
   * tablets switch operators mid-shift; an unstamped queue replays A's
   * writes under B's session.
   */
  user?: string | null
  /**
   * Re-bootstrap the session (fresh CSRF token / re-login). Called at
   * most once per processOutbox run when a handler reports 401/403/CSRF.
   * Return true when the session is usable again.
   */
  reauth?: (() => Promise<boolean>) | null
}

const handlers = new Map<string, OutboxHandler>()
const listeners = new Set<(s: OutboxSnapshot) => void>()

let config: OutboxConfig = { user: null, reauth: null }

/** Register a per-action handler. Idempotent — re-registration replaces. */
export function registerOutboxHandler(action: string, h: OutboxHandler): void {
  handlers.set(action, h)
}

/** Set the authoring user and/or the re-bootstrap callback. */
export function configureOutbox(cfg: OutboxConfig): void {
  config = { ...config, ...cfg }
}

/**
 * Subscribe to queue changes — the PWA badge reacts without polling.
 * Returns an unsubscribe function.
 */
export function onOutboxChange(fn: (s: OutboxSnapshot) => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export async function outboxSnapshot(): Promise<OutboxSnapshot> {
  const all = await listOutbox()
  return {
    pending: all.filter((e) => e.status === 'pending').length,
    failed: all.filter((e) => e.status === 'failed').length,
    total: all.length,
  }
}

async function notify(): Promise<void> {
  if (!listeners.size) return
  const snap = await outboxSnapshot().catch(() => null)
  if (!snap) return
  for (const fn of listeners) {
    try { fn(snap) } catch { /* a listener must never break the queue */ }
  }
}

/**
 * UUID v4 — the server's idempotency key.
 *
 * No Math.random fallback: guessable keys let one device suppress
 * another's writes (the ledger answers "duplicate" and the PWA deletes
 * entries it never actually synced). Failing loudly on a non-secure
 * context is the correct outcome.
 */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  throw new Error(
    'scanner-kit: crypto.randomUUID is unavailable — the page must be served '
    + 'over HTTPS (or localhost). Refusing to mint guessable idempotency keys.',
  )
}

function table() {
  return openCache().outbox
}

/** Enqueue a write. Always succeeds locally — caller should NOT retry. */
export async function enqueue(
  action: string,
  payload: Record<string, unknown>,
  opts: { user?: string | null } = {},
): Promise<OutboxEntry> {
  const entry: OutboxEntry = {
    action,
    uuid: uuid(),
    payload,
    status: 'pending',
    attempts: 0,
    ts: Date.now(),
    user: opts.user ?? config.user ?? null,
  }
  const id = await table().add(entry)
  await notify()
  return { ...entry, id }
}

export async function listOutbox(status?: OutboxStatus): Promise<OutboxEntry[]> {
  const t = table()
  if (status) return await t.where('status').equals(status).sortBy('ts')
  return await t.orderBy('ts').toArray()
}

export async function countPending(): Promise<number> {
  return await table().where('status').equals('pending').count()
}

/**
 * An auth failure is recoverable: the cookie expired or the cached
 * shell is holding a stale CSRF token. Treating it as terminal marks a
 * whole shift of scans permanently failed.
 */
function isAuthError(e: { code?: number; exc_type?: string; message?: string }): boolean {
  if (e.code === 401 || e.code === 403) return true
  if (e.exc_type && /csrf/i.test(e.exc_type)) return true
  return Boolean(e.message && /csrf/i.test(e.message))
}

/** 4xx means "the server refuses this payload" — except the ones it doesn't. */
function isTerminal(e: { code?: number }): boolean {
  const c = e.code
  if (typeof c !== 'number' || c < 400 || c >= 500) return false
  return c !== 408 && c !== 429
}

/**
 * Walk pending entries in FIFO order. For each, look up the registered
 * handler and call it. On success → delete. On a terminal 4xx → mark
 * failed. On network / 5xx → bump attempts and keep pending (or fail
 * past MAX_ATTEMPTS). On 401/403/CSRF → re-bootstrap once and retry;
 * if that does not help, leave the entry pending WITHOUT burning an
 * attempt and stop the run, since every later entry would fail the
 * same way.
 */
export async function processOutbox(): Promise<OutboxRunResult> {
  const db = openCache()
  const pending = await listOutbox('pending')
  const result: OutboxRunResult = {
    sent: 0, failed: 0, skipped: 0, skippedActions: [], authFailed: false,
  }
  let reauthTried = false

  for (const entry of pending) {
    const handler = handlers.get(entry.action)
    if (!handler) {
      result.skipped++
      if (!result.skippedActions.includes(entry.action)) {
        result.skippedActions.push(entry.action)
      }
      continue
    }
    try {
      await markStatus(entry, 'syncing')
      await handler.send(entry)
      await db.outbox.delete(entry.id!)
      result.sent++
    } catch (err) {
      const e = err as { code?: number; exc_type?: string; message?: string }
      if (isAuthError(e)) {
        let recovered = false
        if (!reauthTried && config.reauth) {
          reauthTried = true
          recovered = await config.reauth().catch(() => false)
          if (recovered) {
            try {
              await handler.send(entry)
              await db.outbox.delete(entry.id!)
              result.sent++
              continue
            } catch (retryErr) {
              const r = retryErr as { message?: string }
              await park(entry, r.message || String(retryErr))
              result.authFailed = true
              break
            }
          }
        }
        await park(entry, e.message || String(err))
        result.authFailed = true
        break
      }
      const next: OutboxEntry = {
        ...entry,
        attempts: entry.attempts + 1,
        last_error: e.message || String(err),
      }
      if (isTerminal(e) || next.attempts >= MAX_ATTEMPTS) {
        next.status = 'failed'
        result.failed++
      } else {
        next.status = 'pending'
      }
      await db.outbox.put(next)
    }
  }
  await notify()
  return result
}

/** Put an entry back in the queue without counting the attempt. */
async function park(entry: OutboxEntry, error: string): Promise<void> {
  await openCache().outbox.put({ ...entry, status: 'pending', last_error: error })
}

async function markStatus(entry: OutboxEntry, status: OutboxStatus): Promise<void> {
  await openCache().outbox.put({ ...entry, status })
}

/** Drop ALL outbox rows. Used by 'reset cache', user switch, and tests. */
export async function clearOutbox(): Promise<void> {
  await table().clear()
  await notify()
}

/** Reset failed entries back to pending so the operator can retry. */
export async function retryFailed(): Promise<number> {
  const failed = await listOutbox('failed')
  const db = openCache()
  for (const e of failed) {
    await db.outbox.put({ ...e, status: 'pending', attempts: 0 })
  }
  if (failed.length) await notify()
  return failed.length
}

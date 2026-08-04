import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearOutbox, configureOutbox, countPending, enqueue, listOutbox,
  onOutboxChange, outboxSnapshot, processOutbox, registerOutboxHandler,
  retryFailed, uuid,
} from '../src/offlineQueue'
import { clearCache, openCache } from '../src/idbCache'

beforeEach(async () => {
  openCache('scanner-cache-test')
  await clearCache()
  await clearOutbox()
})
afterEach(async () => {
  await clearOutbox()
  await clearCache()
})

describe('offlineQueue.uuid', () => {
  it('returns RFC 4122 v4 shape', () => {
    const id = uuid()
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  })

  it('generates unique ids', () => {
    const ids = new Set(Array.from({ length: 100 }, () => uuid()))
    expect(ids.size).toBe(100)
  })
})

describe('offlineQueue.enqueue', () => {
  it('persists with status=pending and a UUID', async () => {
    const e = await enqueue('test_action', { x: 1 })
    expect(e.status).toBe('pending')
    expect(e.action).toBe('test_action')
    expect(e.payload).toEqual({ x: 1 })
    expect(e.uuid).toMatch(/^[0-9a-f-]+$/i)
  })

  it('countPending reflects the queue', async () => {
    await enqueue('a', {})
    await enqueue('b', {})
    expect(await countPending()).toBe(2)
  })
})

describe('offlineQueue.processOutbox', () => {
  it('calls registered handler and deletes on success', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true })
    registerOutboxHandler('do_thing', { send })
    await enqueue('do_thing', { hello: 'world' })

    const r = await processOutbox()
    expect(r.sent).toBe(1)
    expect(r.failed).toBe(0)
    expect(send).toHaveBeenCalledOnce()
    expect(await countPending()).toBe(0)
  })

  it('skips entries with no registered handler', async () => {
    await enqueue('unknown_action', {})
    const r = await processOutbox()
    expect(r.skipped).toBe(1)
    expect(await countPending()).toBe(1)
  })

  it('marks failed terminal on 4xx', async () => {
    const err = Object.assign(new Error('Bad request'), { code: 400 })
    registerOutboxHandler('bad', { send: vi.fn().mockRejectedValue(err) })
    await enqueue('bad', {})
    const r = await processOutbox()
    expect(r.failed).toBe(1)
    const failed = await listOutbox('failed')
    expect(failed.length).toBe(1)
    expect(failed[0]!.attempts).toBe(1)
  })

  it('keeps pending on transient error and bumps attempts', async () => {
    const err = Object.assign(new Error('Server boom'), { code: 503 })
    registerOutboxHandler('flaky', { send: vi.fn().mockRejectedValue(err) })
    await enqueue('flaky', {})
    const r = await processOutbox()
    expect(r.failed).toBe(0)
    const pending = await listOutbox('pending')
    expect(pending.length).toBe(1)
    expect(pending[0]!.attempts).toBe(1)
  })

  it('moves to failed once MAX_ATTEMPTS exceeded on transient', async () => {
    const err = Object.assign(new Error('Server boom'), { code: 503 })
    registerOutboxHandler('flakier', { send: vi.fn().mockRejectedValue(err) })
    await enqueue('flakier', {})
    // Run 5 times to exhaust the budget.
    for (let i = 0; i < 5; i++) await processOutbox()
    const failed = await listOutbox('failed')
    expect(failed.length).toBe(1)
    expect(failed[0]!.attempts).toBeGreaterThanOrEqual(5)
  })

  it('retryFailed resets failed entries to pending', async () => {
    const err = Object.assign(new Error('nope'), { code: 400 })
    registerOutboxHandler('mark_failed', { send: vi.fn().mockRejectedValue(err) })
    await enqueue('mark_failed', {})
    await processOutbox()
    expect((await listOutbox('failed')).length).toBe(1)

    const moved = await retryFailed()
    expect(moved).toBe(1)
    expect((await listOutbox('failed')).length).toBe(0)
    expect((await listOutbox('pending')).length).toBe(1)
  })

  it('names the skipped actions so diagnostics can show them', async () => {
    await enqueue('nobody_handles_this', {})
    await enqueue('nobody_handles_this', {})
    const r = await processOutbox()
    expect(r.skipped).toBe(2)
    expect(r.skippedActions).toEqual(['nobody_handles_this'])
  })
})

/**
 * A stale cookie or a cached shell's stale CSRF token is recoverable.
 * Treating it as terminal marked a whole shift of scans permanently
 * failed (§7.8).
 */
describe('offlineQueue: auth failures are not terminal', () => {
  afterEach(() => { configureOutbox({ user: null, reauth: null }) })

  for (const [label, err] of [
    ['401', Object.assign(new Error('Not permitted'), { code: 401 })],
    ['403', Object.assign(new Error('Forbidden'), { code: 403 })],
    ['CSRFTokenError', Object.assign(new Error('Invalid Request'), { exc_type: 'CSRFTokenError' })],
  ] as const) {
    it(`keeps the entry pending on ${label} with no re-auth wired`, async () => {
      registerOutboxHandler('auth_x', { send: vi.fn().mockRejectedValue(err) })
      await enqueue('auth_x', {})
      const r = await processOutbox()
      expect(r.failed).toBe(0)
      expect(r.authFailed).toBe(true)
      const pending = await listOutbox('pending')
      expect(pending).toHaveLength(1)
      // The attempt budget is not burned by a problem the entry did not cause.
      expect(pending[0]!.attempts).toBe(0)
    })
  }

  it('re-bootstraps once and retries', async () => {
    let authed = false
    const send = vi.fn().mockImplementation(async () => {
      if (!authed) throw Object.assign(new Error('Forbidden'), { code: 403 })
      return { ok: true }
    })
    registerOutboxHandler('auth_retry', { send })
    configureOutbox({ reauth: async () => { authed = true; return true } })

    await enqueue('auth_retry', {})
    const r = await processOutbox()
    expect(r.sent).toBe(1)
    expect(r.authFailed).toBe(false)
    expect(send).toHaveBeenCalledTimes(2)
    expect(await countPending()).toBe(0)
  })

  it('re-bootstraps at most once per run and stops the batch', async () => {
    const send = vi.fn().mockRejectedValue(
      Object.assign(new Error('Forbidden'), { code: 403 }),
    )
    const reauth = vi.fn().mockResolvedValue(true)
    registerOutboxHandler('auth_dead', { send })
    configureOutbox({ reauth })
    await enqueue('auth_dead', { i: 1 })
    await enqueue('auth_dead', { i: 2 })
    await enqueue('auth_dead', { i: 3 })

    const r = await processOutbox()
    expect(reauth).toHaveBeenCalledTimes(1)
    expect(r.authFailed).toBe(true)
    expect(r.failed).toBe(0)
    // All three survive for the next run; none burned an attempt.
    const pending = await listOutbox('pending')
    expect(pending).toHaveLength(3)
    expect(pending.every((e) => e.attempts === 0)).toBe(true)
  })

  it('still fails terminally on a genuine 400', async () => {
    registerOutboxHandler('bad_payload', {
      send: vi.fn().mockRejectedValue(Object.assign(new Error('nope'), { code: 400 })),
    })
    await enqueue('bad_payload', {})
    const r = await processOutbox()
    expect(r.failed).toBe(1)
    expect(r.authFailed).toBe(false)
  })

  it('retries 429 instead of failing it', async () => {
    registerOutboxHandler('rate_limited', {
      send: vi.fn().mockRejectedValue(Object.assign(new Error('slow down'), { code: 429 })),
    })
    await enqueue('rate_limited', {})
    const r = await processOutbox()
    expect(r.failed).toBe(0)
    expect((await listOutbox('pending'))[0]!.attempts).toBe(1)
  })
})

describe('offlineQueue: uuid has no guessable fallback', () => {
  it('throws instead of minting Math.random keys', () => {
    const original = globalThis.crypto
    // A non-secure context (old warehouse tablets, Safari < 15.4).
    Object.defineProperty(globalThis, 'crypto', {
      value: {}, configurable: true, writable: true,
    })
    try {
      expect(() => uuid()).toThrow(/randomUUID/)
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: original, configurable: true, writable: true,
      })
    }
  })
})

describe('offlineQueue: author stamping + change notifications', () => {
  afterEach(() => { configureOutbox({ user: null, reauth: null }) })

  it('stamps the configured user onto new entries', async () => {
    configureOutbox({ user: 'tecnico@docomexico.com' })
    const e = await enqueue('stamped', {})
    expect(e.user).toBe('tecnico@docomexico.com')
    expect((await listOutbox())[0]!.user).toBe('tecnico@docomexico.com')
  })

  it('lets the caller override per entry', async () => {
    configureOutbox({ user: 'a@x.mx' })
    const e = await enqueue('stamped', {}, { user: 'b@x.mx' })
    expect(e.user).toBe('b@x.mx')
  })

  it('notifies subscribers instead of making the badge poll', async () => {
    const seen: number[] = []
    const off = onOutboxChange((s) => seen.push(s.pending))
    await enqueue('watched', {})
    await enqueue('watched', {})
    registerOutboxHandler('watched', { send: vi.fn().mockResolvedValue({}) })
    await processOutbox()
    off()
    await enqueue('watched', {})
    expect(seen).toEqual([1, 2, 0])
  })

  it('snapshot separates pending from failed', async () => {
    registerOutboxHandler('snap_bad', {
      send: vi.fn().mockRejectedValue(Object.assign(new Error('no'), { code: 400 })),
    })
    await enqueue('snap_bad', {})
    await enqueue('no_handler_here', {})
    await processOutbox()
    expect(await outboxSnapshot()).toEqual({ pending: 1, failed: 1, total: 2 })
  })
})

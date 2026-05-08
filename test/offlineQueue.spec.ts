import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearOutbox, countPending, enqueue, listOutbox, processOutbox,
  registerOutboxHandler, retryFailed, uuid,
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
})

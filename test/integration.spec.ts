/**
 * End-to-end-ish: ingest → resolve → enqueue → process. Single
 * scenario that touches every Phase-1+3 module so a regression in
 * any one shows up here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  clearCache, ingestItems, openCache,
} from '../src/idbCache'
import { resolveScan } from '../src/scanResolver'
import {
  clearOutbox, enqueue, processOutbox, registerOutboxHandler,
} from '../src/offlineQueue'
import type { CachedItem } from '../src/types'

const item: CachedItem = {
  item_code: 'MOD00001',
  item_name: 'Pantalla SM A01',
  item_group: 'Pantallas Completas',
  brand: null,
  image: null,
  prices: { 'Standard Selling': 700 },
  stock_by_wh: { 'Escuinapa - DOCO': 5 },
  barcodes: ['7501055361020'],
  search_blob: 'mod00001 pantalla sm a01 7501055361020',
  cached_at: Date.now(),
}

beforeEach(async () => {
  openCache('scanner-cache-test')
  await clearCache()
  await clearOutbox()
})
afterEach(async () => {
  await clearOutbox()
  await clearCache()
})

describe('integration: scan → resolve → enqueue → commit', () => {
  it('walks the full happy path', async () => {
    // 1. Snapshot lands in the cache.
    await ingestItems([item])

    // 2. Operator scans the printed item_code (POS pattern).
    const scanned = await resolveScan('MOD00001', {
      context: 'taller',
      network: { online: () => true },
    })
    expect(scanned.type).toBe('barcode')
    expect(scanned.id).toBe('MOD00001')

    // 3. Operator decides to register a stock movement.
    const send = vi.fn().mockImplementation((entry) => {
      // The handler receives our enqueued payload + the UUID we
      // originally minted. Server-side dedupe (commit_outbox)
      // would hash this UUID into the idempotency ledger.
      expect(entry.uuid).toMatch(/^[0-9a-f-]+$/i)
      expect(entry.action).toBe('stock_move')
      return Promise.resolve({ status: 'queued' })
    })
    registerOutboxHandler('stock_move', { send })

    await enqueue('stock_move', {
      item_code: scanned.id,
      qty: -1,
      to: 'Escuinapa - DOCO',
    })

    // 4. Network comes back; outbox flushes.
    const r = await processOutbox()
    expect(r.sent).toBe(1)
    expect(send).toHaveBeenCalledOnce()
  })

  it('survives offline → reconnect with multiple queued writes', async () => {
    await ingestItems([item])
    const send = vi.fn().mockResolvedValue({ ok: true })
    registerOutboxHandler('stock_move', { send })

    // Three offline scans + enqueues.
    for (let i = 0; i < 3; i++) {
      const r = await resolveScan('MOD00001', {
        context: 'taller',
        network: { online: () => false },  // offline → no network call
      })
      expect(r.source).toBe('cache')
      await enqueue('stock_move', { item_code: r.id, qty: -1, idx: i })
    }

    // Reconnect → flush.
    const flushed = await processOutbox()
    expect(flushed.sent).toBe(3)
    expect(send).toHaveBeenCalledTimes(3)
  })
})

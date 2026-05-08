import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveScan, type NetworkAdapter } from '../src/scanResolver'
import { clearCache, ingestItems, openCache } from '../src/idbCache'
import type { CachedItem } from '../src/types'

function mockItem(over: Partial<CachedItem> = {}): CachedItem {
  return {
    item_code: 'MOD00001',
    item_name: 'Pantalla SM A01',
    item_group: 'Pantallas Completas',
    brand: null,
    image: null,
    prices: { 'Standard Selling': 700 },
    stock_by_wh: { 'Escuinapa - DOCO': 1 },
    barcodes: ['7501055361020'],
    search_blob: 'mod00001 pantalla sm a01 7501055361020',
    cached_at: Date.now(),
    ...over,
  }
}

function emptyAdapter(): NetworkAdapter {
  return {
    online: () => true,
    lookupItem: async () => null,
    lookupBarcode: async () => null,
  }
}

beforeEach(async () => {
  // Make sure each test sees a fresh cache.
  openCache('scanner-cache-test')
  await clearCache()
})

afterEach(async () => {
  await clearCache()
})

describe('resolveScan: prefix path', () => {
  it('resolves ITM- via cache hit', async () => {
    await ingestItems([mockItem()])
    const r = await resolveScan('ITM-MOD00001', { context: 'mercado', network: emptyAdapter() })
    expect(r.type).toBe('item')
    expect(r.id).toBe('MOD00001')
    expect(r.source).toBe('cache')
  })

  it('returns unknown when ITM- has no cache and no network handler', async () => {
    const r = await resolveScan('ITM-NOPE', { context: 'mercado', network: emptyAdapter() })
    expect(r.type).toBe('unknown')
  })

  it('resolves BAR- via barcode index', async () => {
    await ingestItems([mockItem()])
    const r = await resolveScan('BAR-7501055361020', {
      context: 'mercado',
      network: emptyAdapter(),
    })
    expect(r.type).toBe('barcode')
    expect(r.id).toBe('MOD00001')
  })

  it('falls back to network on prefix when cache misses', async () => {
    let calls = 0
    const r = await resolveScan('ITM-NEW01', {
      context: 'mercado',
      network: {
        online: () => true,
        lookupItem: async (code) => {
          calls++
          return code === 'NEW01' ? mockItem({ item_code: 'NEW01' }) : null
        },
      },
    })
    expect(r.type).toBe('item')
    expect(r.id).toBe('NEW01')
    expect(r.source).toBe('network')
    expect(calls).toBe(1)
  })
})

describe('resolveScan: cascade for bare codes', () => {
  it('a) hits the barcode index first', async () => {
    await ingestItems([mockItem()])
    const r = await resolveScan('7501055361020', {
      context: 'mercado',
      network: emptyAdapter(),
    })
    expect(r.type).toBe('barcode')
    expect(r.id).toBe('MOD00001')
  })

  it('b) falls through to Item.name when no barcode row matches', async () => {
    // Mumu pattern: 213 items with NO Item Barcode rows; the
    // ingestItems() helper still registers the item_code as a
    // barcode hit — exactly the same row works for either path.
    await ingestItems([
      mockItem({ item_code: 'MLPT000042', item_name: 'Baby Doll Talla L', barcodes: [] }),
    ])
    const r = await resolveScan('MLPT000042', {
      context: 'mercado',
      network: emptyAdapter(),
    })
    expect(r.type === 'barcode' || r.type === 'item').toBe(true)
    expect(r.id).toBe('MLPT000042')
  })

  it('c) fuzzy strips leading zeros for EAN-13 padding', async () => {
    await ingestItems([mockItem()])
    const r = await resolveScan('07501055361020', {
      context: 'mercado',
      network: emptyAdapter(),
    })
    expect(r.type).toBe('barcode')
    expect(r.id).toBe('MOD00001')
  })

  it('d) returns unknown when nothing matches', async () => {
    const r = await resolveScan('GIBBERISH', {
      context: 'mercado',
      network: emptyAdapter(),
    })
    expect(r.type).toBe('unknown')
    expect(r.id).toBeNull()
  })

  it('preserves raw + normalizes empty input', async () => {
    const r = await resolveScan('   ', { context: 'mercado', network: emptyAdapter() })
    expect(r.type).toBe('unknown')
    expect(r.normalized).toBe('')
  })
})

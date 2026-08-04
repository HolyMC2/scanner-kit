import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveScan, type NetworkAdapter } from '../src/scanResolver'
import { clearCache, ingestItems, ingestUbicaciones, openCache } from '../src/idbCache'
import { registerPrefix, resetPrefixRegistry } from '../src/prefixRegistry'
import type { CachedItem, CachedUbicacion } from '../src/types'

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
  resetPrefixRegistry()
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

describe('resolveScan: prefix-dispatch miss falls through (§7.2b)', () => {
  it('resolves INV-TEST-ITEM-OK as an item — a real doco-mirror Item', async () => {
    await ingestItems([mockItem({ item_code: 'INV-TEST-ITEM-OK', barcodes: [] })])
    const r = await resolveScan('INV-TEST-ITEM-OK', {
      context: 'scanner',
      network: emptyAdapter(),
    })
    expect(r.type === 'item' || r.type === 'barcode').toBe(true)
    expect(r.id).toBe('INV-TEST-ITEM-OK')
  })

  it('retries the FULL original string, not the stripped id', async () => {
    const seen: string[] = []
    await resolveScan('INV-TEST-ITEM-LOW', {
      context: 'scanner',
      network: {
        online: () => true,
        lookupInvoice: async () => null,
        lookupBarcode: async (c) => { seen.push(c); return null },
        lookupItem: async (c) => { seen.push(c); return null },
      },
    })
    expect(seen).toContain('INV-TEST-ITEM-LOW')
    expect(seen).not.toContain('TEST-ITEM-LOW')
  })

  it('drops the rejected prefix reading when the cascade succeeds', async () => {
    await ingestItems([mockItem({ item_code: 'INV-TEST-ITEM-OK', barcodes: [] })])
    const r = await resolveScan('INV-TEST-ITEM-OK', {
      context: 'scanner', network: emptyAdapter(),
    })
    expect(r.prefix).toBeNull()
  })

  it('keeps the prefix when the cascade also misses, so hosts routing by prefix still work', async () => {
    const r = await resolveScan('UBI-3700', { context: 'taller', network: emptyAdapter() })
    expect(r.type).toBe('unknown')
    expect(r.prefix).toBe('UBI')
    expect(r.normalized).toBe('UBI-3700')
  })

  it('does not re-run the cascade when the prefix resolves', async () => {
    let bare = 0
    const r = await resolveScan('ORD-RO-0001', {
      context: 'taller',
      network: {
        online: () => true,
        lookupOrder: async (n) => ({ name: n, status: 'Abierta' }),
        lookupItem: async () => { bare++; return null },
        lookupBarcode: async () => { bare++; return null },
      },
    })
    expect(r.type).toBe('orden')
    expect(bare).toBe(0)
  })
})

describe('resolveScan: UBI docname includes the prefix (finding #6)', () => {
  const bin: CachedUbicacion = {
    name: 'UBI-3700', label: 'Estante 2', parent: 'UBI-0001',
    hierarchy: ['Zona A', 'Estante 2'], cached_at: Date.now(),
  }

  it('hits the cache on the full docname', async () => {
    await ingestUbicaciones([bin])
    const r = await resolveScan('UBI-3700', { context: 'taller', network: emptyAdapter() })
    expect(r.type).toBe('ubicacion')
    expect(r.id).toBe('UBI-3700')
    expect(r.source).toBe('cache')
  })

  it('asks the network for the full docname, never the stripped id', async () => {
    const asked: string[] = []
    const r = await resolveScan('ubi-3700', {
      context: 'taller',
      network: {
        online: () => true,
        lookupUbicacion: async (n) => { asked.push(n); return n === 'UBI-3700' ? bin : null },
      },
    })
    expect(asked).toEqual(['UBI-3700'])
    expect(r.type).toBe('ubicacion')
    expect(r.id).toBe('UBI-3700')
  })
})

describe('resolveScan: registered prefixes', () => {
  it('dispatches to a host-supplied lookup', async () => {
    const lookup = vi.fn().mockResolvedValue({ payload: { name: 'RMA-9' } })
    registerPrefix('RMA', { type: 'devolucion', idIncludesPrefix: true, lookup })
    const r = await resolveScan('RMA-9', { context: 'scanner', network: emptyAdapter() })
    expect(lookup).toHaveBeenCalledWith('RMA-9', expect.objectContaining({ id: '9' }))
    expect(r.type).toBe('devolucion')
    expect(r.id).toBe('RMA-9')
  })

  it('falls through to the cascade when the host lookup misses', async () => {
    await ingestItems([mockItem({ item_code: 'RMA-9', barcodes: [] })])
    registerPrefix('RMA', { type: 'devolucion', lookup: async () => null })
    const r = await resolveScan('RMA-9', { context: 'scanner', network: emptyAdapter() })
    expect(r.id).toBe('RMA-9')
    expect(r.type === 'item' || r.type === 'barcode').toBe(true)
  })
})

describe('resolveScan: offlineMiss', () => {
  it('marks an unresolved code offline when the radio is down', async () => {
    const r = await resolveScan('GIBBERISH', {
      context: 'scanner', network: { online: () => false },
    })
    expect(r.type).toBe('unknown')
    expect(r.offlineMiss).toBe(true)
  })

  it('leaves it unset when the server genuinely said no', async () => {
    const r = await resolveScan('GIBBERISH', {
      context: 'scanner', network: emptyAdapter(),
    })
    expect(r.offlineMiss).toBeUndefined()
  })
})

describe('resolveScan: scale barcodes run before the lookups', () => {
  const scale = { enabled: true, prefix: '2', itemDigits: 5, valueDigits: 5 }

  it('looks up the embedded item digits and carries the weight', async () => {
    await ingestItems([mockItem({ item_code: '01234', barcodes: [] })])
    // 2 | 01234 | 01250 | 8  → item 01234, 1.250 kg
    const r = await resolveScan('201234012508', {
      context: 'scanner', network: emptyAdapter(), scale: { ...scale, totalLength: 12 },
    })
    expect(r.id).toBe('01234')
    expect(r.scale?.value).toBeCloseTo(1.25)
    expect(r.scale?.isWeight).toBe(true)
  })

  it('ignores an ordinary EAN-13 whose prefix does not match', async () => {
    await ingestItems([mockItem()])
    const r = await resolveScan('7501055361020', {
      context: 'scanner', network: emptyAdapter(), scale,
    })
    expect(r.id).toBe('MOD00001')
    expect(r.scale).toBeUndefined()
  })
})

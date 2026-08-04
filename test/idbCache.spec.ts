import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  cacheDbName, clearCache, configureCache, getByBarcode, getItem,
  ingestItems, openCache,
} from '../src/idbCache'
import { clearOutbox, enqueue, listOutbox } from '../src/offlineQueue'
import type { CachedItem } from '../src/types'

const sample: CachedItem = {
  item_code: 'IPN000098',
  item_name: 'Funda iPhone 14 Pro',
  item_group: 'Fundas',
  brand: 'Generico',
  image: null,
  prices: { 'Standard Selling': 199, 'Tecnicos Celular': 119 },
  stock_by_wh: { 'Escuinapa - DOCO': 12 },
  barcodes: ['7501234500987'],
  search_blob: 'ipn000098 funda iphone 14 pro 7501234500987',
  cached_at: Date.now(),
}

beforeEach(async () => {
  openCache('scanner-cache-test')
  await clearCache()
})
afterEach(async () => { await clearCache() })

describe('idbCache.ingestItems', () => {
  it('writes the item record', async () => {
    await ingestItems([sample])
    const r = await getItem('IPN000098')
    expect(r?.item_name).toBe('Funda iPhone 14 Pro')
    expect(r?.prices['Standard Selling']).toBe(199)
  })

  it('registers each barcode for reverse lookup', async () => {
    await ingestItems([sample])
    const byBc = await getByBarcode('7501234500987')
    expect(byBc?.item_code).toBe('IPN000098')
  })

  it('registers item_code itself as a barcode (POS pattern)', async () => {
    // doco's dominant pattern: 4755/4779 items use item_code as the
    // printed barcode. ingestItems must register it implicitly.
    await ingestItems([sample])
    const byCode = await getByBarcode('IPN000098')
    expect(byCode?.item_code).toBe('IPN000098')
  })

  it('handles items with no barcode rows (mumu pattern)', async () => {
    const noBc: CachedItem = { ...sample, item_code: 'MLPT000042', barcodes: [] }
    await ingestItems([noBc])
    // No barcode list → only the item_code → item_code mapping survives.
    const byCode = await getByBarcode('MLPT000042')
    expect(byCode?.item_code).toBe('MLPT000042')
  })

  it('upserts on bulkPut', async () => {
    await ingestItems([sample])
    await ingestItems([{ ...sample, item_name: 'Funda renamed' }])
    const r = await getItem('IPN000098')
    expect(r?.item_name).toBe('Funda renamed')
  })
})

/**
 * IndexedDB is per-origin and /scan, /taller and /mercado share one.
 * The database NAME is the whole isolation mechanism (§7.8b).
 */
describe('idbCache.configureCache', () => {
  afterEach(async () => {
    configureCache({ dbName: 'scanner-cache-test' })
    await clearCache()
    await clearOutbox()
  })

  it('is honoured by accessors that take no dbName argument', async () => {
    configureCache({ dbName: 'kit-a' })
    await clearCache()
    await ingestItems([sample])
    expect((await getItem('IPN000098'))?.item_code).toBe('IPN000098')

    configureCache({ dbName: 'kit-b' })
    await clearCache()
    expect(cacheDbName()).toBe('kit-b')
    // Would have been a hit before the fix, because every accessor
    // silently re-opened the default database.
    expect(await getItem('IPN000098')).toBeNull()
    expect(await getByBarcode('7501234500987')).toBeNull()

    configureCache({ dbName: 'kit-a' })
    expect((await getItem('IPN000098'))?.item_code).toBe('IPN000098')
  })

  it('gives each SPA its own OUTBOX, so neither accumulates the other undrainable', async () => {
    configureCache({ dbName: 'kit-scan' })
    await clearOutbox()
    await enqueue('scan_task_line', { a: 1 })

    configureCache({ dbName: 'kit-taller' })
    await clearOutbox()
    await enqueue('add_part_to_ro', { b: 2 })
    expect((await listOutbox()).map((e) => e.action)).toEqual(['add_part_to_ro'])

    configureCache({ dbName: 'kit-scan' })
    expect((await listOutbox()).map((e) => e.action)).toEqual(['scan_task_line'])
    await clearOutbox()
    configureCache({ dbName: 'kit-taller' })
    await clearOutbox()
  })

  it('openCache(name) configures too, so later bare calls agree', async () => {
    openCache('kit-c')
    expect(cacheDbName()).toBe('kit-c')
    await clearCache()
    await ingestItems([sample])
    expect((await getItem('IPN000098'))?.item_code).toBe('IPN000098')
    await clearCache()
  })

  it('ignores an empty or unchanged name', () => {
    configureCache({ dbName: 'kit-d' })
    configureCache({})
    configureCache({ dbName: '   ' })
    expect(cacheDbName()).toBe('kit-d')
  })
})

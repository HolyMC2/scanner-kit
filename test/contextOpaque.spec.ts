/**
 * `AppContext` widened from `'mercado'|'taller'` to `string` (SPEC §7.1)
 * on the strength of one claim: the kit never branches on it, it only
 * carries it. That claim has to stay true, or the new PWA's
 * `context: 'scanner'` silently takes a different code path.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveScan, type NetworkAdapter } from '../src/scanResolver'
import { clearCache, ingestItems, openCache } from '../src/idbCache'
import type { CachedItem } from '../src/types'

const SRC = resolve(__dirname, '../src')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) return sources(p)
    return /\.(ts|vue)$/.test(name) ? [p] : []
  })
}

const BRANCHES = [
  /\bcontext\s*(===|!==|==(?!=)|!=(?!=))/,
  /switch\s*\(\s*[\w.]*context\s*\)/,
  /\bcontext\s*\?\?/,
  /\bcontext\s*\?[^.]/,
]

describe('AppContext is opaque to the kit', () => {
  it('no source file branches on it', () => {
    const offenders: string[] = []
    for (const file of sources(SRC)) {
      const body = readFileSync(file, 'utf8')
      for (const re of BRANCHES) {
        if (re.test(body)) offenders.push(`${file} :: ${re}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('resolves identically whatever the host calls itself', async () => {
    openCache('scanner-cache-test')
    await clearCache()
    const item: CachedItem = {
      item_code: 'MOD00001', item_name: 'Pantalla SM A01',
      item_group: null, brand: null, image: null,
      prices: {}, stock_by_wh: {}, barcodes: ['7501055361020'],
      search_blob: '', cached_at: Date.now(),
    }
    await ingestItems([item])
    const network: NetworkAdapter = { online: () => true }

    const results = await Promise.all(
      ['mercado', 'taller', 'scanner', 'anything-at-all'].map((context) =>
        resolveScan('7501055361020', { context, network }),
      ),
    )
    const shape = ({ resolvedAt: _drop, ...rest }: (typeof results)[number]) => rest
    for (const r of results) expect(shape(r)).toEqual(shape(results[0]!))
    await clearCache()
  })
})

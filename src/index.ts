/**
 * @docomexico/scanner-kit — public API.
 *
 * Phase 0+1 surface: cache primitives + resolver + types.
 * Phase 2 will add the <QrScanner> Vue component.
 * Phase 3 will add the offline write queue.
 */

export * from './types'
export {
  openCache,
  getItem,
  getByBarcode,
  getUbicacion,
  ingestItems,
  ingestUbicaciones,
  getSyncMeta,
  setSyncMeta,
  clearCache,
  isStale,
  isAbandoned,
  STALE_AFTER_MS,
  ABANDON_AFTER_MS,
} from './idbCache'
export { resolveScan, parsePrefix } from './scanResolver'
export type { NetworkAdapter, ResolveOptions } from './scanResolver'
export { default as QrScanner } from './QrScanner.vue'
export { default as QrScanFab } from './QrScanFab.vue'
export { pickAdapter } from './adapters'
export type { ScannerAdapter, ScanCandidate } from './adapters'

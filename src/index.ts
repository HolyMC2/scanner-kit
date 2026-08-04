/**
 * @docomexico/scanner-kit — public API.
 *
 * Cache + resolver + prefix registry + scanner components + offline
 * outbox + QR/label generation + HID wedge. Every export here is part
 * of the contract two SPAs already build against; nothing is removed.
 */

export * from './types'
export {
  openCache,
  configureCache,
  cacheDbName,
  DEFAULT_DB_NAME,
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
export type { CacheConfig } from './idbCache'
export { resolveScan, parsePrefix } from './scanResolver'
export type { NetworkAdapter, ResolveOptions } from './scanResolver'

// Runtime prefix registry (§7.2).
export {
  registerPrefix, unregisterPrefix, getPrefix, isKnownPrefix,
  listPrefixes, resetPrefixRegistry,
  BUILTIN_PREFIXES, RESERVED_PREFIXES, LOCKED_PREFIXES, PREFIX_PATTERN,
} from './prefixRegistry'
export type {
  PrefixDefinition, RegisteredPrefix, PrefixLookupContext, PrefixLookupHit,
} from './prefixRegistry'

export { default as QrScanner } from './QrScanner.vue'
export { default as QrScanFab } from './QrScanFab.vue'
export { default as EmbeddedScanner } from './EmbeddedScanner.vue'
export { pickAdapter } from './adapters'
export type { ScannerAdapter, ScanCandidate } from './adapters'

// Repeat-scan policy shared by both scanner components (§7.4).
export { createDedupGate, resolveDedupWindow } from './dedup'
export type { DedupPolicy, DedupGate } from './dedup'

// Torch + camera flip (§7.7).
export { useCameraControls } from './cameraControls'
export type { CameraControls, CameraFacing } from './cameraControls'

// Offline outbox + reactive network state.
export {
  enqueue, listOutbox, countPending, processOutbox, outboxSnapshot,
  registerOutboxHandler, configureOutbox, onOutboxChange,
  retryFailed, clearOutbox, uuid,
} from './offlineQueue'
export type {
  OutboxHandler, OutboxStatus, OutboxConfig, OutboxSnapshot, OutboxRunResult,
} from './offlineQueue'
export {
  networkState, initNetworkState, refreshOutboxCount,
  runSync, syncStatus, syncStatusColor,
} from './networkState'
export type { SyncStatus } from './networkState'

// QR + label generation.
export { generateLabel, generateSheet } from './qrGenerator'
export type {
  LabelLayout, GenerateLabelOpts, SheetOpts,
  ItemLabelExtra, UbicacionLabelExtra, BoxLabelExtra,
} from './qrGenerator'
export { default as LabelSheet } from './LabelSheet.vue'
export { scannerOpen, openScanner } from './openScanner'

// HID keyboard wedge (§7.5).
export { useHidWedge } from './hidWedge'
export type { HidWedge, HidWedgeOptions } from './hidWedge'

// Weight/price-embedded EAN (§7.6, §9.2).
export {
  parseScaleBarcode, eanCheckDigit, DEFAULT_SCALE_SETTINGS,
} from './scaleBarcode'
export type { ScaleBarcodeSettings, ScaleSegment } from './scaleBarcode'

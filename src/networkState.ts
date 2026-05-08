/**
 * Reactive network + sync state. Consumed by the FAB to render the
 * status dot (green/orange/red) and the outbox-pending badge.
 *
 * Vue's reactivity is the only host dep — works with Vue 3 from any
 * SPA without a Pinia setup.
 */

import { computed, reactive, watch } from 'vue'
import { ABANDON_AFTER_MS, STALE_AFTER_MS } from './idbCache'
import { countPending, processOutbox } from './offlineQueue'

export type SyncStatus = 'online' | 'cached' | 'stale'

interface NetworkStateShape {
  online: boolean
  lastSyncAt: number
  outboxCount: number
  syncing: boolean
}

export const networkState = reactive<NetworkStateShape>({
  online: typeof navigator !== 'undefined' ? navigator.onLine : true,
  lastSyncAt: 0,
  outboxCount: 0,
  syncing: false,
})

let _initialized = false

export function initNetworkState(): void {
  if (_initialized || typeof window === 'undefined') return
  _initialized = true
  window.addEventListener('online', () => {
    networkState.online = true
    void refreshOutboxCount()
    // Auto-flush outbox on reconnect.
    void runSync()
  })
  window.addEventListener('offline', () => {
    networkState.online = false
  })
  // Also flush when the tab regains visibility — covers cases where
  // online never fired (e.g. mobile waking up).
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && networkState.online) {
      void runSync()
    }
  })
  // Best-effort initial pull.
  void refreshOutboxCount()
  // Watch the count so consumers can subscribe via a Vue watcher.
  watch(() => networkState.outboxCount, () => { /* visible to consumers */ })
}

export async function refreshOutboxCount(): Promise<void> {
  try {
    networkState.outboxCount = await countPending()
  } catch {
    networkState.outboxCount = 0
  }
}

export async function runSync(): Promise<void> {
  if (networkState.syncing || !networkState.online) return
  networkState.syncing = true
  try {
    await processOutbox()
    networkState.lastSyncAt = Date.now()
  } finally {
    await refreshOutboxCount().catch(() => { /* noop */ })
    networkState.syncing = false
  }
}

export const syncStatus = computed<SyncStatus>(() => {
  if (networkState.online) return 'online'
  const age = Date.now() - networkState.lastSyncAt
  return age < ABANDON_AFTER_MS ? 'cached' : 'stale'
})

/** Convenience for ad-hoc UI styling. Maps to colors documented in §5. */
export const syncStatusColor = computed<string>(() => {
  switch (syncStatus.value) {
    case 'online':
      return Date.now() - networkState.lastSyncAt < STALE_AFTER_MS ? '#10b981' : '#f59e0b'
    case 'cached':
      return '#f59e0b'
    case 'stale':
      return '#ef4444'
  }
})

<script setup lang="ts">
/**
 * Floating Action Button that toggles <QrScanner>. Each SPA mounts
 * one of these globally so the scanner is reachable from any view.
 *
 * Renders a status dot (green/orange/red) over the FAB based on
 * networkState + cache freshness, and a badge with the outbox count
 * when there are pending writes.
 */
import { onMounted, ref } from 'vue'
import QrScanner from './QrScanner.vue'
import type { NetworkAdapter } from './scanResolver'
import type { AppContext, ScanResult } from './types'
import {
  initNetworkState,
  networkState,
  syncStatusColor,
} from './networkState'

withDefaults(
  defineProps<{
    context: AppContext
    network: NetworkAdapter
    /**
     * 'rose' for mercado, 'teal' for taller — matches each SPA's
     * brand. Any CSS color string works.
     */
    color?: string
    /** Optional small label rendered next to the icon on wide layouts. */
    label?: string
  }>(),
  { color: '#e11d48' },
)

const emit = defineEmits<{
  (e: 'result', payload: ScanResult): void
}>()

const open = ref(false)

onMounted(() => {
  initNetworkState()
})

function handleResult(r: ScanResult) {
  open.value = false
  emit('result', r)
}
</script>

<template>
  <button
    type="button"
    class="qrs-fab"
    :style="{ '--fab-color': color }"
    aria-label="Abrir escáner"
    @click="open = true"
  >
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
      stroke-linecap="round" stroke-linejoin="round" class="qrs-fab-icon">
      <rect x="3" y="3" width="7" height="7" />
      <rect x="14" y="3" width="7" height="7" />
      <rect x="3" y="14" width="7" height="7" />
      <line x1="14" y1="14" x2="21" y2="21" />
      <line x1="14" y1="21" x2="17" y2="21" />
      <line x1="21" y1="14" x2="21" y2="17" />
    </svg>
    <span v-if="label" class="qrs-fab-label">{{ label }}</span>
    <span
      class="qrs-fab-dot"
      :style="{ background: syncStatusColor }"
      :title="networkState.online ? 'Online' : 'Offline · usando caché'"
    />
    <span
      v-if="networkState.outboxCount > 0"
      class="qrs-fab-badge"
      :title="networkState.outboxCount + ' por enviar'"
    >{{ networkState.outboxCount }}</span>
  </button>

  <QrScanner
    :open="open"
    :context="context"
    :network="network"
    @result="handleResult"
    @close="open = false"
  />
</template>

<style scoped>
.qrs-fab {
  position: fixed;
  right: 16px;
  bottom: calc(72px + env(safe-area-inset-bottom, 0));
  z-index: 50;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  background: var(--fab-color);
  color: #fff;
  border: none;
  padding: 14px;
  border-radius: 999px;
  box-shadow: 0 6px 16px rgba(0,0,0,0.25);
  cursor: pointer;
  transition: transform 120ms ease;
}
.qrs-fab:active { transform: scale(0.96); }
.qrs-fab-icon { width: 22px; height: 22px; }
.qrs-fab-dot {
  position: absolute;
  top: 4px;
  right: 4px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  border: 2px solid var(--fab-color);
}
.qrs-fab-badge {
  position: absolute;
  top: -4px;
  left: -4px;
  background: #f59e0b;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  border-radius: 999px;
  padding: 2px 6px;
  min-width: 18px;
  text-align: center;
  border: 2px solid var(--fab-color);
}
.qrs-fab-label {
  font-size: 13px;
  font-weight: 600;
  padding-right: 6px;
}
@media (max-width: 640px) {
  .qrs-fab-label { display: none; }
}
</style>

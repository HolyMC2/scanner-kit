<script setup lang="ts">
/**
 * <QrScanner> — fullscreen overlay scanner.
 *
 * Lives in scanner-kit so mercado + taller share one implementation.
 * The host SPA passes a NetworkAdapter (for resolveScan) and a
 * context. Result is emitted via the `result` event; the host wires
 * navigation. See ARCHITECTURE.md §5.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { resolveScan, type NetworkAdapter } from './scanResolver'
import type { AppContext, ScanResult } from './types'
import { pickAdapter, type ScannerAdapter } from './adapters'

const props = withDefaults(
  defineProps<{
    /** Show/hide the overlay. */
    open: boolean
    context: AppContext
    network: NetworkAdapter
    /** Auto-close overlay on a successful resolve. */
    closeOnSuccess?: boolean
    /**
     * Throttle window for repeat detections of the same code.
     * Helps when the camera reads the same QR for several frames in
     * a row.
     */
    sameCodeCooldownMs?: number
  }>(),
  { closeOnSuccess: true, sameCodeCooldownMs: 1500 },
)

const emit = defineEmits<{
  (e: 'close'): void
  (e: 'result', payload: ScanResult): void
  (e: 'error', payload: string): void
}>()

const video = ref<HTMLVideoElement | null>(null)
const stream = ref<MediaStream | null>(null)
const adapter = ref<ScannerAdapter | null>(null)

const status = ref<'idle' | 'starting' | 'running' | 'denied' | 'unsupported' | 'error'>('idle')
const errorMsg = ref<string>('')
const flashSuccess = ref(false)
const flashError = ref(false)
const manualOpen = ref(false)
const manualValue = ref('')
const lastDecoded = ref<{ text: string; at: number } | null>(null)

const showHeader = computed(() => props.open)

watch(
  () => props.open,
  async (v) => {
    if (v) await startCamera()
    else await stopCamera()
  },
)

onMounted(() => {
  if (props.open) void startCamera()
  window.addEventListener('keydown', onKey)
})

onBeforeUnmount(() => {
  void stopCamera()
  window.removeEventListener('keydown', onKey)
})

async function startCamera() {
  if (status.value === 'starting' || status.value === 'running') return
  status.value = 'starting'
  errorMsg.value = ''
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      status.value = 'unsupported'
      errorMsg.value = 'Cámara no disponible. Usa el ingreso manual.'
      return
    }
    stream.value = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    })
    if (video.value) {
      video.value.srcObject = stream.value
      // iOS needs both attributes set + a kicked play().
      video.value.setAttribute('playsinline', 'true')
      video.value.muted = true
      await video.value.play().catch(() => { /* autoplay blocked is OK */ })
    }
    adapter.value = await pickAdapter()
    if (video.value) {
      await adapter.value.start(video.value, onCandidate)
    }
    status.value = 'running'
  } catch (err) {
    const e = err as { name?: string; message?: string }
    if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
      status.value = 'denied'
      errorMsg.value = 'Permite acceso a la cámara, o usa el ingreso manual.'
    } else {
      status.value = 'error'
      errorMsg.value = e?.message || 'No se pudo abrir la cámara.'
    }
    emit('error', errorMsg.value)
  }
}

async function stopCamera() {
  try { await adapter.value?.stop() } catch { /* noop */ }
  adapter.value = null
  if (stream.value) {
    for (const t of stream.value.getTracks()) t.stop()
    stream.value = null
  }
  if (video.value) video.value.srcObject = null
  status.value = 'idle'
  manualOpen.value = false
  manualValue.value = ''
  lastDecoded.value = null
}

async function onCandidate({ text, format }: { text: string; format: import('./types').ScanFormat }) {
  if (!text) return
  const now = Date.now()
  if (
    lastDecoded.value
    && lastDecoded.value.text === text
    && now - lastDecoded.value.at < props.sameCodeCooldownMs
  ) {
    return
  }
  lastDecoded.value = { text, at: now }
  const result = await resolveScan(text, {
    context: props.context,
    network: props.network,
    format,
  })
  if (result.type === 'unknown') {
    fireError()
    // Still emit so the host can show a useful toast ('no se reconoció:
    // <raw>') instead of the user wondering whether anything happened.
    emit('result', result)
    return
  }
  fireSuccess()
  emit('result', result)
  if (props.closeOnSuccess) emit('close')
}

function fireSuccess() {
  flashSuccess.value = true
  try { navigator.vibrate?.(60) } catch { /* noop */ }
  setTimeout(() => (flashSuccess.value = false), 350)
}
function fireError() {
  flashError.value = true
  try { navigator.vibrate?.([40, 40, 40]) } catch { /* noop */ }
  setTimeout(() => (flashError.value = false), 600)
}

async function submitManual() {
  const v = manualValue.value.trim()
  if (!v) return
  await onCandidate({ text: v, format: 'unknown' })
  manualValue.value = ''
}

function onKey(e: KeyboardEvent) {
  if (!props.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    emit('close')
  }
}

function onBackdrop() {
  emit('close')
}
</script>

<template>
  <Teleport to="body">
    <transition name="qrs-fade">
      <div
        v-if="open"
        class="qrs-overlay"
        role="dialog"
        aria-modal="true"
        aria-label="Escáner"
        @click.self="onBackdrop"
      >
        <header v-if="showHeader" class="qrs-header">
          <div class="qrs-status" :class="`qrs-status-${status}`">
            <span class="qrs-dot" />
            <span>{{ statusLabel(status) }}</span>
          </div>
          <button class="qrs-close" aria-label="Cerrar escáner" @click="emit('close')">
            ✕
          </button>
        </header>

        <div class="qrs-stage">
          <video
            ref="video"
            class="qrs-video"
            playsinline
            muted
            autoplay
          />
          <div class="qrs-frame" :class="{ ok: flashSuccess, err: flashError }" />
        </div>

        <div class="qrs-hint">
          <p v-if="status === 'running'">Apunta al código — escaneo continuo.</p>
          <p v-else-if="status === 'starting'">Abriendo cámara…</p>
          <p v-else-if="status === 'denied'">{{ errorMsg }}</p>
          <p v-else-if="status === 'unsupported'">{{ errorMsg }}</p>
          <p v-else-if="status === 'error'">{{ errorMsg }}</p>
        </div>

        <div class="qrs-manual">
          <button
            v-if="!manualOpen"
            class="qrs-manual-toggle"
            type="button"
            @click="manualOpen = true"
          >
            Ingresar código manual
          </button>
          <form
            v-else
            class="qrs-manual-form"
            @submit.prevent="submitManual"
          >
            <input
              v-model="manualValue"
              type="text"
              autofocus
              placeholder="Ej. ITM-MOD00001 o MLPT000042"
              class="qrs-manual-input"
            />
            <button type="submit" class="qrs-manual-submit">
              Resolver
            </button>
          </form>
        </div>
      </div>
    </transition>
  </Teleport>
</template>

<script lang="ts">
function statusLabel(s: string): string {
  switch (s) {
    case 'starting': return 'Abriendo cámara…'
    case 'running': return 'Listo'
    case 'denied': return 'Sin permiso'
    case 'unsupported': return 'No soportado'
    case 'error': return 'Error'
    default: return ''
  }
}
export default { name: 'QrScanner' }
</script>

<style scoped>
.qrs-overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: #000;
  display: flex;
  flex-direction: column;
  color: #fff;
}
.qrs-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 16px;
  position: relative;
  z-index: 2;
}
.qrs-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  background: rgba(0,0,0,0.5);
  padding: 4px 10px;
  border-radius: 999px;
  backdrop-filter: blur(2px);
}
.qrs-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #f59e0b;
}
.qrs-status-running .qrs-dot { background: #10b981; }
.qrs-status-denied .qrs-dot,
.qrs-status-unsupported .qrs-dot,
.qrs-status-error .qrs-dot { background: #ef4444; }
.qrs-close {
  background: rgba(0,0,0,0.5);
  color: #fff;
  border: none;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  font-size: 18px;
  cursor: pointer;
}
.qrs-stage {
  flex: 1;
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.qrs-video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: #111;
}
.qrs-frame {
  position: absolute;
  width: min(78vw, 380px);
  height: min(78vw, 380px);
  border: 3px solid rgba(255,255,255,0.65);
  border-radius: 16px;
  pointer-events: none;
  transition: border-color 200ms ease, box-shadow 200ms ease;
}
.qrs-frame.ok {
  border-color: #10b981;
  box-shadow: 0 0 0 4px rgba(16,185,129,0.3);
}
.qrs-frame.err {
  border-color: #ef4444;
  box-shadow: 0 0 0 4px rgba(239,68,68,0.3);
}
.qrs-hint {
  text-align: center;
  padding: 12px 16px 4px;
  font-size: 13px;
  color: #d1d5db;
}
.qrs-hint p { margin: 0; }
.qrs-manual {
  padding: 12px 16px 24px;
  display: flex;
  justify-content: center;
}
.qrs-manual-toggle {
  background: rgba(255,255,255,0.12);
  color: #fff;
  border: 1px solid rgba(255,255,255,0.25);
  padding: 10px 16px;
  font-size: 13px;
  font-weight: 600;
  border-radius: 8px;
  cursor: pointer;
}
.qrs-manual-form {
  display: flex;
  gap: 8px;
  width: min(420px, 100%);
}
.qrs-manual-input {
  flex: 1;
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid rgba(255,255,255,0.25);
  background: rgba(255,255,255,0.08);
  color: #fff;
  font-size: 14px;
}
.qrs-manual-input::placeholder { color: rgba(255,255,255,0.5); }
.qrs-manual-submit {
  padding: 10px 16px;
  border-radius: 8px;
  border: none;
  background: #e11d48;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}

.qrs-fade-enter-active,
.qrs-fade-leave-active { transition: opacity 200ms ease; }
.qrs-fade-enter-from,
.qrs-fade-leave-to { opacity: 0; }
</style>

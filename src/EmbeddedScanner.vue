<script setup lang="ts">
/**
 * EmbeddedScanner — inline camera + barcode decode loop (NOT the
 * fullscreen QrScanner overlay). Renders a <video> that fills its
 * parent; the parent draws the viewfinder chrome. Emits the RAW
 * decoded text on every accept — resolution and tally policy belong to
 * the host (conteo wants deliberate re-scans of the same code to count).
 *
 * Camera lifecycle follows the `active` prop so the host can park the
 * camera when the user switches to manual mode without unmounting.
 *
 * Moved into the kit from mercado/frontend/src/components (SPEC §7.4).
 * mercado keeps its own copy until M2; test/embeddedContract.spec.ts
 * pins the two public contracts together so they cannot drift silently.
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { pickAdapter, type ScannerAdapter } from './adapters'
import { createDedupGate, resolveDedupWindow, type DedupPolicy } from './dedup'
import { useCameraControls } from './cameraControls'

type EmbeddedStatus =
  | 'idle' | 'starting' | 'running' | 'denied' | 'unsupported' | 'error'

const props = withDefaults(
  defineProps<{
    active: boolean
    /**
     * Max gap between decode FRAMES that still counts as one continuous
     * hold. Decode frames of a held code arrive every ~100-300ms; once
     * the gap exceeds this, the code left the viewfinder and came back —
     * a deliberate re-scan of an identical unit that MUST count
     * ("cada lectura suma +1"). The old fixed 1400ms cooldown swallowed
     * those re-scans and undercounted same-SKU stock (audit 2026-07-03).
     */
    sameCodeHoldMs?: number
    /** Alias accepted for parity with <QrScanner>. */
    sameCodeCooldownMs?: number
    /** See src/dedup.ts. Counting screens want the rolling gap. */
    dedupPolicy?: DedupPolicy
  }>(),
  { sameCodeHoldMs: undefined, sameCodeCooldownMs: undefined, dedupPolicy: 'rolling-gap' },
)

const emit = defineEmits<{
  (e: 'code', text: string): void
  (e: 'status', s: EmbeddedStatus): void
}>()

const video = ref<HTMLVideoElement | null>(null)
const stream = ref<MediaStream | null>(null)
const adapter = ref<ScannerAdapter | null>(null)
const status = ref<EmbeddedStatus>('idle')
const errorMsg = ref('')
const camera = useCameraControls()

const gate = createDedupGate(
  () => props.dedupPolicy,
  () => resolveDedupWindow(props.sameCodeHoldMs, props.sameCodeCooldownMs, 450),
)

function setStatus(s: EmbeddedStatus) {
  status.value = s
  emit('status', s)
}

async function start() {
  if (status.value === 'starting' || status.value === 'running') return
  setStatus('starting')
  errorMsg.value = ''
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unsupported')
      errorMsg.value = 'Cámara no disponible — usa el modo manual.'
      return
    }
    stream.value = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: camera.facing.value } },
      audio: false,
    })
    if (video.value) {
      video.value.srcObject = stream.value
      video.value.setAttribute('playsinline', 'true')
      video.value.muted = true
      await video.value.play().catch(() => { /* autoplay blocked is OK */ })
    }
    await camera.attach(stream.value)
    adapter.value = await pickAdapter()
    if (video.value) await adapter.value.start(video.value, onCandidate)
    setStatus('running')
  } catch (err) {
    const e = err as { name?: string; message?: string }
    if (e?.name === 'NotAllowedError' || e?.name === 'SecurityError') {
      setStatus('denied')
      errorMsg.value = 'Permite el acceso a la cámara, o usa el modo manual.'
    } else {
      setStatus('error')
      errorMsg.value = e?.message || 'No se pudo abrir la cámara.'
    }
  }
}

async function stop() {
  try { await adapter.value?.stop() } catch { /* noop */ }
  adapter.value = null
  if (stream.value) {
    for (const t of stream.value.getTracks()) t.stop()
    stream.value = null
  }
  if (video.value) video.value.srcObject = null
  camera.release()
  gate.reset()
  setStatus('idle')
}

function onCandidate({ text }: { text: string }) {
  if (!text) return
  if (!gate.accept(text)) return
  emit('code', text)
}

async function flipCamera() {
  camera.flip()
  await stop()
  if (props.active) await start()
}

watch(() => props.active, (v) => { if (v) void start(); else void stop() })
onMounted(() => { if (props.active) void start() })
onBeforeUnmount(() => { void stop() })

defineExpose({
  status,
  errorMsg,
  stream,
  torchSupported: camera.torchSupported,
  torchOn: camera.torchOn,
  toggleTorch: camera.toggleTorch,
  flipSupported: camera.flipSupported,
  flipCamera,
})
</script>

<template>
  <video ref="video" class="emb-video" />
  <div v-if="status !== 'running' && status !== 'idle'" class="emb-status mono">
    {{ status === 'starting' ? 'Abriendo cámara…' : errorMsg }}
  </div>
</template>

<style scoped>
.emb-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.emb-status {
  position: absolute;
  inset-inline: 12px;
  bottom: 12px;
  z-index: 2;
  text-align: center;
  font-size: 12px;
  color: #cdd3e0;
  background: rgba(10, 12, 18, 0.7);
  border-radius: 9px;
  padding: 7px 10px;
}
</style>

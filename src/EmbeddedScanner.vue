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
import { pickAdapter, type ScanCandidate, type ScannerAdapter } from './adapters'
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
interface ScanSession {
  stream: MediaStream | null
  adapter: ScannerAdapter | null
}
let session: ScanSession | null = null
function isCurrent(run: ScanSession) { return session === run && props.active }
function releaseStream(value: MediaStream | null) {
  for (const track of value?.getTracks() ?? []) track.stop()
}
function stopAdapter(value: ScannerAdapter | null) {
  try { void value?.stop().catch(() => { /* cleanup is best effort */ }) } catch { /* noop */ }
}
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
  if (session) return
  const run: ScanSession = { stream: null, adapter: null }
  session = run
  setStatus('starting')
  errorMsg.value = ''
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus('unsupported')
      errorMsg.value = 'Cámara no disponible — usa el modo manual.'
      return
    }
    const acquired = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: camera.facing.value } },
      audio: false,
    })
    if (!isCurrent(run)) {
      releaseStream(acquired)
      return
    }
    run.stream = acquired
    stream.value = acquired
    const player = video.value
    if (!player) { stop(); return }
    player.srcObject = acquired
    player.setAttribute('playsinline', 'true')
    player.muted = true
    await player.play().catch(() => { /* autoplay blocked is OK */ })
    if (!isCurrent(run)) return
    await camera.attach(acquired)
    if (!isCurrent(run)) return
    const selected = await pickAdapter()
    if (!isCurrent(run)) { stopAdapter(selected); return }
    run.adapter = selected
    await selected.start(player, (candidate) => onCandidate(run, candidate))
    if (!isCurrent(run)) { stopAdapter(selected); return }
    setStatus('running')
  } catch (err) {
    if (!isCurrent(run)) return
    stopAdapter(run.adapter)
    run.adapter = null
    releaseStream(run.stream)
    run.stream = null
    stream.value = null
    if (video.value) video.value.srcObject = null
    camera.release()
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

function stop() {
  // Revoke first; a pending permission, playback or adapter promise cannot
  // publish into a subsequent opening. Release our tracks synchronously.
  const previous = session
  session = null
  releaseStream(previous?.stream ?? null)
  if (previous) previous.stream = null
  stream.value = null
  if (video.value) video.value.srcObject = null
  camera.release()
  gate.reset()
  setStatus('idle')
  stopAdapter(previous?.adapter ?? null)
}

function onCandidate(run: ScanSession, { text }: ScanCandidate) {
  if (!isCurrent(run) || !text) return
  if (!gate.accept(text)) return
  emit('code', text)
}

async function flipCamera() {
  camera.flip()
  stop()
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

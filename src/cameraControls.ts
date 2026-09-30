/**
 * Torch + camera-flip controls (SPEC §7.7).
 *
 * Both are capability-gated: a phone without a torch track constraint
 * and a tablet with one camera must not render dead buttons. Callers
 * `attach()` the live MediaStream after getUserMedia resolves, and hide
 * each control while its `*Supported` ref is false.
 */

import { ref, type Ref } from 'vue'

export type CameraFacing = 'environment' | 'user'

export interface CameraControls {
  torchSupported: Ref<boolean>
  torchOn: Ref<boolean>
  toggleTorch: () => Promise<void>
  flipSupported: Ref<boolean>
  facing: Ref<CameraFacing>
  /** Toggle the facing mode. The host restarts the stream. */
  flip: () => CameraFacing
  attach: (stream: MediaStream | null) => Promise<void>
  release: () => void
}

interface TorchCapabilities {
  torch?: boolean
}

export function useCameraControls(): CameraControls {
  const torchSupported = ref(false)
  const torchOn = ref(false)
  const flipSupported = ref(false)
  const facing = ref<CameraFacing>('environment')
  let track: MediaStreamTrack | null = null
  let generation = 0

  async function probeFlip(owner: number): Promise<void> {
    try {
      const devices = await navigator.mediaDevices?.enumerateDevices?.()
      if (owner !== generation) return
      const cams = (devices ?? []).filter((d) => d.kind === 'videoinput')
      flipSupported.value = cams.length > 1
    } catch {
      if (owner !== generation) return
      flipSupported.value = false
    }
  }

  async function attach(stream: MediaStream | null): Promise<void> {
    const owner = ++generation
    track = stream?.getVideoTracks?.()[0] ?? null
    torchOn.value = false
    const caps = track?.getCapabilities?.() as TorchCapabilities | undefined
    torchSupported.value = Boolean(caps && 'torch' in caps && caps.torch)
    await probeFlip(owner)
  }

  async function toggleTorch(): Promise<void> {
    if (!track || !torchSupported.value) return
    const owner = generation
    const selectedTrack = track
    const next = !torchOn.value
    try {
      await selectedTrack.applyConstraints({
        advanced: [{ torch: next } as unknown as MediaTrackConstraintSet],
      })
      if (owner !== generation) return
      torchOn.value = next
    } catch {
      if (owner !== generation) return
      // Some Android stacks advertise torch and still refuse it; do not
      // strand the button in a lit state it never reached.
      torchSupported.value = false
      torchOn.value = false
    }
  }

  function flip(): CameraFacing {
    facing.value = facing.value === 'environment' ? 'user' : 'environment'
    return facing.value
  }

  function release(): void {
    generation += 1
    track = null
    torchOn.value = false
    torchSupported.value = false
    flipSupported.value = false
  }

  return {
    torchSupported, torchOn, toggleTorch,
    flipSupported, facing, flip,
    attach, release,
  }
}

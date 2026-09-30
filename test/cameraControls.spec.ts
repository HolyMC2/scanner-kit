import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useCameraControls } from '../src/cameraControls'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function cameraStream(torch = true) {
  const track = { getCapabilities: () => ({ torch }), applyConstraints: vi.fn().mockResolvedValue(undefined) }
  const stream = { getVideoTracks: () => [track] } as unknown as MediaStream
  return { stream, track }
}
let enumerate: ReturnType<typeof vi.fn>
beforeEach(() => {
  enumerate = vi.fn().mockResolvedValue([{ kind: 'videoinput' }, { kind: 'videoinput' }])
  vi.stubGlobal('navigator', { mediaDevices: { enumerateDevices: enumerate } })
})
afterEach(() => vi.unstubAllGlobals())

describe('camera controls pending operations', () => {
  it('does not restore camera capabilities after a released device probe resolves', async () => {
    const probe = deferred<MediaDeviceInfo[]>()
    enumerate.mockReturnValue(probe.promise)
    const camera = useCameraControls()
    const attached = camera.attach(cameraStream().stream)
    camera.release()
    probe.resolve([{ kind: 'videoinput' }, { kind: 'videoinput' }] as MediaDeviceInfo[])
    await attached
    expect(camera.flipSupported.value).toBe(false)
    expect(camera.torchSupported.value).toBe(false)
  })

  it.each(['resolve', 'reject'])('keeps a newer camera capability when an older probe %ss', async (result) => {
    const probe = deferred<MediaDeviceInfo[]>()
    enumerate.mockReturnValueOnce(probe.promise)
    const camera = useCameraControls()
    const oldAttach = camera.attach(cameraStream().stream)
    camera.release()
    await camera.attach(cameraStream().stream)
    expect(camera.flipSupported.value).toBe(true)
    if (result === 'resolve') probe.resolve([])
    else probe.reject(new Error('old device lost'))
    await oldAttach
    expect(camera.flipSupported.value).toBe(true)
    expect(camera.torchSupported.value).toBe(true)
  })

  it.each(['resolve', 'reject'])('keeps torch state with the new track when an old constraint request %ss', async (result) => {
    const constraint = deferred<void>()
    const old = cameraStream()
    const current = cameraStream()
    old.track.applyConstraints.mockReturnValue(constraint.promise)
    const camera = useCameraControls()
    await camera.attach(old.stream)
    const oldToggle = camera.toggleTorch()
    camera.release()
    await camera.attach(current.stream)
    if (result === 'resolve') constraint.resolve(undefined)
    else constraint.reject(new Error('old torch failed'))
    await oldToggle
    expect(camera.torchOn.value).toBe(false)
    expect(camera.torchSupported.value).toBe(true)
    await camera.toggleTorch()
    expect(current.track.applyConstraints).toHaveBeenCalledWith({ advanced: [{ torch: true }] })
    expect(camera.torchOn.value).toBe(true)
  })

  it('does not switch torch back on after its camera is released', async () => {
    const constraint = deferred<void>()
    const track = cameraStream()
    track.track.applyConstraints.mockReturnValue(constraint.promise)
    const camera = useCameraControls()
    await camera.attach(track.stream)
    const toggle = camera.toggleTorch()
    camera.release()
    constraint.resolve(undefined)
    await toggle
    expect(camera.torchOn.value).toBe(false)
    expect(camera.torchSupported.value).toBe(false)
    expect(camera.flipSupported.value).toBe(false)
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import EmbeddedScanner from '../src/EmbeddedScanner.vue'
import { NativeAdapter } from '../src/adapters/native'
import { ZxingAdapter } from '../src/adapters/zxing'

const zxing = vi.hoisted(() => ({ decode: vi.fn(), construct: vi.fn() }))
vi.mock('@zxing/browser', () => ({
  BrowserMultiFormatReader: class {
    constructor() { zxing.construct() }
    decodeFromVideoElement = zxing.decode
  },
}))
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function cameraStream() {
  const tracks = [{ stop: vi.fn(), getCapabilities: () => ({ torch: true }) }, { stop: vi.fn() }]
  const stream = Object.assign(new MediaStream(), {
    getTracks: () => tracks as unknown as MediaStreamTrack[],
    getVideoTracks: () => [tracks[0]] as unknown as MediaStreamTrack[],
  })
  return { stream, tracks }
}
function expectStopped(camera: ReturnType<typeof cameraStream>, times = 1) {
  for (const track of camera.tracks) expect(track.stop).toHaveBeenCalledTimes(times)
}
function barcode(text = '356938035643809') { return { rawValue: text, format: 'code_128' } }
function zxResult(text = '356938035643809') { return { getText: () => text, getBarcodeFormat: () => 'CODE_128' } }
let wrapper: VueWrapper<any> | undefined
let media: ReturnType<typeof vi.fn>
let formats: ReturnType<typeof vi.fn>
let detect: ReturnType<typeof vi.fn>
let enumerate: ReturnType<typeof vi.fn>
let play: ReturnType<typeof vi.spyOn>
let frames: Map<number, FrameRequestCallback>
function render() {
  wrapper = mount(EmbeddedScanner, { props: { active: true } })
  return wrapper
}
async function nextFrame() {
  const [id, callback] = [...frames][0]!
  frames.delete(id)
  callback(0)
  await flushPromises()
}

beforeEach(() => {
  wrapper = undefined
  media = vi.fn()
  formats = vi.fn().mockResolvedValue(['qr_code', 'code_128'])
  detect = vi.fn().mockResolvedValue([])
  enumerate = vi.fn().mockResolvedValue([{ kind: 'videoinput' }])
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.stubGlobal('BarcodeDetector', class {
    static getSupportedFormats = formats
    detect = detect
  })
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: media, enumerateDevices: enumerate } })
  frames = new Map()
  let id = 0
  vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++id, callback); return id }))
  vi.stubGlobal('cancelAnimationFrame', vi.fn((handle: number) => frames.delete(handle)))
  zxing.decode.mockReset()
  zxing.construct.mockClear()
})
afterEach(() => {
  wrapper?.unmount()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('EmbeddedScanner resource lifecycle with real adapters', () => {
  it.each(['close', 'unmount'])('releases permission results after %s without playback, decoding or late status', async (action) => {
    const permission = deferred<MediaStream>()
    const camera = cameraStream()
    media.mockReturnValue(permission.promise)
    const ui = render()
    if (action === 'close') await ui.setProps({ active: false })
    else ui.unmount()
    const statusCount = ui.emitted('status')!.length
    permission.resolve(camera.stream)
    await flushPromises()
    expectStopped(camera)
    expect(play).not.toHaveBeenCalled()
    expect(formats).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
    expect(ui.emitted('code')).toBeUndefined()
    expect(ui.emitted('status')).toHaveLength(statusCount)
  })

  it.each(['old-first', 'new-first'])('keeps stream ownership across close/reopen when permissions finish %s', async (order) => {
    const first = deferred<MediaStream>()
    const second = deferred<MediaStream>()
    const old = cameraStream()
    const current = cameraStream()
    media.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const ui = render()
    await ui.setProps({ active: false })
    await ui.setProps({ active: true })
    expect(media).toHaveBeenCalledTimes(2)
    if (order === 'old-first') {
      first.resolve(old.stream)
      await flushPromises()
      expectStopped(old)
      expect(play).not.toHaveBeenCalled()
      second.resolve(current.stream)
    } else {
      second.resolve(current.stream)
      await flushPromises()
      first.resolve(old.stream)
    }
    await flushPromises()
    expectStopped(old)
    expectStopped(current, 0)
    expect(ui.vm.status).toBe('running')
    expect(ui.vm.stream).toBe(current.stream)
    expect((ui.get('video').element as HTMLVideoElement).srcObject).toBe(current.stream)
    expect(frames.size).toBe(1)
    await ui.setProps({ active: false })
    expectStopped(current)
    expect(ui.vm.stream).toBeNull()
    expect(frames.size).toBe(0)
  })

  it('ignores a rejected permission from an older opening', async () => {
    const permission = deferred<MediaStream>()
    const camera = cameraStream()
    media.mockReturnValueOnce(permission.promise).mockResolvedValueOnce(camera.stream)
    const ui = render()
    await ui.setProps({ active: false })
    await ui.setProps({ active: true })
    await flushPromises()
    permission.reject({ name: 'NotAllowedError' })
    await flushPromises()
    expect(ui.vm.status).toBe('running')
    expect(ui.vm.errorMsg).toBe('')
    expectStopped(camera, 0)
  })

  it('does not resume a closed opening after its playback completes', async () => {
    const playback = deferred<void>()
    const old = cameraStream()
    const current = cameraStream()
    media.mockResolvedValueOnce(old.stream).mockResolvedValueOnce(current.stream)
    play.mockReturnValueOnce(playback.promise)
    const ui = render()
    await flushPromises()
    await ui.setProps({ active: false })
    await ui.setProps({ active: true })
    await flushPromises()
    playback.resolve(undefined)
    await flushPromises()
    expectStopped(old)
    expectStopped(current, 0)
    expect(formats).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(1)
    expect(ui.vm.stream).toBe(current.stream)
  })

  it('releases tracks while format negotiation is pending and never starts its adapter afterward', async () => {
    const negotiation = deferred<string[]>()
    const camera = cameraStream()
    media.mockResolvedValue(camera.stream)
    formats.mockReturnValue(negotiation.promise)
    const ui = render()
    await flushPromises()
    expect(formats).toHaveBeenCalledTimes(1)
    await ui.setProps({ active: false })
    expectStopped(camera)
    negotiation.resolve(['qr_code', 'code_128'])
    await flushPromises()
    expect(frames.size).toBe(0)
    expect(ui.vm.status).toBe('idle')
    expect(ui.emitted('code')).toBeUndefined()
  })

  it('does not let a stale device probe overwrite reopened camera controls', async () => {
    const probe = deferred<MediaDeviceInfo[]>()
    const old = cameraStream()
    const current = cameraStream()
    enumerate.mockReturnValueOnce(probe.promise).mockResolvedValueOnce([{ kind: 'videoinput' }, { kind: 'videoinput' }])
    media.mockResolvedValueOnce(old.stream).mockResolvedValueOnce(current.stream)
    const ui = render()
    await flushPromises()
    await ui.setProps({ active: false })
    await ui.setProps({ active: true })
    await flushPromises()
    expect(ui.vm.flipSupported).toBe(true)
    probe.resolve([])
    await flushPromises()
    expect(ui.vm.flipSupported).toBe(true)
    expect(formats).toHaveBeenCalledTimes(1)
    expect(ui.vm.status).toBe('running')
    expectStopped(old)
    expectStopped(current, 0)
  })

  it('discards a pending native decode after reopen without adding a second frame loop', async () => {
    const frame = deferred<ReturnType<typeof barcode>[]>()
    const old = cameraStream()
    const current = cameraStream()
    detect.mockReturnValueOnce(frame.promise).mockResolvedValue([barcode()])
    media.mockResolvedValueOnce(old.stream).mockResolvedValueOnce(current.stream)
    const ui = render()
    await flushPromises()
    await nextFrame()
    await ui.setProps({ active: false })
    await ui.setProps({ active: true })
    await flushPromises()
    await nextFrame()
    expect(ui.emitted('code')).toEqual([['356938035643809']])
    frame.resolve([barcode('490154203237518')])
    await flushPromises()
    expect(ui.emitted('code')).toEqual([['356938035643809']])
    expect(frames.size).toBe(1)
    await ui.setProps({ active: false })
    expectStopped(old)
    expectStopped(current)
    expect(frames.size).toBe(0)
  })

  it.each(['close', 'unmount'])('stops late ZXing controls after %s and ignores callbacks before controls arrive', async (action) => {
    const decoding = deferred<{ stop: () => void }>()
    const camera = cameraStream()
    const controls = { stop: vi.fn() }
    formats.mockResolvedValue([])
    media.mockResolvedValue(camera.stream)
    zxing.decode.mockReturnValue(decoding.promise)
    const ui = render()
    await flushPromises()
    expect(zxing.decode).toHaveBeenCalledTimes(1)
    const callback = zxing.decode.mock.calls[0]![1]
    if (action === 'close') await ui.setProps({ active: false })
    else ui.unmount()
    expectStopped(camera)
    const statusCount = ui.emitted('status')!.length
    callback(zxResult())
    decoding.resolve(controls)
    await flushPromises()
    expect(controls.stop).toHaveBeenCalledTimes(1)
    expect(ui.emitted('code')).toBeUndefined()
    expect(ui.emitted('status')).toHaveLength(statusCount)
  })

  it.each(['old-first', 'new-first'])('keeps ZXing controls and callbacks with their opening when controls arrive %s', async (order) => {
    const first = deferred<{ stop: () => void }>()
    const second = deferred<{ stop: () => void }>()
    const old = cameraStream()
    const current = cameraStream()
    const oldControls = { stop: vi.fn() }
    const currentControls = { stop: vi.fn() }
    formats.mockResolvedValue([])
    media.mockResolvedValueOnce(old.stream).mockResolvedValueOnce(current.stream)
    zxing.decode.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const ui = render()
    await flushPromises()
    const oldCallback = zxing.decode.mock.calls[0]![1]
    await ui.setProps({ active: false })
    await ui.setProps({ active: true })
    await flushPromises()
    const currentCallback = zxing.decode.mock.calls[1]![1]
    if (order === 'old-first') {
      first.resolve(oldControls)
      await flushPromises()
      second.resolve(currentControls)
    } else {
      second.resolve(currentControls)
      await flushPromises()
      first.resolve(oldControls)
    }
    await flushPromises()
    oldCallback(zxResult('old-code'))
    currentCallback(zxResult('current-code'))
    currentCallback(zxResult('current-code'))
    expect(ui.emitted('code')).toEqual([['current-code']])
    expect(oldControls.stop).toHaveBeenCalledTimes(1)
    expect(currentControls.stop).not.toHaveBeenCalled()
    expectStopped(old)
    expectStopped(current, 0)
    expect(ui.vm.status).toBe('running')
    await ui.setProps({ active: false })
    expectStopped(current)
    expect(currentControls.stop).toHaveBeenCalledTimes(1)
    currentCallback(zxResult('closed-code'))
    expect(ui.emitted('code')).toEqual([['current-code']])
  })

  it('releases tracks and clears the video even when decoder cleanup throws', async () => {
    const camera = cameraStream()
    const controls = { stop: vi.fn(() => { throw new Error('decoder cleanup failed') }) }
    formats.mockResolvedValue([])
    media.mockResolvedValue(camera.stream)
    zxing.decode.mockResolvedValue(controls)
    const ui = render()
    await flushPromises()
    await ui.setProps({ active: false })
    expectStopped(camera)
    expect(ui.vm.stream).toBeNull()
    expect((ui.get('video').element as HTMLVideoElement).srcObject).toBeNull()
    expect(ui.vm.status).toBe('idle')
  })

  it('releases acquired tracks when decoder startup fails and keeps its recovery message', async () => {
    const camera = cameraStream()
    formats.mockResolvedValue([])
    media.mockResolvedValue(camera.stream)
    zxing.decode.mockRejectedValue(new Error('No se pudo iniciar el lector'))
    const ui = render()
    await flushPromises()
    expectStopped(camera)
    expect(ui.vm.status).toBe('error')
    expect(ui.text()).toContain('No se pudo iniciar el lector')
    expect(ui.vm.stream).toBeNull()
    expect((ui.get('video').element as HTMLVideoElement).srcObject).toBeNull()
    await ui.setProps({ active: false })
    expectStopped(camera)
  })

  it('preserves the camera-flip promise and cancels its new permission request on close', async () => {
    const permission = deferred<MediaStream>()
    const old = cameraStream()
    const flipped = cameraStream()
    media.mockResolvedValueOnce(old.stream).mockReturnValueOnce(permission.promise)
    const ui = render()
    await flushPromises()
    const flip = ui.vm.flipCamera()
    expect(flip).toBeInstanceOf(Promise)
    expectStopped(old)
    expect(media.mock.calls[1]![0]).toMatchObject({ video: { facingMode: { ideal: 'user' } } })
    await ui.setProps({ active: false })
    permission.resolve(flipped.stream)
    await flip
    expectStopped(flipped)
    expect(ui.vm.status).toBe('idle')
    expect(frames.size).toBe(0)
  })

  it('resets its scan gate so the same code can be accepted after reopening', async () => {
    const old = cameraStream()
    const current = cameraStream()
    formats.mockResolvedValue([])
    media.mockResolvedValueOnce(old.stream).mockResolvedValueOnce(current.stream)
    zxing.decode.mockResolvedValue({ stop: vi.fn() })
    const ui = render()
    await flushPromises()
    zxing.decode.mock.calls[0]![1](zxResult())
    zxing.decode.mock.calls[0]![1](zxResult())
    await ui.setProps({ active: false })
    await ui.setProps({ active: true })
    await flushPromises()
    zxing.decode.mock.calls[1]![1](zxResult())
    expect(ui.emitted('code')).toEqual([['356938035643809'], ['356938035643809']])
  })
})

describe('adapter reuse independent of the component', () => {
  it.each(['resolve', 'reject'])('native adapter never emits or reschedules when a stopped frame later %ss', async (result) => {
    const frame = deferred<ReturnType<typeof barcode>[]>()
    const adapter = new NativeAdapter()
    const onCode = vi.fn()
    detect.mockReturnValueOnce(frame.promise)
    await adapter.start(document.createElement('video'), onCode)
    await nextFrame()
    await adapter.stop()
    if (result === 'resolve') frame.resolve([barcode()])
    else frame.reject(new Error('bad frame'))
    await flushPromises()
    expect(onCode).not.toHaveBeenCalled()
    expect(frames.size).toBe(0)
  })

  it('native adapter owns its pending frame across a restart of the same instance', async () => {
    const oldFrame = deferred<ReturnType<typeof barcode>[]>()
    const adapter = new NativeAdapter()
    const oldCode = vi.fn()
    const currentCode = vi.fn()
    detect.mockReturnValueOnce(oldFrame.promise).mockResolvedValue([barcode()])
    const video = document.createElement('video')
    await adapter.start(video, oldCode)
    await nextFrame()
    await adapter.start(video, currentCode)
    await nextFrame()
    oldFrame.resolve([barcode('old')])
    await flushPromises()
    expect(oldCode).not.toHaveBeenCalled()
    expect(currentCode).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(1)
    await adapter.stop()
    expect(frames.size).toBe(0)
  })

  it('ZXing startup stopped while loading its API never allocates a reader', async () => {
    const adapter = new ZxingAdapter()
    const start = adapter.start(document.createElement('video'), vi.fn())
    await adapter.stop()
    await start
    expect(zxing.construct).not.toHaveBeenCalled()
    expect(zxing.decode).not.toHaveBeenCalled()
  })

  it('ZXing controls arriving after same-instance restart stop only their own decoder', async () => {
    const decoding = deferred<{ stop: () => void }>()
    const oldControls = { stop: vi.fn() }
    const currentControls = { stop: vi.fn() }
    const oldCode = vi.fn()
    const currentCode = vi.fn()
    const adapter = new ZxingAdapter()
    const video = document.createElement('video')
    zxing.decode.mockReturnValueOnce(decoding.promise).mockResolvedValueOnce(currentControls)
    const first = adapter.start(video, oldCode)
    await flushPromises()
    await adapter.start(video, currentCode)
    decoding.resolve(oldControls)
    await first
    zxing.decode.mock.calls[0]![1](zxResult('old'))
    zxing.decode.mock.calls[1]![1](zxResult('current'))
    expect(oldControls.stop).toHaveBeenCalledTimes(1)
    expect(currentControls.stop).not.toHaveBeenCalled()
    expect(oldCode).not.toHaveBeenCalled()
    expect(currentCode).toHaveBeenCalledTimes(1)
    await adapter.stop()
    expect(currentControls.stop).toHaveBeenCalledTimes(1)
  })
})

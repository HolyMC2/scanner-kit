/**
 * Native BarcodeDetector adapter. Available on Chrome/Edge/Android;
 * Safari iOS does NOT implement it (so isAvailable returns false there
 * and pickAdapter falls back to ZxingAdapter).
 */
import type { ScanCandidate, ScannerAdapter } from './types'
import type { ScanFormat } from '../types'

declare global {
  interface Window {
    BarcodeDetector?: {
      getSupportedFormats?: () => Promise<string[]>
      new (opts?: { formats?: string[] }): {
        detect: (img: CanvasImageSource) => Promise<Array<{ rawValue: string; format: string }>>
      }
    }
  }
}

const NATIVE_FORMATS = [
  'qr_code', 'ean_13', 'ean_8', 'upc_a', 'code_128', 'code_39', 'data_matrix',
]

function mapFormat(f: string): ScanFormat {
  const s = f.toLowerCase()
  if (NATIVE_FORMATS.includes(s)) return s as ScanFormat
  return 'unknown'
}

export class NativeAdapter implements ScannerAdapter {
  private session: {
    detector: InstanceType<NonNullable<Window['BarcodeDetector']>>
    rafId: number | null
  } | null = null

  async isAvailable(): Promise<boolean> {
    if (typeof window === 'undefined' || !window.BarcodeDetector) return false
    try {
      const supported = (await window.BarcodeDetector.getSupportedFormats?.()) ?? []
      // Need QR + at least one EAN to be useful; otherwise let zxing handle it.
      return supported.includes('qr_code') && supported.some(
        (f) => f === 'ean_13' || f === 'ean_8' || f === 'code_128',
      )
    } catch {
      return false
    }
  }

  async start(
    video: HTMLVideoElement,
    onResult: (c: ScanCandidate) => void,
  ): Promise<void> {
    if (!window.BarcodeDetector) throw new Error('BarcodeDetector not available')
    void this.stop()
    const run = { detector: new window.BarcodeDetector({ formats: NATIVE_FORMATS }), rafId: null as number | null }
    this.session = run
    let lastEmitAt = 0
    const tick = async () => {
      if (this.session !== run) return
      try {
        const results = await run.detector.detect(video)
        if (this.session !== run) return
        const now = Date.now()
        // Throttle to one emit per 800 ms to avoid double-fire.
        if (results.length && now - lastEmitAt > 800) {
          lastEmitAt = now
          const r = results[0]!
          onResult({ text: r.rawValue, format: mapFormat(r.format) })
        }
      } catch {
        // Detector errors on bad frames are normal; ignore and reschedule.
      }
      if (this.session === run) run.rafId = requestAnimationFrame(tick)
    }
    run.rafId = requestAnimationFrame(tick)
  }

  async stop(): Promise<void> {
    const previous = this.session
    this.session = null
    if (previous?.rafId != null) cancelAnimationFrame(previous.rafId)
  }
}

/**
 * ZXing-backed adapter. Lazy-loaded by pickAdapter() so the
 * 180 KB gzip cost only hits the bundle once the user actually
 * opens the scanner.
 */
import type { ScanCandidate, ScannerAdapter } from './types'
import type { ScanFormat } from '../types'

// Light type aliases — the kit deliberately avoids re-exporting
// @zxing/browser's full surface so the .d.ts tree stays small.
type ScannerControls = { stop: () => void }
type DecodeResult = {
  getText: () => string
  getBarcodeFormat: () => unknown
}
type ZxingApi = {
  BrowserMultiFormatReader: new () => {
    decodeFromVideoElement(
      source: HTMLVideoElement,
      cb: (result: DecodeResult | undefined, err?: unknown) => void,
    ): Promise<ScannerControls>
  }
}

let _api: ZxingApi | null = null

async function loadApi(): Promise<ZxingApi> {
  if (_api) return _api
  const mod = (await import('@zxing/browser')) as unknown as ZxingApi
  _api = mod
  return _api
}

function mapFormat(zxFormat: unknown): ScanFormat {
  const s = String(zxFormat ?? '').toUpperCase()
  if (s.includes('QR')) return 'qr_code'
  if (s.includes('EAN_13')) return 'ean_13'
  if (s.includes('EAN_8')) return 'ean_8'
  if (s.includes('UPC_A')) return 'upc_a'
  if (s.includes('CODE_128')) return 'code_128'
  if (s.includes('CODE_39')) return 'code_39'
  if (s.includes('DATA_MATRIX')) return 'data_matrix'
  return 'unknown'
}

export class ZxingAdapter implements ScannerAdapter {
  private controls: ScannerControls | null = null

  isAvailable(): boolean {
    return true
  }

  async start(
    video: HTMLVideoElement,
    onResult: (c: ScanCandidate) => void,
  ): Promise<void> {
    const api = await loadApi()
    const reader = new api.BrowserMultiFormatReader()
    this.controls = await reader.decodeFromVideoElement(video, (result, _err) => {
      if (!result) return
      const text = result.getText()
      const fmt = result.getBarcodeFormat()
      if (text) onResult({ text, format: mapFormat(fmt) })
    })
  }

  async stop(): Promise<void> {
    try { this.controls?.stop() } catch { /* noop */ }
    this.controls = null
  }
}

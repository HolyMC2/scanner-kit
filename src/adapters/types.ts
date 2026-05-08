/**
 * Common scanner-adapter interface. The concrete implementations
 * (ZxingAdapter, NativeAdapter) live alongside; the <QrScanner>
 * component picks one at runtime via pickAdapter().
 */
import type { ScanFormat } from '../types'

export interface ScanCandidate {
  text: string
  format: ScanFormat
}

export interface ScannerAdapter {
  /** Cheap probe — must return quickly; runs once at adapter pick. */
  isAvailable(): Promise<boolean> | boolean
  /**
   * Start scanning a video element. The adapter calls onResult on
   * each successful decode. The returned function stops the loop +
   * releases internal resources (NOT the MediaStream — caller owns it).
   */
  start(video: HTMLVideoElement, onResult: (c: ScanCandidate) => void): Promise<void>
  stop(): Promise<void>
}

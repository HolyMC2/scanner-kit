import type { ScannerAdapter } from './types'
import { NativeAdapter } from './native'
import { ZxingAdapter } from './zxing'

export type { ScannerAdapter, ScanCandidate } from './types'

/** Pick the best adapter for the current environment. */
export async function pickAdapter(): Promise<ScannerAdapter> {
  const native = new NativeAdapter()
  if (await native.isAvailable()) return native
  return new ZxingAdapter()
}

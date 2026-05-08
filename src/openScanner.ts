/**
 * Tiny shared signal so the FAB can be opened from elsewhere
 * (bottom nav, keyboard shortcut, custom action). The FAB instance
 * watches this ref and toggles its overlay accordingly.
 */
import { ref } from 'vue'

export const scannerOpen = ref(false)

export function openScanner(): void {
  scannerOpen.value = true
}

<script setup lang="ts">
/**
 * <LabelSheet> — receives a list of GenerateLabelOpts and renders
 * pages (one <div> per page). Browser prints with `@page`-driven
 * layout; the host can also pass the SVGs to a server endpoint for
 * a server-rendered PDF (mercado.api.scanner.print_labels).
 */
import { computed, ref, watch } from 'vue'
import { generateSheet, type GenerateLabelOpts, type SheetOpts } from './qrGenerator'

const props = withDefaults(
  defineProps<{
    labels: GenerateLabelOpts[]
    sheetOpts?: SheetOpts
  }>(),
  { sheetOpts: () => ({}) },
)

const pages = ref<string[]>([])
const loading = ref(false)
const error = ref<string | null>(null)

async function rebuild() {
  loading.value = true
  error.value = null
  try {
    pages.value = await generateSheet(props.labels, props.sheetOpts)
  } catch (e) {
    error.value = (e as Error).message || 'No se pudo generar la hoja.'
  } finally {
    loading.value = false
  }
}

watch(() => [props.labels, props.sheetOpts], rebuild, { immediate: true, deep: true })

function printNow() {
  window.print()
}

const totalLabels = computed(() => props.labels.length)
const pageCount = computed(() => pages.value.length)
defineExpose({ pages, rebuild, printNow })
</script>

<template>
  <div class="label-sheet">
    <header class="ls-toolbar no-print">
      <div class="ls-summary">
        {{ totalLabels }} etiqueta{{ totalLabels === 1 ? '' : 's' }} ·
        {{ pageCount }} página{{ pageCount === 1 ? '' : 's' }}
      </div>
      <button type="button" class="ls-print" :disabled="loading || !pageCount" @click="printNow">
        🖨 Imprimir
      </button>
    </header>

    <p v-if="loading" class="no-print ls-status">Generando…</p>
    <p v-if="error" class="no-print ls-status ls-error">{{ error }}</p>

    <div
      v-for="(svg, i) in pages"
      :key="i"
      class="ls-page"
      v-html="svg"
    />
  </div>
</template>

<style scoped>
.label-sheet { font-family: Inter, system-ui, sans-serif; }
.ls-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  border-bottom: 1px solid #e5e7eb;
  background: #f8fafc;
}
.ls-summary { font-size: 13px; color: #475569; }
.ls-print {
  padding: 8px 14px;
  border-radius: 6px;
  border: none;
  background: #e11d48;
  color: #fff;
  font-weight: 600;
  font-size: 13px;
  cursor: pointer;
}
.ls-print:disabled { opacity: 0.5; cursor: not-allowed; }
.ls-status { font-size: 12px; color: #64748b; padding: 8px 12px; }
.ls-error { color: #dc2626; }
.ls-page {
  background: #fff;
  margin: 12px auto;
  box-shadow: 0 0 8px rgba(0,0,0,0.08);
  page-break-after: always;
  break-after: page;
  display: flex;
  justify-content: center;
}
.ls-page :deep(svg) { max-width: 100%; height: auto; }

@media print {
  @page { size: auto; margin: 0; }
  .no-print { display: none !important; }
  .ls-page {
    box-shadow: none;
    margin: 0;
    page-break-after: always;
  }
  body { background: #fff !important; }
}
</style>

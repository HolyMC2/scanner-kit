/**
 * QR + label SVG generator. Three layouts:
 *
 *   - 'item'      5cm × 3cm — QR + name + SKU + price (thermal stock)
 *   - 'ubicacion' 4cm × 4cm — QR + hierarchy ("Zona A / Estante 2")
 *   - 'box'       10cm × 8cm — bigger QR + name + qty + receiver
 *
 * Output is an SVG string so the host can either inline it for print
 * preview or post it through Pillow / wkhtmltopdf for batch PDFs.
 *
 * QR uses error-correction level Q (~25%) so the label survives
 * smudges / partial damage in the shop.
 */

import QRCode from 'qrcode'
import type { ScanPrefix } from './types'

export type LabelLayout = 'item' | 'ubicacion' | 'box'

export interface ItemLabelExtra {
  name?: string
  sku?: string
  /** Already formatted (e.g. "$1,250.00"). Leave undefined to skip. */
  price?: string
}

export interface UbicacionLabelExtra {
  /** Full hierarchy joined with ' / ' or array. */
  hierarchy?: string | string[]
}

export interface BoxLabelExtra {
  name?: string
  qty?: number | string
  receiver?: string
}

export interface GenerateLabelOpts {
  /**
   * Synthetic prefix to prepend. OPTIONAL by §9.3: items encode a bare
   * POS-compatible scan code (`serial_no > batch_no > barcode >
   * item_code`) and entities whose docname already carries its prefix
   * (`UBI-3700`, `SCT-202608-0001`) encode the docname as-is. Pass a
   * prefix only when the payload genuinely needs one synthesised.
   */
  prefix?: ScanPrefix
  id: string
  layout: LabelLayout
  extra?: ItemLabelExtra & UbicacionLabelExtra & BoxLabelExtra
  /** Override label dimensions in mm. */
  width_mm?: number
  height_mm?: number
}

/** Layout defaults (mm). */
const DIMS: Record<LabelLayout, { w: number; h: number; qrFrac: number }> = {
  // Slightly larger QR fraction for ubicacion since the human label
  // is shorter and the cajón is read at arm's length.
  item: { w: 50, h: 30, qrFrac: 0.55 },
  ubicacion: { w: 40, h: 40, qrFrac: 0.65 },
  box: { w: 100, h: 80, qrFrac: 0.55 },
}

const ESC_MAP: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
}
function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC_MAP[c]!)
}

/**
 * Encode a code as a QR matrix → emits the inner <rect> elements.
 * We deliberately call qrcode-generator-style API here: ask the
 * library to render to SVG and inject only the path/rects we need.
 */
async function qrAsRects(text: string, sizePx: number): Promise<string> {
  // qrcode 1.5.x has toString with type 'svg' — produces a self-contained
  // SVG. We strip the outer wrapper and re-emit at the size we need.
  const raw = await QRCode.toString(text, {
    type: 'svg',
    errorCorrectionLevel: 'Q',
    margin: 0,
    width: sizePx,
    color: { dark: '#000000', light: '#FFFFFF' },
  })
  // Extract everything between the outermost <svg ...>...</svg>.
  const inner = raw.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  return inner
}

/** Map mm → user units (we use 1 user unit = 1 mm in the SVG). */
function svgFrame(w_mm: number, h_mm: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w_mm}mm" height="${h_mm}mm" viewBox="0 0 ${w_mm} ${h_mm}" font-family="Inter, system-ui, -apple-system, sans-serif">${body}</svg>`
}

export async function generateLabel(opts: GenerateLabelOpts): Promise<string> {
  const dims = DIMS[opts.layout]
  const w = opts.width_mm ?? dims.w
  const h = opts.height_mm ?? dims.h
  const qrSize = Math.min(w, h) * dims.qrFrac
  const padding = 2  // mm

  const code = opts.prefix ? `${opts.prefix}-${opts.id}` : opts.id
  // Render QR at ~10× target px so it scales crisp; viewBox absorbs.
  const qrInnerPx = Math.round(qrSize * 10)
  const qrInner = await qrAsRects(code, qrInnerPx)
  // The qrcode SVG output renders at user-units == pixels. Wrap in a
  // <g> with a uniform scale so the QR ends up at qrSize mm.
  // Library emits internal viewBox 0..N where N = matrix size + margins;
  // since we asked margin=0 + width=qrInnerPx, the inner geometry is
  // already in qrInnerPx. Scale = qrSize / qrInnerPx.
  const qrScale = qrSize / qrInnerPx
  // Position QR at the left side of item/box layouts and centered for
  // ubicacion (where the QR is the main element).
  const qrX = opts.layout === 'ubicacion' ? (w - qrSize) / 2 : padding
  const qrY = opts.layout === 'ubicacion' ? padding : (h - qrSize) / 2

  let humanBody = ''
  if (opts.layout === 'item') {
    const name = opts.extra?.name ?? ''
    const sku = opts.extra?.sku ?? opts.id
    const price = opts.extra?.price ?? ''
    const textX = qrSize + padding * 2
    const textW = w - textX - padding
    humanBody = `
      <text x="${textX}" y="${padding + 4}" font-size="3.2" font-weight="700" fill="#0f172a">
        <tspan>${esc(truncate(name, 24))}</tspan>
      </text>
      <text x="${textX}" y="${padding + 9}" font-size="2.5" font-family="monospace" fill="#475569">
        ${esc(sku)}
      </text>
      ${price ? `<text x="${textX}" y="${h - padding - 1}" font-size="4" font-weight="800" fill="#e11d48">${esc(price)}</text>` : ''}
      <line x1="${textX}" y1="${h - padding - 6}" x2="${textX + textW}" y2="${h - padding - 6}" stroke="#e2e8f0" stroke-width="0.2"/>
    `
  } else if (opts.layout === 'ubicacion') {
    const raw = opts.extra?.hierarchy ?? opts.id
    const text = Array.isArray(raw) ? raw.join(' / ') : raw
    humanBody = `
      <text x="${w / 2}" y="${qrY + qrSize + 5}" font-size="3.2" font-weight="700"
            text-anchor="middle" fill="#0f172a">
        ${esc(truncate(text, 28))}
      </text>
      <text x="${w / 2}" y="${h - padding - 1}" font-size="2" font-family="monospace"
            text-anchor="middle" fill="#94a3b8">
        ${esc(opts.id)}
      </text>
    `
  } else { // 'box'
    const name = opts.extra?.name ?? opts.id
    const qty = opts.extra?.qty ?? ''
    const receiver = opts.extra?.receiver ?? ''
    const textX = qrSize + padding * 3
    humanBody = `
      <text x="${textX}" y="${padding + 8}" font-size="6" font-weight="800" fill="#0f172a">
        ${esc(truncate(name, 22))}
      </text>
      ${qty !== '' ? `<text x="${textX}" y="${padding + 18}" font-size="5" font-weight="700" fill="#e11d48">${esc(String(qty))} pza</text>` : ''}
      ${receiver ? `<text x="${textX}" y="${h - padding - 4}" font-size="3.5" fill="#475569">→ ${esc(receiver)}</text>` : ''}
      <text x="${textX}" y="${h - padding - 1}" font-size="2.5" font-family="monospace" fill="#94a3b8">
        ${esc(code)}
      </text>
    `
  }

  const body = `
    <rect x="0" y="0" width="${w}" height="${h}" fill="#ffffff"/>
    <g transform="translate(${qrX}, ${qrY}) scale(${qrScale})">${qrInner}</g>
    ${humanBody}
  `
  return svgFrame(w, h, body)
}

function truncate(s: string, max: number): string {
  if (!s) return ''
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

/**
 * Lay out N labels on a page in a grid. Returns one SVG per page.
 * Caller can join them with <br> for browser print or post to the
 * server's wkhtmltopdf for a PDF. Useful when the operator selects
 * 50+ items to relabel.
 */
export interface SheetOpts {
  page_w_mm?: number  // default 215.9 (US Letter) or 210 (A4)
  page_h_mm?: number  // default 279.4 (Letter) or 297 (A4)
  margin_mm?: number
  gap_mm?: number
}

export async function generateSheet(
  labels: GenerateLabelOpts[],
  opts: SheetOpts = {},
): Promise<string[]> {
  const page_w = opts.page_w_mm ?? 215.9
  const page_h = opts.page_h_mm ?? 279.4
  const margin = opts.margin_mm ?? 8
  const gap = opts.gap_mm ?? 2

  const pages: string[] = []
  let i = 0
  while (i < labels.length) {
    const dims = DIMS[labels[i]!.layout]
    const w = labels[i]!.width_mm ?? dims.w
    const h = labels[i]!.height_mm ?? dims.h
    const cols = Math.max(1, Math.floor((page_w - margin * 2 + gap) / (w + gap)))
    const rows = Math.max(1, Math.floor((page_h - margin * 2 + gap) / (h + gap)))
    const perPage = cols * rows
    const slice = labels.slice(i, i + perPage)

    const cells = await Promise.all(
      slice.map((l, idx) => generateCell(l, idx, cols, w, h, gap, margin)),
    )
    pages.push(svgFrame(page_w, page_h, cells.join('')))
    i += perPage
  }
  return pages
}

async function generateCell(
  l: GenerateLabelOpts,
  idx: number,
  cols: number,
  w: number,
  h: number,
  gap: number,
  margin: number,
): Promise<string> {
  const r = Math.floor(idx / cols)
  const c = idx % cols
  const x = margin + c * (w + gap)
  const y = margin + r * (h + gap)
  const inner = await generateLabel(l)
  // Strip the outer <svg> wrapper of the cell, embed contents in a <g>.
  const innerBody = inner.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '')
  return `<g transform="translate(${x}, ${y})">${innerBody}</g>`
}

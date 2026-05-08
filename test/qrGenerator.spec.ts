import { describe, expect, it } from 'vitest'
import { generateLabel, generateSheet } from '../src/qrGenerator'

describe('generateLabel', () => {
  it('emits an SVG with the expected mm dimensions for item layout', async () => {
    const svg = await generateLabel({
      prefix: 'ITM',
      id: 'MOD00001',
      layout: 'item',
      extra: { name: 'Pantalla SM A01', sku: 'MOD00001', price: '$700.00' },
    })
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg).toContain('width="50mm"')
    expect(svg).toContain('height="30mm"')
    expect(svg).toContain('Pantalla SM A01')
    expect(svg).toContain('MOD00001')
    expect(svg).toContain('$700.00')
  })

  it('emits a square SVG for ubicacion', async () => {
    const svg = await generateLabel({
      prefix: 'UBI',
      id: 'A-2-3',
      layout: 'ubicacion',
      extra: { hierarchy: ['Zona A', 'Estante 2', 'Cajón 3'] },
    })
    expect(svg).toContain('width="40mm"')
    expect(svg).toContain('height="40mm"')
    expect(svg).toContain('Zona A / Estante 2 / Cajón 3')
    expect(svg).toContain('A-2-3')
  })

  it('emits the box layout', async () => {
    const svg = await generateLabel({
      prefix: 'ITM',
      id: 'BOX001',
      layout: 'box',
      extra: { name: 'Caja envío', qty: 12, receiver: 'Bodega Norte' },
    })
    expect(svg).toContain('width="100mm"')
    expect(svg).toContain('height="80mm"')
    expect(svg).toContain('Caja envío')
    expect(svg).toContain('12 pza')
    expect(svg).toContain('→ Bodega Norte')
  })

  it('escapes HTML-sensitive characters in human text', async () => {
    const svg = await generateLabel({
      prefix: 'ITM',
      id: 'FOO',
      layout: 'item',
      extra: { name: 'A & B <special> "thing"' },
    })
    expect(svg).toContain('A &amp; B &lt;special&gt; &quot;thing&quot;')
  })

  it('embeds an inner QR with the prefixed code as content', async () => {
    const svg = await generateLabel({
      prefix: 'ITM',
      id: 'MOD00001',
      layout: 'item',
    })
    // The qrcode SVG output contains <path> elements for the QR
    // matrix; absence would mean encoding failed.
    expect(svg).toMatch(/<path|<rect/)
    // Scaling group should be present.
    expect(svg).toMatch(/<g transform="translate/)
  })

  it('truncates long names so they don\'t overflow the cell', async () => {
    const svg = await generateLabel({
      prefix: 'ITM', id: 'X', layout: 'item',
      extra: { name: 'a'.repeat(80) },
    })
    expect(svg).toContain('…')
  })

  it('honors custom width/height overrides', async () => {
    const svg = await generateLabel({
      prefix: 'ITM', id: 'X', layout: 'item',
      width_mm: 60, height_mm: 40,
    })
    expect(svg).toContain('width="60mm"')
    expect(svg).toContain('height="40mm"')
  })
})

describe('generateSheet', () => {
  it('packs labels into pages', async () => {
    const labels = Array.from({ length: 30 }, (_, i) => ({
      prefix: 'ITM' as const,
      id: `M${String(i).padStart(5, '0')}`,
      layout: 'item' as const,
      extra: { name: `Item ${i}`, sku: `M${i}`, price: `$${i}.00` },
    }))
    const pages = await generateSheet(labels)
    // Letter (215.9 × 279.4 mm), label 50×30, margin 8, gap 2:
    //   cols = floor((215.9 - 16 + 2) / 52) = 3
    //   rows = floor((279.4 - 16 + 2) / 32) = 8
    //   24 per page → 30 labels = 2 pages.
    expect(pages.length).toBe(2)
    expect(pages[0]).toContain('<svg')
    // First page should hold the full grid: 24 cells × 2 transforms = 48.
    const firstCells = pages[0]!.match(/<g transform="translate/g) || []
    expect(firstCells.length).toBe(48)
  })

  it('emits multiple pages when the count exceeds the grid', async () => {
    const labels = Array.from({ length: 100 }, (_, i) => ({
      prefix: 'ITM' as const,
      id: `M${i}`,
      layout: 'item' as const,
    }))
    const pages = await generateSheet(labels)
    expect(pages.length).toBeGreaterThan(1)
  })
})

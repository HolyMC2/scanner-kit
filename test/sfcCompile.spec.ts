/**
 * `tsc --noEmit` does not look inside .vue files (that needs vue-tsc,
 * which this package does not depend on), so nothing else in the repo
 * would catch a broken template or a `<script setup>` typo until a
 * consumer SPA's build fails. Compile them all here.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'

const SRC = resolve(__dirname, '../src')
const files = readdirSync(SRC).filter((f) => f.endsWith('.vue'))

describe('every SFC in the kit compiles', () => {
  it('finds the components', () => {
    expect(files.sort()).toEqual(
      ['EmbeddedScanner.vue', 'LabelSheet.vue', 'QrScanFab.vue', 'QrScanner.vue'],
    )
  })

  for (const name of files) {
    it(name, () => {
      const filename = join(SRC, name)
      const { descriptor, errors } = parse(readFileSync(filename, 'utf8'), { filename })
      expect(errors).toHaveLength(0)
      expect(() => compileScript(descriptor, { id: name })).not.toThrow()
      const tpl = compileTemplate({
        source: descriptor.template?.content ?? '',
        filename,
        id: name,
      })
      expect(tpl.errors).toHaveLength(0)
    })
  }
})

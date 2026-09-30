import { defineConfig } from 'vitest/config'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

export default defineConfig({
  // Exercise mounted components using the compiler already used by our SFC
  // contract tests, without adding a build plugin dependency to this package.
  plugins: [{
    name: 'scanner-test-vue',
    transform(source, id) {
      if (!id.endsWith('.vue')) return
      const { descriptor } = parse(source, { filename: id })
      const compiled = compileScript(descriptor, { id, inlineTemplate: true })
      return ts.transpileModule(compiled.content, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText
    },
  }],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./test/setup.ts'],
    globals: false,
    include: ['test/**/*.spec.ts'],
  },
})

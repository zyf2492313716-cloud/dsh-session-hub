/**
 * tsdown preset for dsh-session-hub — 照抄 chat-width 的 vendored preset（0804
 * snapshot），去掉了 CSS Modules 插件（本插件用内联样式 + 运行时注入 <style>）。
 * 两个输出：
 *  - lib/index.js   — node half（ESM，宿主 loader 加载）
 *  - lib/client.js  — browser bundle：window.__ModuleLoader__.load({id, factory})；
 *    externals 从 loader 的 frozen module table 解析。
 */
import type { UserConfig } from 'tsdown'

/** dsh web shell 共享进 frozen module table 的平台模块。 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
] as const

/** snapshot-store 引擎的官方豁免。 */
const RUNTIME_STORE_EXEMPTION = '@deepseek-ai/dsh-client-runtime/client'

/** 从 loader module table 解析的外部模块（平台种子 + 运行时豁免）。 */
const CLIENT_EXTERNALS: readonly string[] = [...PLATFORM_MODULES, RUNTIME_STORE_EXEMPTION]

function isExternal(source: string): boolean {
  return CLIENT_EXTERNALS.includes(source)
}

const PLUGIN_ID = '@dsh-local/dsh-session-hub'

export default [
  {
    // Node half: 宿主 loader import lib/index.js。
    entry: { index: 'src/index.js' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: true,
  },
  {
    // Browser bundle: lib/client.js，由 harness 在 /plugins/<id>/client.js 提供。
    entry: { client: 'src/client/index.js' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    clean: false,
    external: [...CLIENT_EXTERNALS],
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    noExternal: (id: string) => { return isExternal(id) ? undefined : true },
    plugins: [{
      // 客户端 bundle 纯度门禁：非平台模块的 @deepseek-ai 值导入一律构建错误。
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (isExternal(source)) return null
        throw new Error(
          `client bundle purity: "${source}" is not a platform module (loader module table) — `
          + 'cross-plugin value imports are forbidden; collaborate through cordis services',
        )
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: `return module.exports; } });`,
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]

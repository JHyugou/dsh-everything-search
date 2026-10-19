/**
 * 组合语义验证：用 DSH 自己的 patch 引擎（@deepseek-ai/cordis-plugin-include）
 * 把「web-app bundle 层」和「本插件的 bundle 层」按 profile 的 bundle 顺序叠一遍，
 * 证明两件事：
 *   1. directory-picker（官方 auto，win32 下解析到 Windows 原生选择器）被 disabled；
 *   2. 本插件的宿主行被 insert 进组合。
 *
 * 只读：不启动 DSH、不改任何配置。
 * 用法：node tools/verify-composition.mjs
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const CHECKOUT = 'E:\\deepseek-harness'
const INCLUDE_LIB = join(CHECKOUT, 'node_modules', '.pnpm')
const PROFILE_DIR = join(process.env.USERPROFILE ?? 'C:\\Users\\Administrator', '.dsh', 'profiles', 'desktop')
const PLUGIN_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** 从 pnpm 严格布局里定位一个包（含嵌套 node_modules）。 */
async function importFromCheckout(specifier) {
  const candidates = [
    join(CHECKOUT, 'packages', 'boot', 'app-boot', 'node_modules', specifier, 'lib', 'index.js'),
    join(CHECKOUT, 'node_modules', specifier, 'lib', 'index.js'),
  ]
  for (const candidate of candidates) {
    try {
      return await import(pathToFileURL(candidate).href)
    } catch { /* 试下一个 */ }
  }
  throw new Error(`cannot import ${specifier} from ${CHECKOUT}`)
}

const { applyEntryPatches } = await importFromCheckout('@deepseek-ai/cordis-plugin-include')
const yaml = await import(pathToFileURL(join(CHECKOUT, 'node_modules', 'js-yaml', 'index.js')).href)

// DSH 的 patch 文件里有 `!!js` 表达式（例如 !!js ctx.webStartup.port）；
// js-yaml 默认 schema 不认这个标签，注册一个把它构造成 { __jsExpr } 的类型，
// 与 DSH 自己的表示一致（本脚本只关心 id / disabled / insert，不求值）。
const JsExpressionType = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: value => value !== null && value !== '',
  construct: value => ({ __jsExpr: String(value) }),
})
const SCHEMA = yaml.DEFAULT_SCHEMA.extend([JsExpressionType])

const readYaml = (path) => {
  const patches = yaml.load(readFileSync(path, 'utf8'), { schema: SCHEMA })
  if (!Array.isArray(patches)) throw new Error(`${path}: expected a YAML list of patches`)
  return patches
}

const webAppPatch = readYaml(join(CHECKOUT, 'packages', 'bundle', 'web-app', 'cordis.patch.yml'))
const pluginPatch = readYaml(join(PLUGIN_ROOT, 'cordis.patch.yml'))
const profilePatch = readYaml(join(PROFILE_DIR, 'cordis.patch.yml'))
const manifest = JSON.parse(readFileSync(join(PROFILE_DIR, 'package.json'), 'utf8'))

const warnings = []
// profile 的组合顺序：各 bundle 的 patch（按 bundles 顺序），最后是 profile 自己的 patch。
const composed = applyEntryPatches([], [...webAppPatch, ...pluginPatch, ...profilePatch], (message) => warnings.push(message))

const directoryPicker = composed.find(entry => entry.id === 'directory-picker')
const ourRow = composed.find(entry => entry.id === 'dsh-everything-search')

const bundles = manifest.dsh?.profile?.bundles ?? []
const checks = [
  ['web-app 层确实声明了 directory-picker 行', webAppPatch.some(patch => (patch.insert ?? []).some(row => row.id === 'directory-picker'))],
  ['本插件被列进 dsh.profile.bundles', bundles.includes('dsh-everything-search')],
  ['本插件排在 web-app 之后（层序在后）', bundles.indexOf('dsh-everything-search') > bundles.indexOf('@deepseek-ai/dsh-web-app')],
  ['directory-picker 行存在且被 disabled', directoryPicker !== undefined && directoryPicker.disabled === true],
  ['本插件的宿主行已 insert', ourRow !== undefined && ourRow.name === 'dsh-everything-search'],
  ['profile 自己的 patch 没有再启用 directory-picker', !profilePatch.some(patch => patch.id === 'directory-picker' && patch.disabled === false)],
  // 本模拟把 web-app 层叠在空表上，它那些针对 dsh-base 行的 id 覆盖会报
  // "entry not found"——那是模拟的产物，只要求没有与本插件/directory-picker
  // 相关的告警。
  ['patch 引擎没有与本插件相关的告警', warnings.every(message => !/directory-picker|dsh-everything-search/.test(message))],
]

let failed = 0
for (const [label, ok] of checks) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`)
  if (!ok) failed += 1
}
console.log('\n组合结果：', JSON.stringify(
  composed.filter(entry => entry.id === 'directory-picker' || entry.id === 'dsh-everything-search'),
  null,
  2,
))
if (warnings.length > 0) console.log('告警：', warnings)
process.exit(failed === 0 ? 0 : 1)

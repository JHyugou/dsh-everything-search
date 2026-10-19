/**
 * dsh-everything-search 自检：不依赖 DSH 运行时。
 *
 *  - 宿主端：纯函数与 es.exe 链路（后者只在 es.exe 存在时跑）
 *  - 客户端：bundle 加载协议、apply 的槽位注册、纯工具函数
 *
 * 用法：node --test test/*.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { __internals as host } from '../src/index.js'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/* ------------------------------------------------------------------ *
 * 宿主端
 * ------------------------------------------------------------------ */

test('host: normalizeQuery 去掉会被 es.exe 当开关的前导短横线与多余空白', () => {
  assert.equal(host.normalizeQuery('  -temp   project '), 'temp project')
  assert.equal(host.normalizeQuery('项目'), '项目')
  assert.equal(host.normalizeQuery(undefined), '')
})

test('host: clampLimit 有默认值且封顶', () => {
  assert.equal(host.clampLimit(undefined), 80)
  assert.equal(host.clampLimit(0), 80)
  assert.equal(host.clampLimit(5), 5)
  assert.equal(host.clampLimit(9999), 200)
})

test('host: parentOf 处理盘符根与普通目录', () => {
  assert.equal(host.parentOf('C:\\'), null)
  assert.equal(host.parentOf('D:\\文件'), 'D:\\')
  assert.equal(host.parentOf('D:\\文件\\备份'), 'D:\\文件')
})

test('host: isHiddenName 大小写不敏感', () => {
  assert.equal(host.isHiddenName('$Recycle.Bin'), true)
  assert.equal(host.isHiddenName('System Volume Information'), true)
  assert.equal(host.isHiddenName('.git'), true)
  assert.equal(host.isHiddenName('项目'), false)
})

test('host: listDirectory 拒绝相对路径', async () => {
  await assert.rejects(() => host.listDirectory('relative\\path'), /absolute path/)
})

test('host: listDirectory 列出真实目录并标记隐藏项', async () => {
  const listing = await host.listDirectory('C:\\')
  assert.equal(listing.path, 'C:\\')
  assert.equal(listing.parent, null)
  assert.equal(listing.isDriveRoot, true)
  assert.ok(listing.entries.length > 0)
  const recycle = listing.entries.find(entry => entry.name.toLowerCase() === '$recycle.bin')
  assert.equal(recycle?.hidden, true)
})

test('host: listDirectory 把 -- 前缀目录标记为 blocked', async () => {
  const listing = await host.listDirectory('C:\\Users\\Administrator\\.dsh')
  const dashed = listing.entries.filter(entry => entry.name.startsWith('--'))
  assert.ok(dashed.every(entry => entry.blocked === true), '-- 前缀目录应带 blocked 标记')
  assert.ok(listing.entries.filter(entry => entry.blocked !== true).every(entry => !entry.name.startsWith('--')))
})

test('host: rename 改名成功、同名无操作、非法名/不存在被拒', async () => {
  const base = tmpdir()
  const from = join(base, `eds-rename-test-${Date.now()}`)
  const to = `${from}-renamed`
  await mkdir(from, { recursive: true })
  try {
    const renamed = await host.renameDirectory({ path: from, name: basename(to) })
    assert.equal(renamed.path, to)
    assert.equal(existsSync(to), true)
    assert.equal(existsSync(from), false)

    const same = await host.renameDirectory({ path: to, name: basename(to) })
    assert.equal(same.unchanged, true)

    await assert.rejects(() => host.renameDirectory({ path: to, name: 'a/b' }), /invalid folder name/)
    await assert.rejects(() => host.renameDirectory({ path: to, name: '' }), /name is required/)
    await assert.rejects(() => host.renameDirectory({ path: join(base, 'eds-nope-xyz-123'), name: 'x' }), /ENOENT|stat failed/)
  } finally {
    await rm(to, { recursive: true, force: true })
    await rm(from, { recursive: true, force: true })
  }
})

test('host: rename 拒绝把目录改成已存在的名字', async () => {
  const base = tmpdir()
  const a = join(base, `eds-rename-a-${Date.now()}`)
  const b = join(base, `eds-rename-b-${Date.now()}`)
  await mkdir(a, { recursive: true })
  await mkdir(b, { recursive: true })
  try {
    await assert.rejects(() => host.renameDirectory({ path: a, name: basename(b) }), /already exists/)
  } finally {
    await rm(a, { recursive: true, force: true })
    await rm(b, { recursive: true, force: true })
  }
})

test('host: dispatch 把业务错误转成 { ok:false, error }', async () => {
  const result = await host.dispatch('mkdir', { parent: 'C:\\', name: 'a/b' })
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'bad-request')
})

test('host: 未知端点返回 not-found', async () => {
  const result = await host.dispatch('nope', {})
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'gateway/not-found')
})

test('host: isNoisePath 剔除 DSH 会话目录与 -- 前缀目录', async () => {
  await host.sessionsRoot()
  assert.equal(host.isNoisePath('C:\\Users\\tester\\.dsh\\sessions\\--E-OpencodeProject--'), true)
  assert.equal(host.isNoisePath('C:\\Users\\tester\\.dsh\\sessions\\--E-OpencodeProject--\\'), true)
  assert.equal(host.isNoisePath('E:\\OpencodeProject\\--weird'), true)
  assert.equal(host.isNoisePath('E:\\OpencodeProject'), false)
  assert.equal(host.isNoisePath('C:\\Users\\tester\\.dsh\\sessions'), false)
  assert.equal(host.isNoisePath(''), false)
})

test('host: 搜索结果把会话目录标记为 blocked（由界面决定是否显示）', async (t) => {
  const status = await host.readStatus()
  if (status.available !== true) {
    t.skip('es.exe / Everything 不可用')
    return
  }
  const found = await host.search({ query: 'OpenCode', limit: 20 })
  const clean = found.results.filter(row => row.blocked !== true)
  assert.equal(clean.filter(row => row.name.startsWith('--')).length, 0)
  assert.equal(clean.filter(row => /\\.dsh\\sessions\\/i.test(row.full)).length, 0)
  assert.equal(clean.filter(row => /~[0-9A-Fa-f]{4}~/.test(row.name)).length, 0)
  assert.ok(clean.length <= 20)
  // 被屏蔽的条目仍然带回来（供「显示已屏蔽」开关使用）
  assert.ok(found.results.every(row => typeof row.blocked === 'boolean' || row.blocked === undefined))
})

test('host: 噪声规则覆盖其它 AI 工具的「路径编码」目录名', async () => {
  const matcher = await host.noiseMatcher()
  const junk = [
    ['-e-OpencodeProject-------AItest-20260919-101914-Kimi-K3--p2-6da4d8829cee7e199cf7', 'C:\\Users\\tester\\.trae-cn\\memory\\projects'],
    ['E--OpencodeProject-Altest-Deep', 'C:\\Users\\tester\\.qoder-cn\\projects'],
    ['E--OpencodeProject-Altest-Qwen', 'C:\\Users\\tester\\.qoder-cn\\tmp'],
    ['E--OpencodeProject-Altest-DS-~4E91~5C71~5DE8~57CE', 'C:\\Users\\tester\\.qoder-cn\\logs\\sessions'],
    ['--E-OpencodeProject--', 'C:\\Users\\tester\\.dsh\\sessions'],
  ]
  for (const [name, parent] of junk) {
    assert.equal(host.isNoisePath(`${parent}\\${name}`, matcher), true, `${name} 应被屏蔽`)
  }
  const legit = [
    'E:\\OpencodeProject',
    'D:\\系统分类\\下载\\superpowers-main',
    'C:\\Users\\tester\\.opencode',
    'C:\\Users\\tester\\.dsh',
  ]
  for (const path of legit) {
    assert.equal(host.isNoisePath(path, matcher), false, `${path} 不该被屏蔽`)
  }
  // DSH 会话目录根本身也算噪声（整棵子树都不可选）
  assert.equal(host.isNoisePath('C:\\Users\\tester\\.dsh\\sessions', matcher), true)
})

test('host: noise 端点下发编译后的规则（客户端据此保持一致）', async () => {
  const rules = await host.noiseRules()
  assert.ok(Array.isArray(rules.names) && rules.names.length >= 5)
  assert.ok(Array.isArray(rules.paths) && rules.paths.length >= 5)
  for (const source of [...rules.names, ...rules.paths]) {
    assert.doesNotThrow(() => new RegExp(source), `规则应为合法正则：${source}`)
  }
})

test('host: es.exe 链路（存在时）能自检并搜到文件夹', async (t) => {
  const status = await host.readStatus()
  if (status.esPath === null || status.available !== true) {
    t.skip(`es.exe / Everything 不可用：${status.reason ?? 'unknown'}`)
    return
  }
  assert.match(status.esVersion, /^\d+\.\d+/)
  const found = await host.search({ query: 'windows', limit: 5 })
  assert.ok(Array.isArray(found.results))
  for (const row of found.results) {
    assert.equal(typeof row.name, 'string')
    assert.equal(row.full, join(row.path, row.name))
  }
})

/* ------------------------------------------------------------------ *
 * 客户端 bundle
 * ------------------------------------------------------------------ */

async function loadBundle() {
  const source = await readFile(join(ROOT, 'src', 'client.js'), 'utf8')
  const storage = new Map()
  const styles = []
  let registration
  const windowObject = {
    __ModuleLoader__: { load: (row) => { registration = row } },
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => { storage.set(key, String(value)) },
    },
  }
  const sandbox = {
    window: windowObject,
    document: {
      createElement: () => ({ dataset: {}, setAttribute() {}, remove() {}, textContent: '' }),
      head: { appendChild: (tag) => styles.push(tag), append() {} },
    },
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => { throw new Error('network disabled in test') },
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'src/client.js' })
  assert.ok(registration !== undefined, 'bundle 未通过 __ModuleLoader__.load 注册')
  assert.equal(registration.id, 'dsh-everything-search')

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    // 错误边界（DialogBoundary）继承 React.Component
    Component: class Component {
      constructor(props) { this.props = props }
      setState() {}
    },
  }
  const primitives = new Proxy({}, {
    get: (_target, key) => (key === '__esModule' ? undefined : (props) => ({ type: String(key), props: props ?? {} })),
  })
  const require = (spec) => {
    if (spec === 'react') return react
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${spec}`)
  }
  const exportsObject = registration.factory(require)
  return { exports: exportsObject, react, sandbox, styles }
}

/** 平台原语整个缺失（或 require 抛错）时的加载路径：必须仍能加载并注册。 */
async function loadBundleWithoutPrimitives() {
  const source = await readFile(join(ROOT, 'src', 'client.js'), 'utf8')
  let registration
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (row) => { registration = row } },
      localStorage: { getItem: () => null, setItem: () => {} },
    },
    document: {
      createElement: () => ({ dataset: {}, setAttribute() {}, remove() {}, textContent: '' }),
      head: { appendChild() {}, append() {} },
      addEventListener() {},
      removeEventListener() {},
    },
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => { throw new Error('network disabled in test') },
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'src/client.js' })
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useRef: () => ({ current: null }),
    useCallback: (fn) => fn,
    useMemo: (fn) => fn(),
    Component: class Component { constructor(props) { this.props = props } setState() {} },
  }
  const require = (spec) => {
    if (spec === 'react') return react
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') throw new Error('seed module missing')
    throw new Error(`unexpected require: ${spec}`)
  }
  const exportsObject = registration.factory(require)
  return { exports: exportsObject, react }
}

test('client: 平台原语缺失时仍能加载（降级为自带 DOM 渲染）', async () => {
  const { exports: bundle } = await loadBundleWithoutPrimitives()
  assert.equal(typeof bundle.apply, 'function')
  assert.equal(typeof bundle.__internals.EverythingDirectoryFlow, 'function')
  assert.equal(typeof bundle.__internals.DialogBoundary, 'function')
  // 两个槽位仍然注册成功（注册用的是错误边界，不依赖平台原语）
  const registered = []
  bundle.apply({
    slots: {
      inject: (name, callback) => {
        registered.push(`inject:${name}`)
        const result = callback()
        if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
          for (let step = result.next(); step.done !== true; step = result.next()) { /* 迭代完 */ }
        }
        return undefined
      },
      register: (options) => { registered.push(`register:${options.name}`); return () => {} },
    },
    locale: { register: () => () => {}, bind: () => (key) => key },
    effect: (fn) => fn(),
    get: () => undefined,
  })
  assert.ok(registered.includes('register:sidebar.workspaces.directoryFlow'))
  assert.ok(registered.includes('register:conversation.hero.workspace.directoryFlow'))
})

test('client: bundle 导出 apply/inject 与内部面', async () => {
  const { exports: bundle } = await loadBundle()
  assert.equal(typeof bundle.apply, 'function')
  assert.equal(bundle.inject.join(','), 'slots,locale')
  assert.equal(typeof bundle.__internals.EverythingDirectoryFlow, 'function')
})

test('client: apply 注册两个 directoryFlow 槽位并注入 call/t', async () => {
  const { exports: bundle, styles } = await loadBundle()
  const registered = []
  const effects = []
  // 真实的 slots.inject 会迭代回调返回的生成器（把两个注册做成一个事务），
  // 这里照做，否则惰性的 yield 永远不会执行。
  const runInjection = (callback) => {
    const result = callback()
    if (result !== null && typeof result === 'object' && typeof result.next === 'function') {
      for (let step = result.next(); step.done !== true; step = result.next()) { /* 迭代完成为止 */ }
      return undefined
    }
    return result
  }
  const ctx = {
    slots: {
      inject: (name, callback) => { registered.push(`inject:${name}`); return runInjection(callback) },
      register: (options) => { registered.push(`register:${options.name}`); return () => {} },
    },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    effect: (fn, label) => { effects.push(label); const dispose = fn(); return dispose },
    get: () => undefined,
  }
  bundle.apply(ctx)
  assert.ok(registered.includes('inject:conversation.hero.workspace.directoryFlow'))
  assert.ok(registered.includes('inject:sidebar.workspaces.directoryFlow'))
  assert.ok(registered.includes('register:conversation.hero.workspace.directoryFlow'))
  assert.ok(registered.includes('register:sidebar.workspaces.directoryFlow'))
  assert.equal(styles.length, 1, '应注入一份样式')
  assert.ok(effects.some(label => label.includes('locale')))
})

test('client: 槽位注册失败时给出可诊断的报错而不是崩溃', async () => {
  const { exports: bundle } = await loadBundle()
  const errors = []
  const originalError = console.error
  console.error = (...args) => errors.push(args.join(' '))
  try {
    bundle.apply({
      slots: {
        inject: () => { throw new Error('single slot "sidebar.workspaces.directoryFlow" already has a registration') },
        register: () => () => {},
      },
      locale: { register: () => () => {}, bind: () => (key) => key },
      effect: (fn) => fn(),
      get: () => undefined,
    })
  } finally {
    console.error = originalError
  }
  assert.ok(errors.some(line => line.includes('directory-picker-auto')), '报错里应提示关掉原生选择器')
})

test('client: 纯工具函数', async () => {
  const { exports: bundle } = await loadBundle()
  const { parentOf, segmentsOf, formatBytes, readRecents, writeRecents, highlight } = bundle.__internals
  assert.equal(parentOf('D:\\文件\\备份'), 'D:\\文件')
  assert.equal(parentOf('D:\\'), null)
  // 跨 VM 上下文的数组原型不同，比较前先落到宿主侧字符串
  assert.equal(segmentsOf('D:\\文件\\备份').map(item => item.label).join('|'), 'D:|文件|备份')
  assert.equal(formatBytes(1024 ** 3 * 1.5), '1.5 GB')
  assert.equal(formatBytes(0), null)
  writeRecents(['C:\\a', 'C:\\b'])
  assert.equal(readRecents().join('|'), 'C:\\a|C:\\b')
  const parts = highlight('project-alpha', 'alpha')
  assert.equal(parts.length, 2)
  assert.equal(parts[1].type, 'b')
})

/**
 * 客户端对话框的真实渲染冒烟测试：用检出里的 react + react-dom/server
 * 把组件树真渲染一遍（UI 原语用等价桩替代，因为真实原语是带 CSS Module
 * 的浏览器包，Node 里无法直接 import）。
 *
 * 目的：在装进 DSH 之前抓出渲染期错误（未定义的图标组件、非法 props、
 * 组件内逻辑崩溃），这类错误在 VM 注册测试里是看不出来的。
 *
 * 用法：node --test test/render.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const PNPM = 'E:\\deepseek-harness\\node_modules\\.pnpm'
const REACT_PATH = join(PNPM, 'react@18.3.1', 'node_modules', 'react', 'index.js')
const REACT_DOM_SERVER_PATH = join(PNPM, 'react-dom@18.3.1_react@18.3.1', 'node_modules', 'react-dom', 'server.js')

const React = await import(pathToFileURL(REACT_PATH).href)
const { renderToString } = await import(pathToFileURL(REACT_DOM_SERVER_PATH).href)

/** 把 bundle 加载进 VM，返回它导出的内部面；require 由测试提供。 */
async function loadBundle(require) {
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
    },
    console,
    setTimeout,
    clearTimeout,
    fetch: async () => { throw new Error('network disabled') },
  }
  sandbox.globalThis = sandbox
  vm.runInNewContext(source, sandbox, { filename: 'src/client.js' })
  return registration.factory(require)
}

/** UI 原语等价桩：组件名 → 语义等价的 DOM 结构，未知导出（图标）→ 空 svg。 */
function makePrimitives(React) {
  const h = React.createElement
  const stubs = {
    Modal: ({ open, title, children, footer }) => (open === true
      ? h('div', { 'data-modal': title }, h('div', { className: 'stub-body' }, children), h('div', { className: 'stub-footer' }, footer))
      : null),
    Button: ({ variant, size, icon, children, ...rest }) => h('button', { 'data-variant': variant, ...rest }, icon, children),
    Input: ({ icon, className, ...rest }) => h('input', rest),
  }
  return new Proxy(stubs, {
    get: (target, key) => (key in target ? target[key] : (props) => h('svg', { 'data-icon': String(key), ...props })),
  })
}

const noop = () => {}

test('render: 关闭时不渲染任何东西', async () => {
  const primitives = makePrimitives(React)
  const bundle = await loadBundle((spec) => {
    if (spec === 'react') return React
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${spec}`)
  })
  const element = React.createElement(bundle.__internals.EverythingDirectoryFlow, {
    open: false, busy: false, call: async () => ({}), t: (key) => key, onPicked: noop, onCancel: noop,
  })
  assert.equal(renderToString(element), '')
})

test('render: 打开时渲染完整对话框骨架且不抛错', async () => {
  const primitives = makePrimitives(React)
  const bundle = await loadBundle((spec) => {
    if (spec === 'react') return React
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${spec}`)
  })
  const element = React.createElement(bundle.__internals.EverythingDirectoryFlow, {
    open: true,
    busy: false,
    call: async (endpoint) => {
      if (endpoint === 'places') return { home: 'C:\\Users\\tester', quick: [{ kind: 'desktop', path: 'C:\\Users\\tester\\Desktop' }] }
      if (endpoint === 'drives') return [{ letter: 'C', path: 'C:\\', free: 1024 ** 3 * 120, total: 1024 ** 3 * 500 }]
      if (endpoint === 'status') return { esPath: 'bin/es.exe', esVersion: '1.1.0.38', everythingVersion: '1.4.1.1017', available: true, reason: null }
      return {}
    },
    t: (key) => key,
    onPicked: noop,
    onCancel: noop,
  })
  const html = renderToString(element)
  assert.match(html, /data-modal="title"/)
  assert.match(html, /edsSearchRow/)
  assert.match(html, /edsColumns/)
  assert.match(html, /edsRail/)
  assert.match(html, /edsList/)
  assert.match(html, /edsFooter/)
  // 三个 footer 动作：取消 + 选择此文件夹（busy 时禁用）
  assert.match(html, /edsFooterPath/)
  assert.ok(!html.includes('data-icon="undefined"'), '所有图标组件都应解析成功')
})

test('render: busy 时主按钮禁用', async () => {
  const primitives = makePrimitives(React)
  const bundle = await loadBundle((spec) => {
    if (spec === 'react') return React
    if (spec === '@deepseek-ai/dsh-client-ui-primitives') return primitives
    throw new Error(`unexpected require: ${spec}`)
  })
  const html = renderToString(React.createElement(bundle.__internals.EverythingDirectoryFlow, {
    open: true, busy: true, call: async () => ({}), t: (key) => key, onPicked: noop, onCancel: noop,
  }))
  assert.match(html, /disabled=""/)
})

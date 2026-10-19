/**
 * 宿主端独立自检（不依赖 DSH）：直接调用 src/index.js 暴露的内部面，
 * 验证 es.exe 定位、版本自检、盘符枚举、目录列举与搜索。
 *
 * 用法：node tools/probe.mjs [查询词]
 */
import { __internals } from '../src/index.js'

const query = process.argv[2] ?? '项目'

function line(title, value) {
  console.log(`\n=== ${title} ===`)
  console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2))
}

const status = await __internals.readStatus()
line('status', status)

line('places', await __internals.places())

const drives = await __internals.drives()
line('drives', drives.map(d => ({ letter: d.letter, path: d.path, freeGB: d.free === null ? null : Math.round(d.free / 1024 ** 3) })))

const listed = await __internals.listDirectory('C:\\')
line('list C:\\ (前 8 项)', {
  path: listed.path,
  parent: listed.parent,
  isDriveRoot: listed.isDriveRoot,
  count: listed.entries.length,
  head: listed.entries.slice(0, 8).map(e => e.name),
})

const started = Date.now()
const found = await __internals.search({ query, limit: 8 })
line(`search ${JSON.stringify(query)}（${Date.now() - started} ms）`, found)

line('search 空查询', await __internals.search({ query: '   ', limit: 5 }))
line('dispatch(search) 信封', await __internals.dispatch('search', { query, limit: 3 }))
line('dispatch(mkdir) 缺参数', await __internals.dispatch('mkdir', { parent: 'C:\\', name: '' }))

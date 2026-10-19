/**
 * 更新后体检：静态检查「本插件依赖的 DSH 接口面」在**已安装的 app.asar** 里是否还在。
 *
 * 为什么需要它：DSH 是 nightly 自动更新，且目录选择器/槽位这块上游改动很频繁。
 * 本脚本 2 秒跑完、不需要 token、不启动任何服务，用来回答一个问题：
 * 「这次更新之后，我的插件依赖的东西有没有被动过？」
 *
 * 用法：
 *   node tools/check-app-compat.mjs                       # 默认检查 E:\DSH-DeskTop\resources\app.asar
 *   node tools/check-app-compat.mjs --asar <path>
 *   node tools/check-app-compat.mjs --asar <path> --json  # 机器可读
 */
import { readFileSync, statSync } from 'node:fs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const ASAR = flag('--asar', 'E:\\DSH-DeskTop\\resources\\app.asar')
const asJson = args.includes('--json')

/**
 * 每一项：needle 全部命中才算通过。
 * impact 说明「缺失会导致什么」，recover 说明怎么恢复。
 */
const SURFACES = [
  {
    id: 'slot-sidebar',
    what: '侧栏「新建工作区」的目录流程槽位名',
    needles: ['sidebar.workspaces.directoryFlow'],
    impact: '槽位改名 → 本插件注册失败（已 try/catch），侧栏 + 按钮会隐藏',
    recover: '把插件 disabled（见 README 回滚），恢复官方原生选择器',
  },
  {
    id: 'slot-hero',
    what: '对话空态 hero 的目录流程槽位名',
    needles: ['conversation.hero.workspace.directoryFlow'],
    impact: '同上；hero 里的「添加工作区…」会没有反应',
    recover: '同上',
  },
  {
    id: 'row-id',
    what: '官方目录选择器在组合里的行 id（我们用 disabled 让位）',
    needles: ['id: directory-picker'],
    impact: 'id 改名 → 我们的 disabled 失效 → 原生选择器重新占住 single 槽位 → 本插件注册失败、原生对话框回来',
    recover: '改插件 cordis.patch.yml 里的 id；或临时 disabled 本插件',
  },
  {
    id: 'row-auto',
    what: '官方 directory-picker-auto 包名',
    needles: ['@deepseek-ai/dsh-host-directory-picker-auto'],
    impact: '上游把 auto 行换掉/改名 → 组合方式变化，需要人工核对',
    recover: '按新的组合方式调整 disabled 目标',
  },
  {
    id: 'surface-native',
    what: '官方原生选择器客户端包（被我们让位的那一半）',
    needles: ['@deepseek-ai/dsh-client-ui-directory-picker-native'],
    impact: '缺失说明该交互被重构；回滚路径可能也要跟着改',
    recover: '核对新的官方交互包名',
  },
  {
    id: 'bundle-protocol',
    what: '手写客户端 bundle 的注册协议',
    needles: ['window.__ModuleLoader__.load'],
    impact: '协议变化 → 本插件的浏览器半加载不了（对话框完全不出现）',
    recover: '按新协议改写 src/client.js（或回滚）',
  },
  {
    id: 'client-manifest',
    what: '插件 package.json 里的 dsh.client 声明',
    needles: ['dsh.client'],
    impact: '发现机制变化 → 浏览器半不会被扫描到',
    recover: '按新声明格式调整 package.json',
  },
  {
    id: 'plugin-route',
    what: '客户端 bundle 的 /plugins 服务路由',
    needles: ['/plugins'],
    impact: '路由变化 → bundle 取不到',
    recover: '按新路由调整（一般不需要动插件）',
  },
  {
    id: 'host-route-api',
    what: '宿主端注册 /api 路由的 API（connection.fetch.register）',
    needles: ['fetch.register'],
    impact: 'API 变化 → 宿主端点注册不上 → 所有 RPC 404（界面提示搜索不可用、F2 提示需重启）',
    recover: '按新 API 改写 src/index.js 的 apply()',
  },
  {
    id: 'slot-api',
    what: '客户端槽位 API（slots.inject / slots.register）',
    needles: ['slots.register'],
    impact: 'API 变化 → 注册失败（已 try/catch）',
    recover: '按新 API 调整注册代码',
  },
  {
    id: 'locale-api',
    what: '客户端本地化 API（locale.register / bind）',
    needles: ['locale.register'],
    impact: 'API 变化 → 文案退回内置词典（不影响功能，已 try/catch）',
    recover: '一般无需处理',
  },
  {
    id: 'primitives-seed',
    what: '平台 seed 模块：@deepseek-ai/dsh-client-ui-primitives',
    needles: ['dsh-client-ui-primitives":'],
    impact: '移出 seed → require 抛错 → 浏览器半加载失败（对话框不出现）',
    recover: '改用自带 DOM 渲染，或回滚',
  },
  {
    id: 'primitives-atoms',
    what: '用到的 UI 原子与图标（Modal/Button/Input + 9 个图标）',
    needles: [
      'IconSearchOutlineRegular', 'IconChevronRightOutlineRegular', 'IconChevronUpOutlineRegular',
      'IconChevronDownOutlineRegular', 'IconFolderCloseRegular', 'IconFolderOpenRegular',
      'IconClockOutlineRegular', 'IconProjectAddOutlineRegular', 'IconDatabaseOutlineRegular',
      'IconCheckOutlineRegular', 'IconCloseOutlineRegular',
    ],
    impact: '某个图标/原子被改名 → 那一处渲染为 undefined，React 抛错（对话框可能空白）',
    recover: '换用存在的图标/原子名，或回滚',
  },
]

const buffer = readFileSync(ASAR)
const size = statSync(ASAR).size
const results = []

for (const surface of SURFACES) {
  const counts = surface.needles.map(needle => ({ needle, count: buffer.indexOf(needle) === -1 ? 0 : countOccurrences(buffer, needle) }))
  const missing = counts.filter(item => item.count === 0)
  results.push({
    id: surface.id,
    what: surface.what,
    ok: missing.length === 0,
    missing: missing.map(item => item.needle),
    counts,
    impact: surface.impact,
    recover: surface.recover,
  })
}

/** 在 Buffer 里数一个 ASCII needle 出现的次数（不构造大字符串）。 */
function countOccurrences(haystack, needle) {
  const target = Buffer.from(needle, 'utf8')
  let count = 0
  let from = 0
  for (;;) {
    const at = haystack.indexOf(target, from)
    if (at === -1) return count
    count += 1
    from = at + 1
  }
}

if (asJson) {
  console.log(JSON.stringify({ asar: ASAR, size, results }, null, 2))
} else {
  console.log(`体检目标：${ASAR}（${(size / 1024 / 1024).toFixed(1)} MB）\n`)
  for (const item of results) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.id.padEnd(20)} ${item.what}`)
    if (!item.ok) {
      console.log(`      缺失：${item.missing.join(', ')}`)
      console.log(`      影响：${item.impact}`)
      console.log(`      恢复：${item.recover}`)
    }
  }
  const failed = results.filter(item => !item.ok)
  console.log(`\n${results.length - failed.length}/${results.length} 项接口面仍在`)
  if (failed.length > 0) {
    console.log('结论：这次更新动到了本插件依赖的接口面，请按上面的「恢复」处理；')
    console.log('      也可以直接回滚（README 有命令），恢复官方原生选择器。')
  } else {
    console.log('结论：接口面未变；如仍有异常，再跑 tools/verify-instance.mjs 做运行时核对。')
  }
}

process.exit(results.every(item => item.ok) ? 0 : 1)

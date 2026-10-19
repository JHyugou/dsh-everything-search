/**
 * dsh-everything-search 宿主端。
 *
 * 职责：
 *  1. 在宿主 Web 服务上注册同源 `/api/dsh-everything-search.*` RPC 路由
 *     （浏览器端通过 `connection.rpc.call('/api', 'dsh-everything-search.<endpoint>', payload)`
 *     调用，退回普通同源 fetch 也能用）。
 *  2. 为「选择工作区目录」对话框提供宿主能力：
 *       - `places`  常用位置（主目录 / 桌面 / 下载 / 文档 / 图片 / 音乐 / 视频）
 *       - `drives`  盘符枚举（逐级浏览的入口）
 *       - `list`    列出一个目录下的子文件夹
 *       - `mkdir`   新建文件夹
 *       - `search`  用官方 es.exe 走 Everything IPC 做文件夹搜索
 *       - `status`  es.exe / Everything 可用性自检
 *  3. 搜索实现只依赖 voidtools 官方命令行 `es.exe`（随插件放在 bin/ 下，
 *     也可用环境变量 DSH_EVERYTHING_ES 或系统已安装路径覆盖）。
 *
 * 编码要点：es.exe 写 stdout 用的是控制台代码页（简体中文机器上是 GBK），
 * 直接读管道会乱码；因此搜索统一走 `-export-json <file> -utf8-bom`，
 * 从文件读标准 UTF-8 JSON。实测单次查询（含进程启动）约 45 ms。
 *
 * 本文件只依赖 Node 内置模块。
 */
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 供 Loader 显示的插件名。 */
export const name = 'dsh-everything-search'
/** 宿主端无前置服务依赖；connection 在 apply 内按需注入。 */
export const inject = []

/** 插件根目录（src/ 的上一级），用于定位随包分发的 bin/es.exe 与版本号。 */
const PLUGIN_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

/** 插件版本（读 package.json；读不到就用 0.0.0）。 */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(join(PLUGIN_ROOT, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** /api 通道下的方法名前缀，浏览器端必须与这里一致。 */
const PREFIX = 'dsh-everything-search.'
/** 全部端点；每个端点一条 exact POST 路由。 */
const ENDPOINTS = ['status', 'hello', 'noise', 'places', 'drives', 'list', 'mkdir', 'rename', 'search']

/** 事件日志：插件数据目录（`<dsh home>/plugins/<name>/events.jsonl`），用于确认「宿主半/浏览器半真的加载了」。 */
let eventsPathCache

/** 解析 DSH home；优先官方 @deepseek-ai/dsh-home-paths，退回 DSH_HOME 或 ~/.dsh。 */
async function dshHome() {
  try {
    const mod = await import('@deepseek-ai/dsh-home-paths')
    const value = typeof mod.dshHomePath === 'function' ? mod.dshHomePath() : undefined
    if (typeof value === 'string' && value.length > 0) return value
  } catch { /* 宿主没暴露时退回环境变量 */ }
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return join(homedir(), '.dsh')
}

/** 事件日志路径（惰性解析一次）。 */
async function eventsPath() {
  if (eventsPathCache === undefined) {
    eventsPathCache = join(await dshHome(), 'plugins', name, 'events.jsonl')
  }
  return eventsPathCache
}

/**
 * 追加一条事件（best-effort，绝不因为写日志失败影响功能）。
 * @param {string} event - 事件名。
 * @param {Record<string, unknown>} [detail] - 附加字段。
 */
function recordEvent(event, detail) {
  void (async () => {
    try {
      const path = await eventsPath()
      await mkdir(dirname(path), { recursive: true })
      const line = JSON.stringify({
        time: new Date().toISOString(),
        event,
        pid: process.pid,
        version: VERSION,
        ...(detail ?? {}),
      })
      await appendFile(path, `${line}\n`, 'utf8')
    } catch { /* 日志失败无妨 */ }
  })()
}

/** es.exe 查找顺序：环境变量 → 插件自带 → 系统安装目录 → PATH。 */
function esCandidates() {
  const out = []
  const env = process.env.DSH_EVERYTHING_ES
  if (typeof env === 'string' && env.trim() !== '') out.push(env.trim())
  out.push(join(PLUGIN_ROOT, 'bin', 'es.exe'))
  if (process.platform === 'win32') {
    out.push(join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Everything', 'es.exe'))
    out.push(join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Everything', 'es.exe'))
  }
  out.push('es.exe')
  return out
}

/** 搜索结果条数上限（防止一次查询把界面撑爆）。 */
const MAX_LIMIT = 200
/** 默认结果条数。 */
const DEFAULT_LIMIT = 80
/** 单次 es.exe 进程超时（毫秒）。 */
const ES_TIMEOUT_MS = 10000

/** 搜索临时目录。 */
function tempRoot() {
  return join(tmpdir(), 'dsh-everything-search')
}

let esSeq = 0

/** 进程内缓存：es.exe 路径与版本自检结果。 */
const statusCache = { at: 0, value: undefined }

/* ------------------------------------------------------------------ *
 * 进程与错误工具
 * ------------------------------------------------------------------ */

/** 业务错误：dispatch 会把它转成 { ok:false, error } 信封。 */
class BusinessError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/**
 * 运行一个子进程并收集输出。
 * @param {string} command - 可执行文件。
 * @param {string[]} args - 参数数组（不经 shell，无需转义）。
 * @param {number} timeoutMs - 超时毫秒。
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean }>}
 */
function run(command, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolvePromise({ code: null, stdout: '', stderr: String(error?.message ?? error), timedOut: false })
      return
    }
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { child.kill() } catch { /* 已退出 */ }
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('latin1') })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('latin1') })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ code: null, stdout, stderr: String(error?.message ?? error), timedOut: false })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ code, stdout, stderr, timedOut })
    })
  })
}

/** 定位可用的 es.exe；找不到时返回 undefined。 */
function findEs() {
  for (const candidate of esCandidates()) {
    try {
      if (candidate === 'es.exe') return candidate
      if (existsSync(candidate)) return candidate
    } catch { /* 继续找 */ }
  }
  return undefined
}

/** DSH 会话目录根（`<dsh home>/sessions`）：名字里编码着会话的工作目录，对选工作区是噪声。 */
let sessionsRootCache
async function sessionsRoot() {
  if (sessionsRootCache === undefined) sessionsRootCache = join(await dshHome(), 'sessions')
  return sessionsRootCache
}

/* ------------------------------------------------------------------ *
 * 噪声规则：把「AI 工具自己的会话/临时目录」从结果与列表里剔除
 * ------------------------------------------------------------------ */

/**
 * 内置规则。names 匹配「文件夹名」，paths 匹配「整条路径」。
 * 这些工具普遍把工作目录编码进文件夹名（`E:\OpencodeProject\x` → `E--OpencodeProject-x`、
 * `-e-OpencodeProject-…`，非 ASCII 走 `~XXXX~` 十六进制转义），所以按「名字形状」判定
 * 比逐个工具写死路径更耐用；paths 只用于少数已知的状态目录树。
 */
const DEFAULT_NOISE = {
  names: [
    '^--',                 // DSH 会话目录：--E-OpencodeProject--
    '^-{1,2}[A-Za-z]-',    // -e-OpencodeProject-…
    '^[A-Za-z]-{2}',       // E--OpencodeProject-…
    '~[0-9A-Fa-f]{4}~',    // 路径名里的十六进制转义
    '-{5,}',               // 路径分隔符被编码成一长串连字符
  ],
  paths: [
    '\\\\.dsh\\\\sessions\\\\',              // DSH 会话日志
    '\\\\.trae-cn\\\\memory\\\\projects\\\\', // Trae CN 的项目记忆
    '\\\\.qoder-cn\\\\(logs|projects|tmp|sessions)\\\\', // Qoder CN
    '\\\\.codex\\\\sessions\\\\',
    '\\\\.claude\\\\projects\\\\',
  ],
}

/** 用户配置缓存：`<dsh home>/plugins/<name>/config.json` 里的 noiseNames / noisePaths / noiseDisableDefaults。 */
let noiseConfigCache

/** 读取用户追加的噪声规则（缺失/损坏时只用内置规则）。 */
async function readNoiseConfig() {
  if (noiseConfigCache !== undefined) return noiseConfigCache
  const value = { names: [], paths: [], disableDefaults: false }
  try {
    const raw = JSON.parse(await readFile(join(await dshHome(), 'plugins', name, 'config.json'), 'utf8'))
    if (Array.isArray(raw?.noiseNames)) {
      value.names = raw.noiseNames.filter(item => typeof item === 'string' && item.trim() !== '')
    }
    if (Array.isArray(raw?.noisePaths)) {
      value.paths = raw.noisePaths.filter(item => typeof item === 'string' && item.trim() !== '')
    }
    value.disableDefaults = raw?.noiseDisableDefaults === true
  } catch { /* 没有配置就用默认 */ }
  noiseConfigCache = value
  return value
}

/** 编译后的规则（缓存）。 */
let noiseMatcherCache

/** 编译噪声规则；坏正则会被跳过并告警，不影响其它规则。 */
async function noiseMatcher() {
  if (noiseMatcherCache !== undefined) return noiseMatcherCache
  const config = await readNoiseConfig()
  const compile = (sources) => {
    const out = []
    for (const source of sources) {
      try {
        out.push(new RegExp(source, 'i'))
      } catch (error) {
        console.error(`[${name}] 噪声规则不是合法正则，已跳过：${source}（${error?.message ?? error}）`)
      }
    }
    return out
  }
  const names = config.disableDefaults ? [] : [...DEFAULT_NOISE.names]
  const paths = config.disableDefaults ? [] : [...DEFAULT_NOISE.paths]
  noiseMatcherCache = {
    nameSources: [...names, ...config.names],
    pathSources: [...paths, ...config.paths],
    names: compile([...names, ...config.names]),
    paths: compile([...paths, ...config.paths]),
  }
  return noiseMatcherCache
}

/**
 * 是否属于应从结果/列表中剔除的噪声目录。
 * 客户端 bundle 里有一份同样的内置规则（那一份改完即时生效；这一份在宿主重启后生效），
 * 并且客户端会通过 `noise` 端点取回这里编译后的规则以保持一致。
 * @param {string} path - 绝对路径。
 * @param {Awaited<ReturnType<typeof noiseMatcher>>} [matcher] - 已编译规则；省略则用内置规则同步判断。
 * @returns {boolean} 是否剔除。
 */
function isNoisePath(path, matcher) {
  if (typeof path !== 'string' || path === '') return false
  const normalized = path.replace(/\//g, '\\')
  const base = normalized.replace(/\\+$/, '').split('\\').filter(Boolean).slice(-1)[0] ?? ''
  const root = sessionsRootCache
  if (typeof root === 'string' && root !== ''
    && normalized.toLowerCase().startsWith(root.replace(/\//g, '\\').toLowerCase())) return true
  if (matcher !== undefined) {
    return matcher.names.some(re => re.test(base)) || matcher.paths.some(re => re.test(normalized + '\\'))
  }
  // 未编译规则时的同步兜底：与内置规则等价的最小子集
  if (base.startsWith('--')) return true
  return DEFAULT_NOISE.names.some(source => new RegExp(source, 'i').test(base))
}

/** 读取 es.exe 与 Everything 的版本（缓存 60 秒）。 */
async function readStatus() {
  const now = Date.now()
  if (statusCache.value !== undefined && now - statusCache.at < 60000) return statusCache.value
  const esPath = findEs()
  const value = {
    esPath: esPath ?? null,
    esVersion: null,
    everythingVersion: null,
    available: false,
    reason: null,
  }
  if (esPath === undefined) {
    value.reason = 'es.exe not found (expected at <plugin>/bin/es.exe or %ProgramFiles%\\Everything\\es.exe)'
    statusCache.at = now
    statusCache.value = value
    return value
  }
  const esVersion = await run(esPath, ['-version'], 5000)
  const evVersion = await run(esPath, ['-get-everything-version'], 5000)
  value.esVersion = esVersion.stdout.trim() || null
  value.everythingVersion = evVersion.stdout.trim() || null
  value.available = value.esVersion !== null && value.everythingVersion !== null
  if (!value.available) {
    value.reason = (esVersion.stderr + evVersion.stderr).trim() || 'es.exe did not report a version'
  }
  statusCache.at = now
  statusCache.value = value
  return value
}

/* ------------------------------------------------------------------ *
 * 路径与文件系统
 * ------------------------------------------------------------------ */

/** 归一化一个绝对路径；非绝对路径直接拒绝（对话框只浏览绝对路径）。 */
function absolutePath(input, label) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw new BusinessError('bad-request', `${label} is required`)
  }
  const value = input.trim()
  if (!/^[A-Za-z]:[\\/]/.test(value) && !value.startsWith('\\\\')) {
    throw new BusinessError('bad-request', `${label} must be an absolute path`)
  }
  return resolve(value)
}

/** 是否盘符根（C:\）。 */
function isDriveRoot(path) {
  return /^[A-Za-z]:[\\/]?$/.test(path)
}

/** 计算父目录；盘符根没有父目录。 */
function parentOf(path) {
  const normalized = path.endsWith(sep) ? path.slice(0, -1) : path
  if (isDriveRoot(normalized)) return null
  const parent = dirname(normalized)
  return parent === normalized ? null : parent
}

/** 名字是否算隐藏（点开头，或系统目录；系统目录名大小写不敏感）。 */
const SYSTEM_DIRS = new Set([
  '$recycle.bin',
  'system volume information',
  'recovery',
  'config.msi',
  '$winreagent',
  'documents and settings',
])

function isHiddenName(name) {
  return name.startsWith('.') || SYSTEM_DIRS.has(name.toLowerCase())
}

/** 目录项排序：显示项在前，再按名称自然序。 */
const collator = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' })

function compareEntries(a, b) {
  if (a.hidden !== b.hidden) return a.hidden ? 1 : -1
  return collator.compare(a.name, b.name)
}

/** 列出一个目录下的子文件夹。 */
async function listDirectory(input) {
  const target = absolutePath(input, 'path')
  const matcher = await noiseMatcher()
  let entries
  try {
    entries = await readdir(target, { withFileTypes: true })
  } catch (error) {
    throw new BusinessError('list-failed', `${target}: ${error?.code ?? error?.message ?? 'readdir failed'}`)
  }
  const rows = []
  for (const entry of entries) {
    let isDir = entry.isDirectory()
    if (!isDir && entry.isSymbolicLink()) {
      try { isDir = (await stat(join(target, entry.name))).isDirectory() } catch { isDir = false }
    }
    if (!isDir) continue
    const path = join(target, entry.name)
    // 同样只标记：客户端默认隐藏，点「已屏蔽 N 项」可显示。
    rows.push({ name: entry.name, path, hidden: isHiddenName(entry.name), blocked: isNoisePath(path, matcher) })
  }
  rows.sort(compareEntries)
  return {
    path: target,
    parent: parentOf(target),
    isDriveRoot: isDriveRoot(target),
    entries: rows,
  }
}

/** 常用位置（只返回真实存在的目录）。 */
async function places() {
  const home = homedir()
  const known = [
    ['desktop', join(home, 'Desktop')],
    ['downloads', join(home, 'Downloads')],
    ['documents', join(home, 'Documents')],
    ['pictures', join(home, 'Pictures')],
    ['music', join(home, 'Music')],
    ['videos', join(home, 'Videos')],
  ]
  const quick = []
  for (const [kind, path] of known) {
    try {
      if (existsSync(path)) quick.push({ kind, path })
    } catch { /* 忽略 */ }
  }
  return { home, quick }
}

/** 盘符枚举（含容量信息，拿不到就省略）。 */
async function drives() {
  const out = []
  for (let i = 0; i < 26; i++) {
    const letter = String.fromCharCode(65 + i)
    const root = `${letter}:\\`
    try {
      if (!existsSync(root)) continue
      if (!(await stat(root)).isDirectory()) continue
    } catch { continue }
    const row = { letter, path: root, total: null, free: null }
    try {
      const { statfs } = await import('node:fs/promises')
      if (typeof statfs === 'function') {
        const info = await statfs(root)
        row.total = Number(info.blocks) * Number(info.bsize)
        row.free = Number(info.bavail) * Number(info.bsize)
      }
    } catch { /* 容量拿不到不影响浏览 */ }
    out.push(row)
  }
  return out
}

/** 目录名合法性（新建与重命名共用）。 */
function checkedFolderName(rawName) {
  if (typeof rawName !== 'string' || rawName.trim() === '') {
    throw new BusinessError('bad-request', 'name is required')
  }
  const name = rawName.trim()
  if (name === '.' || name === '..' || /[<>:"/\\|?*]/.test(name)) {
    throw new BusinessError('bad-request', `invalid folder name: ${name}`)
  }
  if (name.length > 255) throw new BusinessError('bad-request', 'folder name is too long')
  return name
}

/** 在 parent 下新建文件夹，返回新目录绝对路径。 */
async function makeDirectory(payload) {
  const parent = absolutePath(payload?.parent, 'parent')
  const name = checkedFolderName(payload?.name)
  const target = join(parent, name)
  try {
    await mkdir(target)
  } catch (error) {
    if (error?.code === 'EEXIST') throw new BusinessError('already-exists', `folder already exists: ${target}`)
    throw new BusinessError('mkdir-failed', `${target}: ${error?.code ?? error?.message ?? 'mkdir failed'}`)
  }
  return { path: target }
}

/**
 * 重命名一个文件夹（F2 语义）。只改同一父目录下的名字，不做移动。
 * @param {{ path?: string, name?: string }} payload - 目标目录与新名字。
 * @returns {Promise<{ path: string, name: string, unchanged?: boolean }>} 新路径。
 */
async function renameDirectory(payload) {
  const source = absolutePath(payload?.path, 'path')
  const name = checkedFolderName(payload?.name)
  let info
  try {
    info = await stat(source)
  } catch (error) {
    throw new BusinessError('not-found', `${source}: ${error?.code ?? 'stat failed'}`)
  }
  if (!info.isDirectory()) throw new BusinessError('bad-request', `not a directory: ${source}`)
  const target = join(dirname(source), name)
  if (target === source) return { path: source, name, unchanged: true }
  if (existsSync(target)) throw new BusinessError('already-exists', `already exists: ${target}`)
  try {
    await rename(source, target)
  } catch (error) {
    // Windows 上被占用/无权限时是 EPERM/EACCES，原样回报便于界面提示
    throw new BusinessError('rename-failed', `${source} → ${target}: ${error?.code ?? error?.message ?? 'rename failed'}`)
  }
  return { path: target, name }
}

/* ------------------------------------------------------------------ *
 * Everything 搜索（es.exe）
 * ------------------------------------------------------------------ */

/** 归一化查询串：去空白、去掉会被 es.exe 当开关的前导 '-'。 */
function normalizeQuery(query) {
  if (typeof query !== 'string') return ''
  return query.replace(/\s+/g, ' ').trim().replace(/^-+/, '').trim()
}

/** 限制条数。 */
function clampLimit(limit) {
  const value = Number(limit)
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_LIMIT
  return Math.min(Math.floor(value), MAX_LIMIT)
}

/**
 * 用 Everything 搜文件夹。
 * @param {{ query?: string, limit?: number }} payload - 查询串与条数。
 * @returns {Promise<{ query: string, results: {name: string, path: string, full: string}[], truncated: boolean }>}
 */
async function search(payload) {
  const query = normalizeQuery(payload?.query)
  const limit = clampLimit(payload?.limit)
  if (query === '') return { query: '', results: [], truncated: false }
  const status = await readStatus()
  if (status.esPath === null) {
    throw new BusinessError('everything-missing', status.reason ?? 'es.exe not found')
  }
  const dir = tempRoot()
  await mkdir(dir, { recursive: true })
  const out = join(dir, `es-${process.pid}-${++esSeq}.json`)
  // 噪声过滤发生在取回之后，所以先多取一些（否则一堆会话目录会把有效结果挤掉），
  // 过滤后再截回调用方要的条数。
  const fetchLimit = Math.min(MAX_LIMIT, Math.max(limit, Math.ceil(limit * 3)))
  const args = [
    '/ad',                       // 只要文件夹
    '-n', String(fetchLimit),
    '-json',
    '-utf8-bom',                 // 导出文件用 UTF-8，避免控制台代码页
    '-name',
    '-path-column',
    '-no-folder-append-path-separator',
    '-timeout', '5000',          // 等 Everything 数据库加载
    '-export-json', out,
    query,
  ]
  try {
    const result = await run(status.esPath, args, ES_TIMEOUT_MS)
    if (!existsSync(out)) {
      const detail = result.stderr.trim() || (result.timedOut ? 'es.exe timed out' : `es.exe exited with code ${result.code}`)
      const code = /not running/i.test(detail) ? 'everything-not-running' : 'search-failed'
      throw new BusinessError(code, detail)
    }
    const text = (await readFile(out, 'utf8')).replace(/^\uFEFF/, '').trim()
    if (text === '' || text === '[]') return { query, results: [], truncated: false }
    let rows
    try {
      rows = JSON.parse(text)
    } catch (error) {
      throw new BusinessError('search-failed', `unparsable es.exe output: ${error?.message ?? error}`)
    }
    const clean = []
    const blocked = []
    const matcher = await noiseMatcher()
    for (const row of Array.isArray(rows) ? rows : []) {
      const name = typeof row?.name === 'string' ? row.name : ''
      const parent = typeof row?.path === 'string' ? row.path : ''
      if (name === '' || parent === '') continue
      const full = join(parent, name)
      // 只标记、不丢弃：由界面决定隐藏还是显示（「已屏蔽 N 项」开关因此始终有意义）。
      if (isNoisePath(full, matcher)) blocked.push({ name, path: parent, full, blocked: true })
      else clean.push({ name, path: parent, full })
    }
    return { query, results: [...clean.slice(0, limit), ...blocked.slice(0, limit)], truncated: clean.length >= limit }
  } finally {
    try { await rm(out, { force: true }) } catch { /* 清理失败无妨 */ }
  }
}

/* ------------------------------------------------------------------ *
 * /api 通道路由（信封协议与 dsh 客户端 RPC 调用者一致）
 * ------------------------------------------------------------------ */

function readEnvelope(body) {
  if (body === null || typeof body !== 'object') return undefined
  if (body.type !== 'client-request' || typeof body.rpcId !== 'string' || typeof body.method !== 'string') return undefined
  return { rpcId: body.rpcId, method: body.method, payload: body.payload }
}

function serverResponse(rpcId, result) {
  return Response.json({ type: 'server-response', rpcId, result })
}

const BAD_REQUEST_RESULT = {
  ok: false,
  error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } },
}

/** 浏览器半加载后的自报（用于确认「客户端 bundle 真的在页面里跑起来了」）。 */
function clientHello(payload) {
  // 逐字段白名单记录：新增诊断字段（primitives / primitivesError 等）无需再改这里。
  const detail = {}
  for (const key of ['userAgent', 'href', 'slots', 'primitives', 'primitivesError']) {
    const value = payload?.[key]
    if (typeof value === 'string' && value !== '') detail[key] = value.slice(0, 300)
  }
  recordEvent('client-loaded', detail)
  return { ok: true, version: VERSION }
}

/** 噪声规则（客户端取这份以保持与宿主一致；可被 config.json 扩展）。 */
async function noiseRules() {
  const matcher = await noiseMatcher()
  return { names: matcher.nameSources, paths: matcher.pathSources }
}

/** 端点实现表。 */
const HANDLERS = {
  status: () => readStatus(),
  hello: payload => clientHello(payload),
  noise: () => noiseRules(),
  places: () => places(),
  drives: () => drives(),
  list: payload => listDirectory(payload?.path),
  mkdir: payload => makeDirectory(payload),
  rename: payload => renameDirectory(payload),
  search: payload => search(payload),
}

/** 执行一个端点，把结果或错误包成 { ok, value|error }。 */
async function dispatch(endpoint, payload) {
  const handler = HANDLERS[endpoint]
  if (handler === undefined) {
    return { ok: false, error: { code: 'gateway/not-found', message: `unknown endpoint ${endpoint}` } }
  }
  try {
    return { ok: true, value: await handler(payload) }
  } catch (error) {
    if (error instanceof BusinessError) {
      return { ok: false, error: { code: error.code, message: error.message } }
    }
    return { ok: false, error: { code: 'internal', message: String(error?.message ?? error) } }
  }
}

function fetchRouteFor(endpoint) {
  const method = `${PREFIX}${endpoint}`
  return {
    path: `/api/${method}`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const contentType = request.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') {
        return new Response('content type must be application/json', { status: 415 })
      }
      let body
      try {
        body = await request.json()
      } catch {
        return new Response('body is not JSON', { status: 400 })
      }
      const envelope = readEnvelope(body)
      if (envelope === undefined) {
        // 兼容通道：非信封的裸 JSON 直接当 payload（浏览器端可退回普通同源 fetch）。
        if (body === null || typeof body !== 'object' || Array.isArray(body)) {
          return serverResponse('invalid-request', BAD_REQUEST_RESULT)
        }
        return serverResponse('bare', await dispatch(endpoint, body))
      }
      if (envelope.method !== method) {
        return serverResponse(envelope.rpcId, {
          ok: false,
          error: {
            code: 'gateway/bad-request',
            message: `method ${JSON.stringify(envelope.method)} does not match endpoint ${JSON.stringify(method)}`,
            details: { issues: [] },
          },
        })
      }
      return serverResponse(envelope.rpcId, await dispatch(endpoint, envelope.payload))
    },
  }
}

/* ------------------------------------------------------------------ *
 * 插件入口
 * ------------------------------------------------------------------ */

/**
 * 激活宿主端：有 connection（Web/桌面组合）时注册 /api 路由。
 * @param ctx - 插件上下文。
 */
export async function apply(ctx) {
  recordEvent('host-loaded', {
    platform: process.platform,
    home: await dshHome(),
    profile: process.env.DSH_PROFILE ?? null,
  })
  ctx.inject(['connection'], (scope) => {
    const connection = scope.get('connection')
    const register = connection !== null && typeof connection === 'object'
      && connection.fetch !== null && typeof connection.fetch === 'object'
      ? connection.fetch.register
      : undefined
    if (typeof register !== 'function') {
      console.error('[dsh-everything-search] connection.fetch.register 不可用——宿主接口可能已变化，路由未注册')
      return
    }
    for (const endpoint of ENDPOINTS) {
      scope.effect(
        () => register(fetchRouteFor(endpoint)),
        `dsh-everything-search: /api/${PREFIX}${endpoint} route`,
      )
    }
  })
}

/** 单元测试与排障用的内部面（不参与 DSH 契约）。 */
export const __internals = {
  PREFIX,
  ENDPOINTS,
  VERSION,
  findEs,
  readStatus,
  isNoisePath,
  sessionsRoot,
  noiseMatcher,
  noiseRules,
  DEFAULT_NOISE,
  recordEvent,
  eventsPath,
  dshHome,
  clientHello,
  normalizeQuery,
  clampLimit,
  listDirectory,
  places,
  drives,
  makeDirectory,
  renameDirectory,
  checkedFolderName,
  search,
  dispatch,
  parentOf,
  isHiddenName,
}

/**
 * 在真实 DSH 实例上验证本插件已接管「选目录」流程。
 *
 * 检查项：
 *   1. 引导图 window.__DSH_BOOT__ 里出现本插件的 client 条目；
 *   2. 引导图里不再出现 @deepseek-ai/dsh-client-ui-directory-picker-native
 *      （证明 directory-picker-auto 已被 disabled，single 槽位让了出来）；
 *   3. /plugins/dsh-everything-search/client.js 能取到本插件的浏览器 bundle；
 *   4. /api/dsh-everything-search.* 路由可用（drives / status / list / search）。
 *
 * 用法：
 *   node tools/verify-instance.mjs --url "http://127.0.0.1:3099/?token=..."
 *   （--url 可省略 token：脚本会提示）
 */
const args = process.argv.slice(2)
const urlFlag = args.indexOf('--url')
if (urlFlag < 0 || args[urlFlag + 1] === undefined) {
  console.error('usage: node tools/verify-instance.mjs --url "http://127.0.0.1:<port>/?token=<token>"')
  process.exit(2)
}

const target = new URL(args[urlFlag + 1])
const token = target.searchParams.get('token')
const origin = target.origin
const expectIndex = args.indexOf('--expect')
// installed（默认）：本插件接管；rollback：已回滚，官方原生选择器回来
const expect = expectIndex >= 0 && args[expectIndex + 1] !== undefined ? args[expectIndex + 1] : 'installed'
const PLUGIN_ID = 'dsh-everything-search'
const NATIVE_ID = '@deepseek-ai/dsh-client-ui-directory-picker-native'

const results = []
const record = (label, ok, detail) => {
  results.push({ label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
}

/** 先请求首页拿会话 cookie（token 换 cookie），后续请求带上。 */
let cookie = ''
async function request(path, init = {}) {
  const headers = { ...(init.headers ?? {}) }
  if (cookie !== '') headers.cookie = cookie
  if (token !== null) headers.authorization = `Bearer ${token}`
  const response = await fetch(origin + path, { ...init, headers, redirect: 'manual' })
  const setCookie = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : []
  if (setCookie.length > 0) cookie = setCookie.map(value => value.split(';', 1)[0]).join('; ')
  return response
}

// 带 token 的首页会 303 到干净 URL 并下发会话 cookie；跟随一次后重新取首页 HTML。
const handshake = await request(`/${token === null ? '' : `?token=${encodeURIComponent(token)}`}`)
record('token 握手（303 + Set-Cookie）', handshake.status === 200 || handshake.status === 303, `HTTP ${handshake.status}`)
record('拿到了会话 cookie', cookie !== '', cookie === '' ? '没有 Set-Cookie' : 'ok')
const home = await request('/')
const html = await home.text()
record('首页可访问', home.status === 200, `HTTP ${home.status}, ${html.length} bytes`)

// 1/2. 引导图：globalThis["__DSH_BOOT__"] = {...}（宿主注入的客户端条目图）
const bootAt = html.indexOf('__DSH_BOOT__')
let graph = null
if (bootAt >= 0) {
  const eq = html.indexOf('=', bootAt)
  const end = html.indexOf('</script>', eq)
  try {
    graph = JSON.parse(html.slice(eq + 1, end).trim().replace(/;$/, ''))
  } catch (error) {
    console.log('（引导图 JSON 解析失败）', error.message)
  }
}
const entries = graph === null ? [] : (graph.entries ?? [])
const ids = entries.map(entry => entry.id)
record('引导图可解析', graph !== null, graph === null ? '未找到 __DSH_BOOT__' : `rev=${graph.rev} entries=${ids.length}`)
if (expect === 'rollback') {
  record('回滚后：引导图不再包含本插件', !ids.includes(PLUGIN_ID), ids.includes(PLUGIN_ID) ? '仍存在' : '已移除')
  record('回滚后：官方原生选择器回来了', ids.includes(NATIVE_ID), ids.includes(NATIVE_ID) ? '' : `缺少 ${NATIVE_ID}`)
} else {
  record('引导图包含本插件', ids.includes(PLUGIN_ID), ids.includes(PLUGIN_ID) ? '' : '未出现在客户端条目图里')
  record('引导图不再包含原生选择器', !ids.includes(NATIVE_ID), ids.includes(NATIVE_ID) ? `仍存在 ${NATIVE_ID}` : '已移除（single 槽位已让出）')
}
const ours = entries.find(entry => entry.id === PLUGIN_ID)

// 3. 浏览器 bundle（用引导图里那一行自己的 url）
if (expect !== 'rollback') {
  const bundleUrl = ours?.url ?? `/plugins/${PLUGIN_ID}/client.js`
  const bundle = await request(bundleUrl.startsWith('/') ? bundleUrl : `/${bundleUrl}`)
  const bundleText = bundle.status === 200 ? await bundle.text() : ''
  record('客户端 bundle 可获取', bundle.status === 200, `${bundleUrl} → HTTP ${bundle.status}, ${bundleText.length} bytes`)
  record('bundle 是 __ModuleLoader__ 格式', bundleText.includes('window.__ModuleLoader__.load'), '')
}

// 4. RPC 路由（裸 JSON 通道；浏览器端另有信封通道）
async function rpc(endpoint, payload) {
  const response = await request(`/api/dsh-everything-search.${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  })
  const text = await response.text()
  if (response.status !== 200) return { ok: false, status: response.status, text: text.slice(0, 200) }
  const json = JSON.parse(text)
  const result = json.type === 'server-response' ? json.result : json
  return { ok: result?.ok === true, status: response.status, value: result?.value, error: result?.error }
}

const status = await rpc('status')
if (expect === 'rollback') {
  record('回滚后：本插件 RPC 路由已消失', status.ok !== true, status.status === 404 ? 'HTTP 404（预期）' : JSON.stringify(status.error ?? status))
} else {
  record('RPC status 可用', status.ok === true, status.ok ? `es=${status.value?.esVersion} everything=${status.value?.everythingVersion}` : JSON.stringify(status.error ?? status))
}

const drives = expect === 'rollback' ? { ok: true, value: [] } : await rpc('drives')
if (expect !== 'rollback') {
  record('RPC drives 可用', drives.ok === true && Array.isArray(drives.value), drives.ok ? `${drives.value.length} 个盘符` : JSON.stringify(drives.error ?? drives))

  const listing = await rpc('list', { path: 'C:\\' })
  record('RPC list 可用', listing.ok === true && Array.isArray(listing.value?.entries), listing.ok ? `C:\\ 下 ${listing.value.entries.length} 个文件夹` : JSON.stringify(listing.error ?? listing))

  const search = await rpc('search', { query: '项目', limit: 5 })
  record('RPC search 可用', search.ok === true && Array.isArray(search.value?.results), search.ok ? `${search.value.results.length} 条结果，首条 ${search.value.results[0]?.full ?? '—'}` : JSON.stringify(search.error ?? search))
}

const failed = results.filter(item => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
process.exitCode = failed.length === 0 ? 0 : 1

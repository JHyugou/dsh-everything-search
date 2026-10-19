/**
 * 无头 Chrome + CDP 的最小封装（供 ui-check / 其它验证脚本复用）。
 */
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
]

class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.events = []
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (entry !== undefined) {
          this.pending.delete(message.id)
          message.error === undefined ? entry.resolve(message.result) : entry.reject(new Error(JSON.stringify(message.error)))
        }
        return
      }
      this.events.push(message)
    })
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId !== undefined) payload.sessionId = sessionId
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject })
      this.socket.send(JSON.stringify(payload))
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`CDP timeout: ${method}`)) }, 30000)
    })
  }

  /** 取走本会话累积的异常/console.error。 */
  takeErrors(sessionId) {
    const errors = []
    for (const event of this.events.splice(0)) {
      if (event.sessionId !== sessionId) continue
      if (event.method === 'Runtime.exceptionThrown') {
        const detail = event.params?.exceptionDetails
        errors.push(`exception: ${detail?.exception?.description ?? detail?.text ?? 'unknown'}`)
      }
      if (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error') {
        errors.push(`console.error: ${(event.params.args ?? []).map(arg => arg.value ?? arg.description ?? '').join(' ')}`)
      }
    }
    return errors
  }
}

/**
 * 启动无头浏览器并连上 CDP。
 * @param {{ port?: number, outDir: string, size?: string }} options - 调试端口、截图目录、窗口尺寸。
 * @returns 会话工具集。
 */
export async function launchBrowser(options) {
  const port = options.port ?? 9333
  const outDir = resolve(options.outDir)
  const chromePath = CHROME_CANDIDATES.find(candidate => existsSync(candidate))
  if (chromePath === undefined) throw new Error('no Chrome/Edge found')

  const child = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(process.env.TEMP ?? '.', `dsh-cdp-${Date.now()}`)}`,
    `--window-size=${options.size ?? '1600,1000'}`,
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true })

  let version = null
  for (let attempt = 0; attempt < 80; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (response.ok) { version = await response.json(); break }
    } catch { /* 还没起来 */ }
    await delay(250)
  }
  if (version === null) {
    child.kill()
    throw new Error(`browser debug port ${port} never became ready`)
  }

  const socket = new WebSocket(version.webSocketDebuggerUrl)
  await new Promise((resolvePromise, reject) => {
    socket.addEventListener('open', resolvePromise, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  const cdp = new Cdp(socket)
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
  await cdp.send('Page.enable', {}, sessionId)
  await cdp.send('Runtime.enable', {}, sessionId)

  const evaluate = async (expression) => {
    const result = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    if (result.exceptionDetails !== undefined) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
    }
    return result.result?.value
  }

  const waitFor = async (expression, timeoutMs = 20000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try { if (await evaluate(expression) === true) return true } catch { /* 页面还在加载 */ }
      await delay(200)
    }
    return false
  }

  const shot = async (name) => {
    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId)
    await mkdir(outDir, { recursive: true })
    const file = join(outDir, name)
    await writeFile(file, Buffer.from(data, 'base64'))
    return file
  }

  const navigate = async (url) => {
    await cdp.send('Page.navigate', { url }, sessionId)
    await waitFor('document.readyState === "complete"', 30000)
  }

  const close = async () => {
    try { await cdp.send('Target.closeTarget', { targetId }) } catch { /* 已关闭 */ }
    socket.close()
    child.kill()
    await delay(400)
  }

  return { browser: version.Browser, cdp, sessionId, evaluate, waitFor, shot, navigate, close }
}

/** 报告器：记录 PASS/FAIL 并给出退出码。 */
export function createReporter() {
  const results = []
  return {
    record(label, ok, detail) {
      results.push({ label, ok })
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
    },
    finish() {
      const failed = results.filter(item => !item.ok)
      console.log(`\n${results.length - failed.length}/${results.length} 通过`)
      return failed.length === 0 ? 0 : 1
    },
  }
}

export { delay }

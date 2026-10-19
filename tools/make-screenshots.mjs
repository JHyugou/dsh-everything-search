/**
 * 生成 README 用的脱敏演示截图（干净实例 + C:\dsh-demo 演示目录）。
 * 用法：node tools/make-screenshots.mjs --url "http://127.0.0.1:3100/?token=..."
 */
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { launchBrowser, createReporter, delay } from './cdp.mjs'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const targetUrl = flag('--url', undefined)
if (targetUrl === undefined) {
  console.error('usage: node tools/make-screenshots.mjs --url "http://127.0.0.1:<port>/?token=<token>"')
  process.exit(2)
}
const outDir = resolve(flag('--out', join(fileURLToPath(new URL('..', import.meta.url)), 'docs')))
const reporter = createReporter()
const { record } = reporter

const ui = await launchBrowser({ outDir, port: 9345, size: '1600,1000' })
try {
  await ui.navigate(targetUrl)
  await ui.waitFor('document.readyState === "complete"', 30000)
  const shellReady = await ui.waitFor(
    'Boolean(document.querySelector(\'button[aria-label="添加工作区"]\') || document.querySelector(\'button[aria-label="Add workspace"]\'))',
    45000,
  )
  record('DSH 外壳就绪', shellReady, '')

  // 首次启动的「内测声明」引导层
  let dismissed = false
  const deadline = Date.now() + 10000
  while (Date.now() < deadline && !dismissed) {
    dismissed = await ui.evaluate(`(() => {
      const go = [...document.querySelectorAll('button')].find(b => ['继续','Continue','知道了','Got it'].includes((b.textContent ?? '').trim()))
      if (go === undefined) return false
      go.click()
      return true
    })()`)
    if (!dismissed) await delay(250)
  }
  if (dismissed) await ui.waitFor('!document.body.innerText.includes("内测声明")', 8000)
  await delay(300)

  const openDialog = async () => {
    await ui.evaluate(`(() => {
      const button = document.querySelector('button[aria-label="添加工作区"]') || document.querySelector('button[aria-label="Add workspace"]')
      button.click()
      return true
    })()`)
    return ui.waitFor('Boolean(document.querySelector(".edsDialog"))', 15000)
  }
  const enterDemoFolder = async () => {
    await ui.waitFor(`[...document.querySelectorAll('.edsRailItem')].some(n => n.getAttribute('title') === 'C:\\\\')`, 15000)
    await ui.evaluate(`(() => {
      const item = [...document.querySelectorAll('.edsRailItem')].find(n => n.getAttribute('title') === 'C:\\\\')
      item.click()
      return true
    })()`)
    await ui.waitFor('document.querySelectorAll(".edsRow").length > 0', 15000)
    const found = await ui.evaluate(`(() => {
      const row = [...document.querySelectorAll('.edsRow')].find(n => (n.getAttribute('title') ?? '').toLowerCase() === 'c:\\\\dsh-demo')
      if (row === undefined) return false
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      return true
    })()`)
    if (found) await ui.waitFor('document.querySelectorAll(".edsCrumbs") && document.querySelector(".edsCrumbs").textContent.includes("dsh-demo")', 15000)
    await delay(600)
    return found
  }

  // 1) 打开态（左栏快速访问/盘符 + 初始引导）
  const open = await openDialog()
  record('对话框打开', open, '')
  await ui.waitFor('document.querySelectorAll(".edsRailItem").length > 0', 15000)
  console.log('截图: ' + await ui.shot('dialog.png'))

  // 2) 逐级浏览 + 单击选中（底部显示「已选」）
  const entered = await enterDemoFolder()
  record('进入演示目录', entered, 'C:\\dsh-demo')
  await ui.evaluate('(() => { const row = document.querySelector(".edsRow"); if (row !== null) row.click(); return true })()')
  await delay(400)
  console.log('截图: ' + await ui.shot('selected.png'))

  // 3) Everything 搜索（搜演示目录名，结果干净）
  await ui.evaluate(`(() => {
    const input = document.querySelector('.edsSearchRow input')
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
    setter.call(input, 'dsh-demo')
    input.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await ui.waitFor('document.querySelectorAll(".edsRow").length > 0', 20000)
  await delay(800)
  console.log('截图: ' + await ui.shot('search.png'))
  record('搜索出结果', true, '')
} finally {
  await ui.close()
}
process.exit(reporter.finish())

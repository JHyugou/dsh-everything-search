/**
 * 无头浏览器真机 UI 验证（三个场景）：
 *   1. 侧栏「添加工作区」→ 本插件对话框 → 盘符逐级浏览 → Everything 搜索
 *   2. 对话空态 hero 槽位（conversation.hero.workspace.directoryFlow）→ 同一个对话框
 *   3. 确认建工作区（选一个目录 → 工作区出现在侧栏）→ 立刻从侧栏删掉（清理）
 *
 * 用法：
 *   node tools/ui-check.mjs --url "http://127.0.0.1:3099/?token=..." [--out docs] [--scenarios 1,2,3]
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
  console.error('usage: node tools/ui-check.mjs --url "http://127.0.0.1:<port>/?token=<token>"')
  process.exit(2)
}
const outDir = resolve(flag('--out', join(fileURLToPath(new URL('..', import.meta.url)), 'docs')))
const scenarios = flag('--scenarios', '1,2,3').split(',').map(value => value.trim())
const CREATE_TARGET = flag('--create-target', 'E:\\tmp')

const reporter = createReporter()
const { record } = reporter

const ui = await launchBrowser({ outDir, port: 9333 })
record('浏览器调试通道就绪', true, ui.browser)
await ui.navigate(targetUrl)
record('页面加载完成', await ui.waitFor('document.readyState === "complete"', 30000), '')

const shellReady = await ui.waitFor(
  'Boolean(document.querySelector(\'button[aria-label="添加工作区"]\') || document.querySelector(\'button[aria-label="Add workspace"]\'))',
  45000,
)
record('DSH 外壳启动完成', shellReady, '')

// 全新浏览器 profile 首次打开会有「内测声明」引导层，先关掉再操作。
let dismissed = false
const dismissDeadline = Date.now() + 10000
while (Date.now() < dismissDeadline && !dismissed) {
  dismissed = await ui.evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')]
    const go = buttons.find(button => ['继续', 'Continue', '知道了', 'Got it'].includes((button.textContent ?? '').trim()))
    if (go === undefined) return false
    go.click()
    return true
  })()`)
  if (!dismissed) await delay(250)
}
if (dismissed) await ui.waitFor('!document.body.innerText.includes("内测声明")', 10000)

/** 关掉可能还开着的对话框（场景之间互不干扰）。 */
async function closeDialogIfOpen() {
  const already = await ui.evaluate('Boolean(document.querySelector(".edsDialog"))')
  if (!already) return
  await ui.evaluate('(() => { document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); return true })()')
  await ui.waitFor('!document.querySelector(".edsDialog")', 8000)
  await delay(250)
}

/** 点开侧栏 + 按钮，返回对话框是否出现。 */
async function openSidebarDialog() {
  await closeDialogIfOpen()
  await ui.evaluate(`(() => {
    const button = document.querySelector('button[aria-label="添加工作区"]') || document.querySelector('button[aria-label="Add workspace"]')
    button.click()
    return true
  })()`)
  return await ui.waitFor('Boolean(document.querySelector(".edsDialog"))', 15000)
}

/* ---------------- 场景 1：侧栏槽位 + 浏览 + 搜索 ---------------- */

if (scenarios.includes('1')) {
  const open = await openSidebarDialog()
  record('场景1：点 + 打开的是本插件对话框（.edsDialog）', open, open ? '' : '没出现')

  if (open) {
    const railReady = await ui.waitFor('document.querySelectorAll(".edsRailItem").length > 0', 15000)
    const skeleton = await ui.evaluate(`(() => ({
      title: document.querySelector('.edsDialog')?.getAttribute('aria-label') ?? null,
      search: Boolean(document.querySelector('.edsSearchRow input')),
      railItems: document.querySelectorAll('.edsRailItem').length,
      drives: [...document.querySelectorAll('.edsRailLabel')].filter(node => /^[A-Z]:$/.test(node.textContent ?? '')).length,
      hint: document.querySelector('.edsHint')?.textContent ?? null,
    }))()`)
    record('场景1：对话框骨架齐全', skeleton.search && skeleton.railItems > 0, JSON.stringify(skeleton))
    record('场景1：左栏盘符已列出', railReady && skeleton.drives > 0, `盘符 ${skeleton.drives} 个`)

    // 几何回归检查：footer 按钮与卡片边缘必须留白，且卡片不越出视口。
    // 历史 bug：`.edsDialog { padding: 0 }` 清零了 Modal 卡片默认的底部 24px，
    // 导致 footer 贴住卡片下边缘，卡片底线切到按钮上。
    const geometry = await ui.evaluate(`(() => {
      const card = document.querySelector('.edsDialog')
      if (card === null) return null
      const cardRect = card.getBoundingClientRect()
      const buttons = [...document.querySelectorAll('.edsFooter button')]
      if (buttons.length === 0) return null
      const bottomGaps = buttons.map(button => cardRect.bottom - button.getBoundingClientRect().bottom)
      const rightGaps = buttons.map(button => cardRect.right - button.getBoundingClientRect().right)
      return {
        cardW: Math.round(cardRect.width),
        cardH: Math.round(cardRect.height),
        minBottomGap: Math.round(Math.min(...bottomGaps)),
        minRightGap: Math.round(Math.min(...rightGaps)),
        fitsViewport: cardRect.top >= -1 && cardRect.bottom <= window.innerHeight + 1,
      }
    })()`)
    record(
      '场景1：footer 与卡片边缘留有白边且不越出视口',
      geometry !== null && geometry.minBottomGap >= 12 && geometry.minRightGap >= 12 && geometry.fitsViewport === true,
      JSON.stringify(geometry),
    )
    console.log('     截图: ' + await ui.shot('ui-1-dialog-open.png'))

    const drive = await ui.evaluate(`(() => {
      const item = [...document.querySelectorAll('.edsRailItem')]
        .find(node => /^[A-Z]:$/.test(node.querySelector('.edsRailLabel')?.textContent ?? ''))
      if (item === undefined) return null
      item.click()
      return item.getAttribute('title')
    })()`)
    const listed = drive !== null && await ui.waitFor('document.querySelectorAll(".edsRow").length > 0', 15000)
    const rowCount = await ui.evaluate('document.querySelectorAll(".edsRow").length')
    record('场景1：盘符逐级浏览可用', listed, `进入 ${drive}，列出 ${rowCount} 个文件夹`)
    console.log('     截图: ' + await ui.shot('ui-2-browse-drive.png'))

    await ui.evaluate(`(() => {
      const input = document.querySelector('.edsSearchRow input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, '项目')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)

    // 输入瞬间（去抖 + 查询进行中）也留一张图，专门看有没有被拉伸的元素
    await delay(150)
    console.log('     截图: ' + await ui.shot('ui-6-typing-instant.png'))

    // 回归检查：输入瞬间不应出现「被拉伸的窄高元素」。
    // 历史 bug：搜索中的 12px 转圈是 .edsSearchRow 的直接子 span，被
    // `.edsSearchRow > span { flex: 1 }` 横向拉成整行宽的椭圆，旋转到竖直
    // 那一帧就成了一条长条特效（用户截图圈出的那个）。
    let stretched = null
    const stretchDeadline = Date.now() + 1600
    while (Date.now() < stretchDeadline && stretched === null) {
      stretched = await ui.evaluate(`(() => {
        const dialog = document.querySelector('.edsDialog')
        if (dialog === null) return null
        for (const node of dialog.querySelectorAll('*')) {
          const rect = node.getBoundingClientRect()
          if (rect.height > 80 && rect.width < 60) {
            return { tag: node.tagName, cls: String(node.className).slice(0, 60), w: Math.round(rect.width), h: Math.round(rect.height) }
          }
        }
        return null
      })()`)
      if (stretched === null) await delay(50)
    }
    record('场景1：输入瞬间没有被拉伸的元素（长条特效回归）', stretched === null, stretched === null ? '' : JSON.stringify(stretched))

    const searched = await ui.waitFor('document.querySelectorAll(".edsRow").length > 0', 20000)
    const searchState = await ui.evaluate(`(() => ({
      rows: document.querySelectorAll('.edsRow').length,
      first: document.querySelector('.edsRowName')?.textContent ?? null,
      footer: document.querySelector('.edsFooterPath')?.textContent ?? null,
      warning: document.querySelector('.edsAlert')?.textContent ?? null,
    }))()`)
    record('场景1：Everything 搜索可用', searched && (searchState.rows ?? 0) > 0, JSON.stringify(searchState))
    console.log('     截图: ' + await ui.shot('ui-3-search-everything.png'))

    // 关闭对话框（Esc）
    await ui.evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
    await ui.waitFor('!document.querySelector(".edsDialog")', 8000)
  }
}

/* ---------------- 场景 2：对话空态 hero 槽位 ---------------- */

if (scenarios.includes('2')) {
  const newSession = await ui.evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find(node => ['新会话', 'New session', '新建会话'].includes((node.textContent ?? '').trim()))
    if (button === undefined) return null
    button.click()
    return (button.textContent ?? '').trim()
  })()`)
  record('场景2：切到新会话', newSession !== null, `按钮 ${newSession ?? '未找到'}`)
  await delay(1200)

  // hero 里的工作区入口：无工作区时文案是「默认工作区」，有工作区时是工作区名/「选择工作区」
  const HERO_MATCH = /^(默认工作区|Default workspace|选择工作区|Select workspace|添加工作区|Add workspace)/
  const heroTrigger = await ui.evaluate(`(() => {
    const pattern = ${HERO_MATCH}
    const nodes = [...document.querySelectorAll('button,[role="button"]')]
    const wanted = nodes.find(node => pattern.test((node.textContent ?? '').trim()))
    return wanted === undefined ? null : (wanted.textContent ?? '').trim()
  })()`)
  if (heroTrigger === null) {
    const dump = await ui.evaluate(`JSON.stringify([...document.querySelectorAll('button,[role="button"]')].map(n => (n.textContent ?? '').trim()).filter(Boolean).slice(0, 40))`)
    record('场景2：找到 hero 工作区入口', false, `候选按钮：${dump}`)
  } else {
    record('场景2：找到 hero 工作区入口', true, heroTrigger)
    await ui.evaluate(`(() => {
      const pattern = ${HERO_MATCH}
      const nodes = [...document.querySelectorAll('button,[role="button"]')]
      nodes.find(node => pattern.test((node.textContent ?? '').trim())).click()
      return true
    })()`)
    await delay(400)
    // 有工作区时先弹菜单，需要再点「添加工作区…」
    const menuEntry = await ui.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('button,[role="menuitem"],[role="option"]')]
      const entry = nodes.find(node => /^添加工作区…?$|^Add workspace…?$/.test((node.textContent ?? '').trim()))
      if (entry === undefined) return false
      entry.click()
      return true
    })()`)
    const heroDialog = await ui.waitFor('Boolean(document.querySelector(".edsDialog"))', 15000)
    record('场景2：hero 槽位由本插件对话框接管', heroDialog, menuEntry ? '经菜单「添加工作区…」' : '直接进入流程')
    if (heroDialog) console.log('     截图: ' + await ui.shot('ui-4-hero-slot.png'))
    await ui.evaluate(`(() => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true })()`)
    await ui.waitFor('!document.querySelector(".edsDialog")', 8000)
  }
}

/* ---------------- 场景 3：确认建工作区 → 立即清理 ---------------- */

if (scenarios.includes('3')) {
  const COUNT_ROWS = 'document.querySelectorAll(\'[data-row-key]:not([data-row-key="empty"])\').length'
  const before = await ui.evaluate(COUNT_ROWS)
  const open = await openSidebarDialog()
  record('场景3：对话框打开', open, '')

  if (open) {
    // 左栏数据是异步的：既要等条目出现，也要等「盘符」到位（快捷位置可能先到）。
    await ui.waitFor('document.querySelectorAll(".edsRailItem").length > 0', 15000)
    const driveTitle = CREATE_TARGET.slice(0, 2) + '\\'
    await ui.waitFor(
      `[...document.querySelectorAll('.edsRailItem')].some(node => node.getAttribute('title') === ${JSON.stringify(driveTitle)})`,
      15000,
    )
    // 进入目标目录：先点盘符，再双击目标文件夹进去（浏览态下「当前目录」就是最终选中的目录）
    const drive = await ui.evaluate(`(() => {
      const letter = ${JSON.stringify(CREATE_TARGET.slice(0, 2))}
      const item = [...document.querySelectorAll('.edsRailItem')].find(node => node.getAttribute('title') === letter + '\\\\')
      if (item === undefined) return null
      item.click()
      return item.getAttribute('title')
    })()`)
    if (drive !== null) await ui.waitFor('document.querySelectorAll(".edsRow").length > 0', 15000)

    const dblClickTarget = async () => ui.evaluate(`(() => {
      const row = [...document.querySelectorAll('.edsRow')]
        .find(node => (node.getAttribute('title') ?? '').toLowerCase() === ${JSON.stringify(CREATE_TARGET)}.toLowerCase())
      if (row === undefined) return false
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      return true
    })()`)

    let entered = await dblClickTarget()
    if (!entered) {
      // 诊断：把当前列表前几行与底部目标打出来，便于判断是"没进到该盘"还是"行不存在"
      const listing = await ui.evaluate(`(() => ({
        rows: [...document.querySelectorAll('.edsRow')].map(n => n.getAttribute('title')).slice(0, 8),
        footer: document.querySelector('.edsFooterPath')?.textContent ?? null,
        crumbs: [...document.querySelectorAll('.edsCrumb')].map(n => n.textContent).join(' > '),
      }))()`)
      console.log('     [诊断] 列表：' + JSON.stringify(listing))
      // 兜底：用搜索直接定位目标目录，再双击进入
      const basename = CREATE_TARGET.split(/[\\/]/).filter(Boolean).slice(-1)[0]
      await ui.evaluate(`(() => {
        const input = document.querySelector('.edsSearchRow input')
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, ${JSON.stringify(basename)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      await ui.waitFor('document.querySelectorAll(".edsRow").length > 0', 20000)
      entered = await dblClickTarget()
      if (!entered) {
        // 再兜底：把搜索结果的选中项直接确认为工作区
        const picked = await ui.evaluate(`(() => {
          const row = [...document.querySelectorAll('.edsRow')]
            .find(node => (node.getAttribute('title') ?? '').toLowerCase() === ${JSON.stringify(CREATE_TARGET)}.toLowerCase())
          if (row === undefined) return null
          row.click()
          return row.getAttribute('title')
        })()`)
        record('场景3：在搜索结果里选中目标目录', picked !== null, picked ?? CREATE_TARGET)
      }
    }
    if (entered) {
      await delay(1200)
      await ui.waitFor(`(document.querySelector('.edsFooterPath')?.textContent ?? '').toLowerCase().includes(${JSON.stringify(CREATE_TARGET)}.toLowerCase())`, 15000)
    } else {
      record('场景3：进入目标目录', false, `没找到 ${CREATE_TARGET} 这一行`)
    }

    const target = await ui.evaluate('document.querySelector(".edsFooterPath")?.textContent ?? null')
    const confirmed = await ui.evaluate(`(() => {
      const button = [...document.querySelectorAll('.edsFooter button')]
        .find(node => /选择此文件夹|Select this folder/.test(node.textContent ?? ''))
      if (button === undefined || button.disabled === true) return false
      button.click()
      return true
    })()`)
    const closed = confirmed && await ui.waitFor('!document.querySelector(".edsDialog")', 15000)
    await delay(2000)
    const after = await ui.evaluate(COUNT_ROWS)
    const sidebarHasTarget = await ui.evaluate(`document.body.innerText.toLowerCase().includes(${JSON.stringify(CREATE_TARGET.split(/[\\/]/).filter(Boolean).slice(-1)[0].toLowerCase())})`)
    // 同一个目录重复建工作区是幂等的（行数不一定增加），所以以「对话框关闭 + 侧栏含该工作区」为准。
    record('场景3：确认后对话框关闭且工作区出现', closed && sidebarHasTarget, `${target} → 侧栏工作区行 ${before} → ${after}，侧栏含该名字 ${sidebarHasTarget}`)
    record('场景3：侧栏能看到新工作区', sidebarHasTarget, `目标 ${CREATE_TARGET}`)
    console.log('     截图: ' + await ui.shot('ui-5-created-workspace.png'))
  }
}

/* ---------------- 场景 4：噪声过滤 + 搜索双击进入 + 最近使用折叠 ---------------- */

if (scenarios.includes('4')) {
  const COUNT_ROWS = 'document.querySelectorAll(\'[data-row-key]:not([data-row-key="empty"])\').length'
  const rowsBefore = await ui.evaluate(COUNT_ROWS)
  const open = await openSidebarDialog()
  record('场景4：对话框打开', open, '')

  if (open) {
    await ui.waitFor('document.querySelectorAll(".edsRailItem").length > 0', 15000)

    // 4a. 搜索结果里不应出现 DSH 会话目录（-- 前缀 / .dsh\sessions）
    await ui.evaluate(`(() => {
      const input = document.querySelector('.edsSearchRow input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'OpenCode')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await ui.waitFor('document.querySelectorAll(".edsRow").length > 0', 20000)
    const noise = await ui.evaluate(`(() => {
      const titles = [...document.querySelectorAll('.edsRow')].map(node => node.getAttribute('title') ?? '')
      return {
        total: titles.length,
        dash: titles.filter(title => (title.replace(/\\\\+$/, '').split('\\\\').filter(Boolean).slice(-1)[0] ?? '').startsWith('--')).length,
        sessions: titles.filter(title => /\\\\.dsh\\\\sessions\\\\/i.test(title + '\\\\')).length,
        first: titles[0] ?? null,
      }
    })()`)
    record('场景4：搜索结果已剔除会话目录（-- / .dsh\\sessions）', noise.dash === 0 && noise.sessions === 0, JSON.stringify(noise))

    // 4b. 双击搜索结果 = 进入该文件夹（而不是直接选定）
    const dbl = await ui.evaluate(`(() => {
      const row = document.querySelector('.edsRow')
      if (row === null) return null
      row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
      return row.getAttribute('title')
    })()`)
    await delay(1200)
    const afterDouble = await ui.evaluate(`(() => ({
      stillOpen: Boolean(document.querySelector('.edsDialog')),
      query: document.querySelector('.edsSearchRow input')?.value ?? null,
      crumbs: [...document.querySelectorAll('.edsCrumb')].map(node => node.textContent).join(' > '),
      footer: document.querySelector('.edsFooterPath')?.textContent ?? null,
      rows: document.querySelectorAll('.edsRow').length,
    }))()`)
    record(
      '场景4：搜索里双击进入下一级（对话框未关闭、查询清空、面包屑跟着走）',
      dbl !== null && afterDouble.stillOpen === true && afterDouble.query === '' && afterDouble.rows > 0,
      `${dbl} → ${JSON.stringify(afterDouble)}`,
    )
    const rowsAfterDouble = await ui.evaluate(COUNT_ROWS)
    record('场景4：双击不会直接建工作区', rowsAfterDouble === rowsBefore, `侧栏工作区行 ${rowsBefore} → ${rowsAfterDouble}`)

    // 4c. 单击选中 + 右下角按钮 = 选定
    await ui.evaluate(`(() => {
      const row = document.querySelector('.edsRow')
      if (row !== null) row.click()
      return true
    })()`)
    const confirmTarget = await ui.evaluate('document.querySelector(".edsFooterPath")?.textContent ?? null')
    const confirmed = await ui.evaluate(`(() => {
      const button = [...document.querySelectorAll('.edsFooter button')]
        .find(node => /选择此文件夹|Select this folder/.test(node.textContent ?? ''))
      if (button === undefined || button.disabled === true) return false
      button.click()
      return true
    })()`)
    await delay(1800)
    const rowsAfterPick = await ui.evaluate(COUNT_ROWS)
    const dialogClosed = await ui.evaluate('!document.querySelector(".edsDialog")')
    // 注意：同一个目录重复建工作区是幂等的（第二次行数不会增加），
    // 所以断言「侧栏里存在这个工作区」而不是「行数必须 +1」。
    const pickedName = (confirmTarget ?? '').split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? ''
    const inSidebar = pickedName === '' ? false : await ui.evaluate(`document.body.innerText.toLowerCase().includes(${JSON.stringify(pickedName.toLowerCase())})`)
    record(
      '场景4：单击选中后点右下角按钮才建工作区',
      confirmed === true && dialogClosed === true && inSidebar === true,
      `${confirmTarget} → 行 ${rowsAfterDouble} → ${rowsAfterPick}，侧栏含该工作区 ${inSidebar}`,
    )

    // 4d. 重新打开：最近使用可折叠、最多 5 条
    const reopened = await openSidebarDialog()
    record('场景4：重新打开对话框', reopened, '')
    if (reopened) {
      await ui.waitFor('Boolean(document.querySelector(".edsRailGroupButton"))', 10000)
      const recentsState = await ui.evaluate(`(() => {
        const toggle = document.querySelector('.edsRailGroupButton')
        if (toggle === null) return null
        const itemsBefore = document.querySelectorAll('.edsRailItem').length
        const badge = toggle.querySelector('.edsRailMeta')?.textContent ?? null
        toggle.click()
        return { expanded: toggle.getAttribute('aria-expanded'), badge, itemsBefore }
      })()`)
      await delay(300)
      const collapsed = await ui.evaluate(`(() => ({
        expanded: document.querySelector('.edsRailGroupButton')?.getAttribute('aria-expanded') ?? null,
        items: document.querySelectorAll('.edsRailItem').length,
      }))()`)
      record(
        '场景4：最近使用可折叠展开',
        recentsState !== null && collapsed.expanded === 'false' && collapsed.items < recentsState.itemsBefore,
        `展开 ${recentsState?.itemsBefore} 项 → 折叠 ${collapsed.items} 项`,
      )
      record('场景4：最近使用最多 5 条', recentsState !== null && Number(recentsState.badge) <= 5, `计数 ${recentsState?.badge}`)
      await ui.evaluate(`(() => { const toggle = document.querySelector('.edsRailGroupButton'); if (toggle !== null) toggle.click(); return true })()`)
      await delay(200)
      console.log('     截图: ' + await ui.shot('ui-7-recents-collapsible.png'))
    }
  }
}

/* ---------------- 场景 5：噪声屏蔽（含其它 AI 工具的编码目录）+ 显示开关 ---------------- */

if (scenarios.includes('5')) {
  const open = await openSidebarDialog()
  record('场景5：对话框打开', open, '')

  if (open) {
    await ui.waitFor('document.querySelectorAll(".edsRailItem").length > 0', 15000)
    await ui.evaluate(`(() => {
      const input = document.querySelector('.edsSearchRow input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, 'OpenCode')
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    await ui.waitFor('document.querySelectorAll(".edsRow").length > 0', 20000)

    const state = await ui.evaluate(`(() => {
      const NOISE = [
        /^(--|-{1,2}[A-Za-z]-|[A-Za-z]-{2})/,
        /~[0-9A-Fa-f]{4}~/,
        /-{5,}/,
      ]
      const rows = [...document.querySelectorAll('.edsRow')]
      const titles = rows.map(node => node.getAttribute('title') ?? '')
      const junk = titles.filter(title => {
        const base = title.replace(/\\\\+$/, '').split('\\\\').filter(Boolean).slice(-1)[0] ?? ''
        if (NOISE.some(re => re.test(base))) return true
        return /\\\\.dsh\\\\sessions\\\\/i.test(title + '\\\\')
          || /\\\\.qoder-cn\\\\/i.test(title)
          || /\\\\.trae-cn\\\\memory\\\\projects\\\\/i.test(title)
      })
      const toggle = [...document.querySelectorAll('.edsHead button')]
        .find(button => /已屏蔽|Hidden|隐藏已屏蔽|Hide blocked/.test(button.textContent ?? ''))
      return {
        total: rows.length,
        junk: junk.length,
        toggleText: toggle === undefined ? null : (toggle.textContent ?? '').trim(),
      }
    })()`)
    record(
      '场景5：默认视图里没有噪声目录，且给出屏蔽计数',
      state.junk === 0 && state.toggleText !== null,
      JSON.stringify(state),
    )

    const revealed = await ui.evaluate(`(() => {
      const toggle = [...document.querySelectorAll('.edsHead button')]
        .find(button => /已屏蔽|Hidden/.test(button.textContent ?? ''))
      if (toggle === undefined) return false
      toggle.click()
      return true
    })()`)
    await delay(400)
    const after = await ui.evaluate(`(() => ({
      blocked: document.querySelectorAll('.edsRow[data-blocked="true"]').length,
      total: document.querySelectorAll('.edsRow').length,
    }))()`)
    record('场景5：点「已屏蔽 N 项」可把它们显示出来（带标记、置灰）', revealed === true && after.blocked > 0, JSON.stringify(after))
    console.log('     截图: ' + await ui.shot('ui-8-blocked-reveal.png'))

    await ui.evaluate(`(() => {
      const toggle = [...document.querySelectorAll('.edsHead button')]
        .find(button => /隐藏已屏蔽|Hide blocked/.test(button.textContent ?? ''))
      if (toggle !== undefined) toggle.click()
      return true
    })()`)
    await delay(300)
    const hidden = await ui.evaluate('document.querySelectorAll(\'.edsRow[data-blocked="true"]\').length')
    record('场景5：可以再次隐藏', hidden === 0, `blocked=${hidden}`)
  }
}

/* ---------------- 场景 6：F2 重命名（Windows 资源管理器语义） ---------------- */

if (scenarios.includes('6')) {
  const RENAME_FROM = flag('--rename-from', 'eds-ui-rename-src')
  const RENAME_TO = flag('--rename-to', 'eds-ui-rename-dst')
  const open = await openSidebarDialog()
  record('场景6：对话框打开', open, '')

  if (open) {
    await ui.waitFor('document.querySelectorAll(".edsRailItem").length > 0', 15000)
    // 用搜索定位测试目录（避免依赖盘符层级）
    await ui.evaluate(`(() => {
      const input = document.querySelector('.edsSearchRow input')
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      setter.call(input, ${JSON.stringify(RENAME_FROM)})
      input.dispatchEvent(new Event('input', { bubbles: true }))
      return true
    })()`)
    const found = await ui.waitFor('document.querySelectorAll(".edsRow").length > 0', 20000)
    record('场景6：搜索到测试目录', found, `关键词 ${RENAME_FROM}`)

    // 选中第一行，在列表里按 F2
    await ui.evaluate('(() => { const row = document.querySelector(".edsRow"); if (row !== null) row.click(); return true })()')
    await delay(200)
    const hint = await ui.evaluate(`(() => [...document.querySelectorAll('.edsHead span')].map(n => (n.textContent ?? '').trim()).find(t => /F2/.test(t)) ?? null)()`)
    record('场景6：选中后出现 F2 提示', hint !== null, hint ?? '未找到提示')

    await ui.evaluate(`(() => {
      const list = document.querySelector('.edsList')
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
      return true
    })()`)
    const editing = await ui.waitFor('Boolean(document.querySelector(\'.edsRow[data-renaming="true"] input\'))', 8000)
    record('场景6：F2 进入行内改名（输入框出现）', editing, '')

    if (editing) {
      // Esc 取消：对话框必须仍然开着（先做断言再截图：截图会让输入框失焦，
      // 而失焦提交是产品行为，会把输入框先撤掉）
      await ui.evaluate(`(() => {
        const input = document.querySelector('.edsRow[data-renaming="true"] input')
        if (input === null) return false
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
        return true
      })()`)
      await delay(300)
      const afterEscape = await ui.evaluate(`(() => ({
        dialogOpen: Boolean(document.querySelector('.edsDialog')),
        editing: Boolean(document.querySelector('.edsRow[data-renaming="true"]')),
      }))()`)
      record('场景6：Esc 取消改名且不关闭对话框', afterEscape.dialogOpen === true && afterEscape.editing === false, JSON.stringify(afterEscape))

      // 再按 F2，改成新名字并回车提交
      await ui.evaluate('(() => { const row = document.querySelector(".edsRow"); if (row !== null) row.click(); return true })()')
      await ui.evaluate(`(() => {
        const list = document.querySelector('.edsList')
        list.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
        return true
      })()`)
      await ui.waitFor('Boolean(document.querySelector(\'.edsRow[data-renaming="true"] input\'))', 8000)
      console.log('     截图: ' + await ui.shot('ui-9-rename-editing.png'))
      await ui.evaluate(`(() => {
        const input = document.querySelector('.edsRow[data-renaming="true"] input')
        if (input === null) return false
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(input, ${JSON.stringify(RENAME_TO)})
        input.dispatchEvent(new Event('input', { bubbles: true }))
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
        return true
      })()`)
      await delay(1800)
      const afterRename = await ui.evaluate(`(() => ({
        dialogOpen: Boolean(document.querySelector('.edsDialog')),
        editing: Boolean(document.querySelector('.edsRow[data-renaming="true"]')),
        names: [...document.querySelectorAll('.edsRowName')].map(n => n.textContent).slice(0, 5),
        selected: document.querySelector('.edsRow[data-selected="true"]')?.getAttribute('title') ?? null,
        footer: document.querySelector('.edsFooterPath')?.textContent ?? null,
        alert: document.querySelector('.edsAlert')?.textContent ?? null,
      }))()`)
      record(
        '场景6：回车提交改名，并落到改名后的项上',
        afterRename.dialogOpen === true && afterRename.editing === false
          && (afterRename.selected ?? '').includes(RENAME_TO) && afterRename.alert === null,
        JSON.stringify(afterRename),
      )
      console.log('     截图: ' + await ui.shot('ui-10-renamed.png'))
    }
  }
}

/* ---------------- 场景 7：浏览态「单击选中 → 右下角按钮选中它」 ---------------- */

if (scenarios.includes('7')) {
  const COUNT_ROWS = 'document.querySelectorAll(\'[data-row-key]:not([data-row-key="empty"])\').length'
  const open = await openSidebarDialog()
  record('场景7：对话框打开', open, '')

  if (open) {
    await ui.waitFor('document.querySelectorAll(".edsRailItem").length > 0', 15000)
    const enterDrive = async () => {
      await ui.waitFor(
        `[...document.querySelectorAll('.edsRailItem')].some(node => node.getAttribute('title') === 'C:\\\\')`,
        15000,
      )
      await ui.evaluate(`(() => {
        const item = [...document.querySelectorAll('.edsRailItem')].find(node => node.getAttribute('title') === 'C:\\\\')
        if (item !== undefined) item.click()
        return true
      })()`)
      await ui.waitFor('document.querySelectorAll(".edsRow").length > 0', 15000)
    }
    const footerText = () => ui.evaluate('document.querySelector(".edsFooterPath")?.textContent ?? null')
    const clickFirstRow = async () => ui.evaluate(`(() => {
      const row = document.querySelector('.edsRow')
      if (row === null) return null
      row.click()
      return row.getAttribute('title')
    })()`)
    const waitFooter = async (needle) => {
      let text = null
      for (let attempt = 0; attempt < 25; attempt++) {
        text = await footerText()
        if (typeof text === 'string' && text.includes(needle)) return text
        await delay(80)
      }
      return text
    }

    await enterDrive()
    // 未选中：按钮目标是当前目录
    const noSelectionFooter = await footerText()
    record(
      '场景7：未选中时目标仍是当前目录',
      typeof noSelectionFooter === 'string' && noSelectionFooter.includes('当前') && noSelectionFooter.includes('C:\\'),
      `底部 ${noSelectionFooter}`,
    )

    // 1) 单击选中 → 目标变成选中的文件夹
    const picked = await clickFirstRow()
    const selectionFooter = await waitFooter('已选')
    record(
      '场景7：单击选中后，底部目标变成选中的文件夹',
      picked !== null && typeof selectionFooter === 'string'
        && selectionFooter.includes('已选') && selectionFooter.includes(picked),
      `选中 ${picked}；底部 ${selectionFooter}`,
    )

    // 2) 点空白处 → 取消选中，目标回到当前目录
    await ui.evaluate(`(() => {
      const list = document.querySelector('.edsList')
      list.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      return true
    })()`)
    await waitFooter('当前')
    const afterBlank = await ui.evaluate(`(() => ({
      footer: document.querySelector('.edsFooterPath')?.textContent ?? null,
      selected: document.querySelectorAll('.edsRow[data-selected="true"]').length,
    }))()`)
    record(
      '场景7：点空白处取消选中，目标回到当前目录',
      afterBlank.selected === 0 && typeof afterBlank.footer === 'string'
        && afterBlank.footer.includes('当前') && !afterBlank.footer.includes('已选'),
      JSON.stringify(afterBlank),
    )

    // 3) 再选中一次并确认 → 建出的是选中的文件夹（不是当前目录）
    const beforeOpen = await ui.evaluate(COUNT_ROWS)
    const pickedAgain = await clickFirstRow()
    await waitFooter('已选')
    console.log('     截图: ' + await ui.shot('ui-11-selected-folder.png'))
    const confirmClicked = await ui.evaluate(`(() => {
      const button = [...document.querySelectorAll('.edsFooter button')]
        .find(node => /选择此文件夹|Select this folder/.test(node.textContent ?? ''))
      if (button === undefined || button.disabled === true) return false
      button.click()
      return true
    })()`)
    await delay(1800)
    const dialogClosed = await ui.evaluate('!document.querySelector(".edsDialog")')
    const afterOpen = await ui.evaluate(COUNT_ROWS)
    const basename = (pickedAgain ?? '').split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? ''
    const inSidebar = basename === '' ? false : await ui.evaluate(`document.body.innerText.toLowerCase().includes(${JSON.stringify(basename.toLowerCase())})`)
    record(
      '场景7：确认后建出的是选中的文件夹（不是当前目录）',
      confirmClicked === true && dialogClosed === true && inSidebar === true,
      `${pickedAgain} → 对话框已关闭 ${dialogClosed}；侧栏工作区行 ${beforeOpen} → ${afterOpen}；侧栏含该名字 ${inSidebar}`,
    )
  }
}

const pageErrors = ui.cdp.takeErrors(ui.sessionId)
record('页面无 JS 异常', pageErrors.length === 0, pageErrors.slice(0, 3).join(' | '))

await ui.close()
process.exit(reporter.finish())

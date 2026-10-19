/**
 * 从 DSH 会话日志（多帧 zstd 拼接的 JSONL）里回放工具入参，
 * 用于重建被误编码损坏的文件。仅本地恢复工具。
 *
 * 用法：
 *   node tools/recover-from-session.mjs --session <file.jsonl.zstd> --target src/client.js [--out <file>]
 *   node tools/recover-from-session.mjs --session <file> --target src/client.js --inspect
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback
}
const sessionFile = flag('--session', undefined)
const target = flag('--target', 'src/client.js')
const out = flag('--out', undefined)
const inspect = args.includes('--inspect')
if (sessionFile === undefined) {
  console.error('usage: node tools/recover-from-session.mjs --session <file.jsonl.zstd> --target <relative path> [--out <file>]')
  process.exit(2)
}

/** 多帧 zstd：按 magic 逐帧解压后拼接。 */
function decompressAll(buffer) {
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  let from = 0
  for (;;) {
    const at = buffer.indexOf(MAGIC, from)
    if (at === -1) break
    offsets.push(at)
    from = at + 4
  }
  const chunks = []
  for (const offset of offsets) {
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(offset)).toString('utf8'))
    } catch { /* 不是帧起点或截断，跳过 */ }
  }
  return chunks.join('')
}

const text = decompressAll(readFileSync(sessionFile))
const lines = text.split('\n').filter(line => line.trim() !== '')

/** 递归找出对象里所有形如 { name, input } 的工具调用。 */
function collectToolCalls(value, out = []) {
  if (value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const item of value) collectToolCalls(item, out)
    return out
  }
  // DSH 会话日志的形态：{ type: 'tool/call', data: { name, arguments: '<json 字符串>' } }
  if (value.type === 'tool/call' && value.data !== null && typeof value.data === 'object') {
    const name = value.data.name
    const raw = value.data.arguments
    if (typeof name === 'string' && typeof raw === 'string') {
      try {
        const input = JSON.parse(raw)
        if (input !== null && typeof input === 'object') out.push({ name, input })
      } catch { /* 忽略坏入参 */ }
    }
    return out
  }
  const name = value.name ?? value.tool ?? value.toolName
  const input = value.input ?? value.arguments ?? value.args ?? value.params
  if (typeof name === 'string' && input !== null && typeof input === 'object') {
    out.push({ name, input })
  }
  for (const key of Object.keys(value)) collectToolCalls(value[key], out)
  return out
}

const calls = []
for (const line of lines) {
  let obj
  try {
    obj = JSON.parse(line)
  } catch {
    continue
  }
  for (const call of collectToolCalls(obj)) {
    const filePath = call.input.file_path ?? call.input.filePath ?? call.input.path ?? ''
    if (typeof filePath === 'string' && filePath.replace(/\\/g, '/').endsWith(target.replace(/\\/g, '/'))) {
      calls.push(call)
    }
  }
}

if (inspect) {
  console.log(`会话行数 ${lines.length}，命中 ${target} 的工具调用 ${calls.length} 次`)
  for (const call of calls) {
    const kind = typeof call.input.content === 'string' ? `write(${call.input.content.length} chars)`
      : typeof call.input.old_string === 'string' ? `edit(old=${call.input.old_string.length}, new=${(call.input.new_string ?? '').length}${call.input.replace_all ? ', all' : ''})`
        : 'other'
    console.log(`  ${call.name}  ${kind}`)
  }
  process.exit(0)
}

// 回放：第一个 write 作为基线，后续 edit 依次套用
let content = null
let applied = 0
let failed = 0
for (const call of calls) {
  if (typeof call.input.content === 'string') {
    content = call.input.content
    applied += 1
    continue
  }
  if (typeof call.input.old_string === 'string' && content !== null) {
    const oldString = call.input.old_string
    const newString = call.input.new_string ?? ''
    const first = content.indexOf(oldString)
    if (first === -1) {
      failed += 1
      console.error(`跳过一条 edit（找不到锚点，长度 ${oldString.length}）：${oldString.slice(0, 60).replace(/\n/g, '⏎')}`)
      continue
    }
    if (call.input.replace_all === true) {
      content = content.split(oldString).join(newString)
    } else {
      if (content.indexOf(oldString, first + 1) !== -1) {
        failed += 1
        console.error(`跳过一条 edit（锚点不唯一）：${oldString.slice(0, 60).replace(/\n/g, '⏎')}`)
        continue
      }
      content = content.slice(0, first) + newString + content.slice(first + oldString.length)
    }
    applied += 1
  }
}

console.log(`回放完成：应用 ${applied} 条，跳过 ${failed} 条，结果 ${content === null ? 0 : content.length} 字符`)
if (content !== null && out !== undefined) {
  writeFileSync(out, content, 'utf8')
  console.log(`已写入 ${out}`)
}

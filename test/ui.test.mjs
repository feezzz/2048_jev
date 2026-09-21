/**
 * 集成测试 —— 在 jsdom 里把整个游戏跑起来
 *
 * 规则正确性由 game.test.mjs 负责，这里只管一件事：
 * 真实交互路径（按键 / 撤销 / 重开）跑几百步，不崩、不卡死、状态不越界。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ---------------- 环境：接住事件回调里抛出的异常 ---------------- */
const runtimeErrors = []
const vc = new VirtualConsole()
vc.on('jsdomError', (e) => runtimeErrors.push(e.message || String(e)))

const dom = new JSDOM(read('index.html'), {
  url: 'http://localhost:5173/',
  virtualConsole: vc,
})
const { window } = dom

globalThis.window = window
globalThis.document = window.document
globalThis.localStorage = window.localStorage

/* ---------------- 执行源码：拆掉 import/export，按依赖顺序拼接 ---------------- */
const strip = (src) =>
  src
    .replace(/^\s*import\s+['"][^'"]*\.css['"]\s*;?/gm, '')
    .replace(/^\s*import\s+\{[^}]*\}\s+from\s+['"][^'"]*['"]\s*;?/gm, '')
    .replace(/^export\s+/gm, '')

const bundle = ['src/game.js', 'src/jev.js', 'src/ai.js', 'src/main.js']
  .map((f) => strip(read(f)))
  .join('\n')

new Function(bundle)()

/* ---------------- 断言 ---------------- */
let failures = 0
let checks = 0

function ok(cond, msg) {
  checks++
  if (!cond) {
    failures++
    if (failures <= 10) console.log(`  FAIL  ${msg}`)
  }
  return cond
}

/* ---------------- 工具 ---------------- */
const $ = (id) => window.document.getElementById(id)
const score = () => Number($('score').textContent)

function press(key) {
  window.dispatchEvent(new window.KeyboardEvent('keydown', { key }))
}

function readBoard() {
  const board = Array.from({ length: 4 }, () => Array(4).fill(0))
  const seen = new Set()
  let overlap = false
  let max = 0

  // ghost 是正在淡出的被吞方块，不算在棋盘里
  for (const el of window.document.querySelectorAll('#tiles .tile:not(.is-ghost)')) {
    const key = `${el.dataset.r},${el.dataset.c}`
    if (seen.has(key)) overlap = true
    seen.add(key)

    const v = Number(el.dataset.v)
    board[Number(el.dataset.r)][Number(el.dataset.c)] = v
    if (v > max) max = v
  }

  return { board, count: seen.size, overlap, max }
}

/* ---------------- 开跑 ---------------- */
console.log('\n2048 集成测试（jsdom）')
console.log('─'.repeat(52))

// 1) 开局
{
  const { count, overlap, board } = readBoard()
  ok(count === 2, `开局应有 2 个方块，实际 ${count}`)
  ok(!overlap, '开局方块重叠')
  ok(score() === 0, `开局分数应为 0，实际 ${score()}`)
  ok(
    board.flat().every((v) => v === 0 || v === 2 || v === 4),
    '开局出现了 2/4 以外的值'
  )
  console.log(`  ✓ 开局：${count} 个方块，分数 0`)
}

// 2) 乱按不该崩
{
  const noise = ['a', 'Enter', 'Shift', 'F5', 'Tab', '1']
  for (const k of noise) press(k)
  ok(runtimeErrors.length === 0, `无关按键触发了异常：${runtimeErrors[0] || ''}`)
  console.log(`  ✓ 无关按键无副作用（${noise.length} 个）`)
}

// 3) 长跑
{
  const KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
  let moves = 0
  let restarts = 0
  let lastScore = score()
  let maxTile = 0

  for (let i = 0; i < 800; i++) {
    press(KEYS[(Math.random() * 4) | 0])

    if (runtimeErrors.length) {
      ok(false, `第 ${i} 步运行时报错：${runtimeErrors[0]}`)
      runtimeErrors.length = 0
      break
    }

    const { count, overlap, max } = readBoard()
    ok(!overlap, `第 ${i} 步方块重叠`)
    ok(count <= 16, `第 ${i} 步方块数 ${count} > 16`)
    ok(score() >= lastScore, `第 ${i} 步分数回退 ${lastScore} → ${score()}`)

    lastScore = score()
    if (max > maxTile) maxTile = max
    moves++

    // 结束了就点按钮重开，继续压测
    if (!$('overlay').hidden) {
      $('overlay-btn').click()
      lastScore = score()
      restarts++
    }
  }

  console.log(`  ✓ 随机走 ${moves} 步，中途重开 ${restarts} 次`)
  console.log(`  ✓ 最大方块 ${maxTile}，最高分 ${$('best').textContent}`)
  ok(maxTile >= 32, `长跑后最大方块仅 ${maxTile}，合并链路可能有问题`)
}

// 4) 撤销 —— 必须把棋盘、分数、步数一起退回去
{
  if (!$('overlay').hidden) $('overlay-btn').click()

  const snap = () => ({
    board: readBoard().board.flat().join(','),
    score: score(),
    steps: $('steps').textContent,
  })

  const ARROWS = ['ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']
  let before = null

  // 找一个真正会改变棋盘的方向，否则测不出撤销
  for (const key of ARROWS) {
    const pre = snap()
    press(key)
    if (snap().board !== pre.board) {
      before = pre
      break
    }
  }

  if (before) {
    $('undo').click()
    const after = snap()

    ok(after.board === before.board, '撤销后棋盘应当复原')
    ok(after.score === before.score, `撤销后分数应当复原：${before.score} → ${after.score}`)
    ok(after.steps === before.steps, `撤销后步数应当复原：${before.steps} → ${after.steps}`)

    console.log(`  ✓ 撤销：棋盘 / 分数 / 步数 全部回退（分数 ${before.score}）`)
  } else {
    ok(false, '没能构造出一次有效移动，撤销用例未生效')
  }
}

// 5) 重开
{
  $('new-game').click()
  const { count } = readBoard()
  ok(count === 2, `重开后应有 2 个方块，实际 ${count}`)
  ok(score() === 0, `重开后分数应为 0，实际 ${score()}`)
  console.log('  ✓ 重开：回到 2 个方块 / 0 分')
}

// 6) 最高分持久化
{
  ok(!Number.isNaN(Number($('best').textContent)), '最高分不是数字')
  console.log(`  ✓ 最高分显示：${$('best').textContent}`)
}

ok(runtimeErrors.length === 0, `仍有未捕获异常：${runtimeErrors[0] || ''}`)

console.log('\n' + '─'.repeat(52))
console.log(`断言 ${checks} 条，失败 ${failures} 条`)
console.log(failures === 0 ? '结果：全部通过 ✅\n' : '结果：存在失败 ❌\n')

process.exit(failures === 0 ? 0 : 1)

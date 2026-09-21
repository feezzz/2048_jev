/**
 * 纯规则层测试
 *
 * 这一层不碰 DOM，所以可以精确断言，不受「新方块随机落位」干扰。
 * 重点验证 2048 的两条硬规则：
 *   1. 先靠拢，再合并
 *   2. 同一个方块一回合只能合并一次
 */
import { SIZE, linesFor, computeLine, maxValue, hasMove } from '../src/game.js'

let failures = 0
let checks = 0

function eq(actual, expected, label) {
  checks++
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) {
    failures++
    console.log(`  FAIL  ${label}\n        得到 ${a}\n        应为 ${e}`)
  }
}

function ok(cond, label) {
  checks++
  if (!cond) {
    failures++
    console.log(`  FAIL  ${label}`)
  }
}

console.log('\n2048 规则层测试')
console.log('─'.repeat(52))

/* -------------------------------------------------------------------------
   1. computeLine —— 滑动合并
   ------------------------------------------------------------------------- */
console.log('\n[computeLine]')

const N = null
const cases = [
  // 说明                     输入                        期望 slots                         期望得分
  ['两格相接合并', [2, 2, N, N], [{ from: 0, mergedWith: 1 }], 4],
  ['隔空靠拢后合并', [2, N, 2, N], [{ from: 0, mergedWith: 2 }], 4],
  ['右侧两格合并', [N, 2, 2, N], [{ from: 1, mergedWith: 2 }], 4],
  ['三个相同只合前两个', [2, 2, 2, N], [{ from: 0, mergedWith: 1 }, { from: 2 }], 4],
  ['四个相同合成两对', [2, 2, 2, 2], [{ from: 0, mergedWith: 1 }, { from: 2, mergedWith: 3 }], 8],
  ['两个不同不动', [4, 2, N, N], [{ from: 0 }, { from: 1 }], 0],
  ['值不同不合并', [2, 4, N, N], [{ from: 0 }, { from: 1 }], 0],
  ['相同但被隔开仍合并', [2, N, N, 2], [{ from: 0, mergedWith: 3 }], 4],
  ['大数合并', [8, 8, 4, 4], [{ from: 0, mergedWith: 1 }, { from: 2, mergedWith: 3 }], 24],
  ['满盘无合并', [2, 4, 2, 4], [{ from: 0 }, { from: 1 }, { from: 2 }, { from: 3 }], 0],
  ['空盘', [N, N, N, N], [], 0],
  ['单个方块', [2, N, N, N], [{ from: 0 }], 0],
  ['夹心：合完左边留一个', [2, N, 2, 2], [{ from: 0, mergedWith: 2 }, { from: 3 }], 4],
]

for (const [name, input, expectSlots, expectGained] of cases) {
  const { slots, gained } = computeLine(input)
  eq(slots, expectSlots, `${name} —— slots`)
  eq(gained, expectGained, `${name} —— gained`)
}

/* -------------------------------------------------------------------------
   2. linesFor —— 切线与推进顺序
   ------------------------------------------------------------------------- */
console.log('\n[linesFor]')

eq(linesFor('left').length, SIZE, '切成 4 条线')

eq(linesFor('left')[0], [
  { r: 0, c: 0 }, { r: 0, c: 1 }, { r: 0, c: 2 }, { r: 0, c: 3 },
], 'left：第 0 行从左往右')

eq(linesFor('right')[0], [
  { r: 0, c: 3 }, { r: 0, c: 2 }, { r: 0, c: 1 }, { r: 0, c: 0 },
], 'right：第 0 行从右往左')

eq(linesFor('up')[0], [
  { r: 0, c: 0 }, { r: 1, c: 0 }, { r: 2, c: 0 }, { r: 3, c: 0 },
], 'up：第 0 列从上往下')

eq(linesFor('down')[0], [
  { r: 3, c: 0 }, { r: 2, c: 0 }, { r: 1, c: 0 }, { r: 0, c: 0 },
], 'down：第 0 列从下往上')

/* -------------------------------------------------------------------------
   3. 整盘模拟 —— 用上面两个函数拼出一次移动，验证全局不变量
   ------------------------------------------------------------------------- */
console.log('\n[整盘移动]')

function applyMove(board, dir) {
  const next = board.map((row) => [...row])
  let gained = 0
  let moved = false

  for (const line of linesFor(dir)) {
    const olds = line.map((p) => next[p.r][p.c])
    const values = olds.map((v) => v || null)
    const { slots, gained: g } = computeLine(values)
    gained += g

    for (const p of line) next[p.r][p.c] = 0
    slots.forEach((slot, k) => {
      const p = line[k]
      const raw = olds[slot.from]
      const v = slot.mergedWith !== undefined ? raw * 2 : raw
      next[p.r][p.c] = v
      if (slot.from !== k || slot.mergedWith !== undefined) moved = true
    })
  }

  return { board: next, gained, moved }
}

const sum = (b) => b.flat().reduce((a, v) => a + v, 0)

function randomBoard() {
  const b = Array.from({ length: SIZE }, () => Array(SIZE).fill(0))
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (Math.random() < 0.65) b[r][c] = 2 ** (1 + ((Math.random() * 6) | 0))
    }
  }
  return b
}

/** 推动后每条线都应贴向推动方向 */
function assertPacked(board, dir, label) {
  const flip = {
    left: (line) => line,
    right: (line) => [...line].reverse(),
    up: (line) => line,
    down: (line) => [...line].reverse(),
  }
  void flip

  for (const line of linesFor(dir)) {
    const values = line.map((p) => board[p.r][p.c])
    const nonZero = values.filter((v) => v !== 0)
    const expected = [...nonZero, ...Array(SIZE - nonZero.length).fill(0)]
    ok(
      values.join(',') === expected.join(','),
      `${label} 未靠拢：得到 [${values}]，应为 [${expected}]`
    )
  }
}

const DIRS = ['left', 'right', 'up', 'down']
let trials = 0

for (let i = 0; i < 400; i++) {
  const board = randomBoard()
  for (const dir of DIRS) {
    const before = sum(board)
    const { board: after, gained } = applyMove(board, dir)

    assertPacked(after, dir, `第 ${i} 轮 ${dir}`)

    // 合并是等值相加，牌面总和必须守恒
    ok(sum(after) === before, `第 ${i} 轮 ${dir} 总和变了：${before} → ${sum(after)}`)
    ok(gained >= 0, `第 ${i} 轮 ${dir} 得分异常 ${gained}`)

    // 值仍应是 2 的幂
    for (const row of after) {
      for (const v of row) {
        if (v === 0) continue
        ok(v >= 2 && (v & (v - 1)) === 0, `第 ${i} 轮 ${dir} 出现非法值 ${v}`)
      }
    }

    trials++
  }
}

console.log(`  · 随机棋盘 ${trials} 次移动，靠拢 / 总和守恒 / 数值合法性 全部校验`)

/* -------------------------------------------------------------------------
   4. maxValue / hasMove
   ------------------------------------------------------------------------- */
console.log('\n[maxValue / hasMove]')

eq(maxValue([[2, 4], [8, 16]]), 16, 'maxValue 取最大')
eq(maxValue([[0, 0], [0, 0]]), 0, 'maxValue 空盘为 0')

ok(hasMove([[0, 0], [0, 0]]) === true, '有空位 → 可以动')
ok(
  hasMove([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 2],
  ]) === false,
  '棋盘满且无相邻同值 → 不能动'
)
ok(
  hasMove([
    [2, 4, 2, 4],
    [4, 2, 4, 2],
    [2, 4, 2, 4],
    [4, 2, 4, 4],
  ]) === true,
  '棋盘满但有相邻同值 → 可以动'
)

console.log('\n' + '─'.repeat(52))
console.log(`断言 ${checks} 条，失败 ${failures} 条`)
console.log(failures === 0 ? '结果：全部通过 ✅\n' : '结果：存在失败 ❌\n')

process.exit(failures === 0 ? 0 : 1)

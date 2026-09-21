/**
 * 经典 2048 策略 —— 用来证明「通关靠的是策略，不是单步判断的速度」
 *
 * 评估函数由四项组成（这套组合是 2048 AI 里被反复验证过的）：
 *   空格数     —— 留空格远比多拿一次合并更重要
 *   单调性     —— 每一行每一列尽量保持单向递增/递减
 *   平滑度     —— 相邻数字差越小越好
 *   角落       —— 最大方块待在角落
 *
 * 再套一层 expectimax：我方取最大，对手（随机落块）取期望。
 */
import { SIZE, applyMove, countEmpty, maxValue } from './game.js'

const ALL_DIRS = ['up', 'down', 'left', 'right']

/* ---------------- 评估 ---------------- */

const lg = (v) => (v ? Math.log2(v) : 0)

/** 单调性：行列各自看哪个方向更顺，取更好的那个 */
function monotonicity(board) {
  let up = 0
  let down = 0
  let left = 0
  let right = 0

  for (let r = 0; r < SIZE; r++) {
    let cur = 0
    let next = 1
    while (next < SIZE) {
      while (next < SIZE - 1 && board[r][next] === 0) next++
      const a = lg(board[r][cur])
      const b = lg(board[r][next])
      if (a > b) up += b - a
      else down += a - b
      cur = next
      next++
    }
  }

  for (let c = 0; c < SIZE; c++) {
    let cur = 0
    let next = 1
    while (next < SIZE) {
      while (next < SIZE - 1 && board[next][c] === 0) next++
      const a = lg(board[cur][c])
      const b = lg(board[next][c])
      if (a > b) left += b - a
      else right += a - b
      cur = next
      next++
    }
  }

  return Math.max(up, down) + Math.max(left, right)
}

/** 平滑度：相邻非空格子的对数差，越接近 0 越好 */
function smoothness(board) {
  let s = 0
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!board[r][c]) continue
      const v = lg(board[r][c])
      if (c + 1 < SIZE && board[r][c + 1]) s -= Math.abs(v - lg(board[r][c + 1]))
      if (r + 1 < SIZE && board[r + 1][c]) s -= Math.abs(v - lg(board[r + 1][c]))
    }
  }
  return s
}

/** 最大方块是否待在角落 */
function cornerBonus(board) {
  const max = maxValue(board)
  if (!max) return 0
  const corners = [board[0][0], board[0][SIZE - 1], board[SIZE - 1][0], board[SIZE - 1][SIZE - 1]]
  return corners.includes(max) ? 1 : 0
}

/** 综合评分，越高越好 */
export function evaluate(board) {
  return (
    countEmpty(board) * 270 +
    monotonicity(board) * 47 +
    smoothness(board) * 0.1 +
    cornerBonus(board) * 400
  )
}

/* ---------------- 搜索 ---------------- */

function emptiesOf(board) {
  const out = []
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!board[r][c]) out.push({ r, c })
    }
  }
  return out
}

const CHANCE_SAMPLE = 6 // 空位多时抽样，控制搜索规模

function search(board, plies, isPlayer) {
  if (plies <= 0) return evaluate(board)

  if (isPlayer) {
    let best = -Infinity
    for (const dir of ALL_DIRS) {
      const { board: next, moved } = applyMove(board, dir)
      if (!moved) continue
      const s = search(next, plies - 1, false)
      if (s > best) best = s
    }
    return best === -Infinity ? evaluate(board) : best
  }

  // 对手层：在某个空位随机放下 2 或 4，取期望
  const empties = emptiesOf(board)
  if (!empties.length) return evaluate(board)

  const sample = empties.length > CHANCE_SAMPLE ? empties.slice(0, CHANCE_SAMPLE) : empties
  let total = 0

  for (const p of sample) {
    let expected = 0
    for (const [value, prob] of [
      [2, 0.9],
      [4, 0.1],
    ]) {
      board[p.r][p.c] = value
      expected += prob * search(board, plies - 1, true)
      board[p.r][p.c] = 0
    }
    total += expected
  }

  return total / sample.length
}

/**
 * 选方向。
 * depth：1 = 只看眼前一步；3 = 我走 → 对手放 → 我再走；越大越强也越慢
 */
export function snakeMove(board, { depth = 3 } = {}) {
  let best = null
  let bestScore = -Infinity

  for (const dir of ALL_DIRS) {
    const { board: next, moved } = applyMove(board, dir)
    if (!moved) continue

    const s = depth <= 1 ? evaluate(next) : search(next, depth - 1, false)
    if (s > bestScore) {
      bestScore = s
      best = dir
    }
  }

  return best
}

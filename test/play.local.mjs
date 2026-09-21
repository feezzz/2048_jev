/**
 * 本地贪心对局 —— 对照组
 *
 * 和 play.jev.mjs 用完全一样的棋盘和随机出块，只是把决策换成本地启发式。
 * 用来回答一个问题：通关靠的到底是「策略」，还是「模型」？
 *
 * 不联网，所以跑 20 局也是一瞬间的事。
 *
 * 用法：node test/play.local.mjs [局数] [最大步数]
 */
import { SIZE, applyMove, maxValue, hasMove } from '../src/game.js'
import { legalDirs, localMove } from '../src/ai.js'

const ROUNDS = Number(process.argv[2] || 20)
const MAX_STEPS = Number(process.argv[3] || 4000)
const MILESTONES = [256, 512, 1024, 2048]

const emptyBoard = () => Array.from({ length: SIZE }, () => Array(SIZE).fill(0))

function spawn(board) {
  const empties = []
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!board[r][c]) empties.push({ r, c })
    }
  }
  if (!empties.length) return
  const p = empties[(Math.random() * empties.length) | 0]
  board[p.r][p.c] = Math.random() < 0.9 ? 2 : 4
}

function newBoard() {
  const b = emptyBoard()
  spawn(b)
  spawn(b)
  return b
}

console.log(`\n本地贪心对局 · ${ROUNDS} 局`)
console.log('─'.repeat(56))

const rows = []
let reached = 0

for (let round = 1; round <= ROUNDS; round++) {
  let board = newBoard()
  let score = 0
  let steps = 0

  while (steps < MAX_STEPS && hasMove(board)) {
    const dir = localMove(board)
    if (!dir) break

    const applied = applyMove(board, dir)
    board = applied.board
    score += applied.gained
    steps++
    spawn(board)
  }

  const top = maxValue(board)
  if (top >= 2048) reached++

  rows.push({ round, steps, score, top })
  console.log(
    `  第 ${String(round).padStart(2)} 局 · ${String(steps).padStart(4)} 步 · ` +
      `分数 ${String(score).padStart(6)} · 最大 ${String(top).padStart(4)}` +
      (top >= 2048 ? '   ◆ 通关' : '')
  )
}

const avg = (k) => rows.reduce((a, r) => a + r[k], 0) / rows.length
const best = rows.reduce((a, r) => (r.top > a.top ? r : a), rows[0])

console.log('\n' + '─'.repeat(56))
console.log(`局数         ${ROUNDS}`)
console.log(`通关         ${reached} 局（${((reached / ROUNDS) * 100).toFixed(0)}%）`)
console.log(`最好成绩     ${best.score} 分 · 最大方块 ${best.top}（第 ${best.round} 局）`)
console.log(`平均步数     ${avg('steps').toFixed(0)}`)
console.log(`平均分数     ${avg('score').toFixed(0)}`)
console.log(`平均最大方块 ${avg('top').toFixed(0)}`)
console.log(`\n里程碑分布：`)
for (const m of MILESTONES) {
  const n = rows.filter((r) => r.top >= m).length
  console.log(`  达到 ${String(m).padStart(4)}   ${String(n).padStart(2)}/${ROUNDS} 局`)
}
console.log('─'.repeat(56) + '\n')

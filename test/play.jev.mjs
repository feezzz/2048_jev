/**
 * 纯 Jev 对局 —— 从头打到 2048，中间不掺任何本地算法。
 *
 * 每一步都真的调用 Jev。调用失败会重试，重试仍失败就如实停下报告，
 * 绝不偷偷换成本地贪心 —— 否则测出来的就不是 Jev 的水平了。
 * 万一 Jev 返回了走不动的方向，也只从它自己给的概率分布里挑合法项。
 *
 * 用法：node test/play.jev.mjs [最大步数]
 */
import { SIZE, applyMove, maxValue, hasMove, countEmpty } from '../src/game.js'
import { legalDirs, boardToState, buildQuestions } from '../src/ai.js'

const ENDPOINT = 'http://127.0.0.1:5173/api/jev'
const MAX_STEPS = Number(process.argv[2] || 2500)
const MILESTONES = [128, 256, 512, 1024, 2048]

/* ---------------- 棋盘 ---------------- */

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

const render = (board) =>
  board
    .map((row) => '  ' + row.map((v) => (v ? String(v).padStart(4) : '   ·')).join(' '))
    .join('\n')

/* ---------------- 每一步都问 Jev ---------------- */

async function askJev(board, score, step) {
  const legal = legalDirs(board)
  const payload = {
    model: 'jev-latest',
    state: boardToState(board, { score, steps: step }),
    questions: buildQuestions(legal),
  }

  let lastErr

  for (let attempt = 1; attempt <= 3; attempt++) {
    const t0 = performance.now()
    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const json = await res.json()

      if (res.status !== 200) {
        throw new Error(`HTTP ${res.status} — ${JSON.stringify(json).slice(0, 120)}`)
      }

      const ms = performance.now() - t0
      const dirAnswer = (json.answers && json.answers.direction) || {}

      return {
        dir: dirAnswer.choice,
        probabilities: dirAnswer.probabilities || {},
        confidence: dirAnswer.confidence,
        risk: json.answers && json.answers.risk ? json.answers.risk.score : undefined,
        model: json.model,
        usage: json.usage || {},
        ms,
        legal,
      }
    } catch (err) {
      lastErr = err
      if (attempt < 3) await new Promise((r) => setTimeout(r, 700 * attempt))
    }
  }

  throw lastErr
}

/* ---------------- 开跑 ---------------- */

let board = newBoard()
let score = 0
let steps = 0

const latencies = []
const milestones = {}
let illegal = 0
let inTokens = 0
let outTokens = 0
let peak = 0
let stopped = null

const startedAt = Date.now()

console.log('\n纯 Jev 对局 —— 每一步都由 jev-latest 决定')
console.log(`上限 ${MAX_STEPS} 步 · 每步真实调用，无本地兜底`)
console.log('─'.repeat(56))
console.log(render(board))
console.log('─'.repeat(56))

while (true) {
  if (steps >= MAX_STEPS) {
    stopped = `到达步数上限 ${MAX_STEPS}`
    break
  }
  if (!hasMove(board)) {
    stopped = '无路可走'
    break
  }

  let r
  try {
    r = await askJev(board, score, steps)
  } catch (err) {
    stopped = `Jev 连续 3 次调用失败：${err.message}`
    break
  }

  latencies.push(r.ms)
  inTokens += r.usage.input_tokens || 0
  outTokens += r.usage.output_tokens || 0

  let dir = r.dir
  if (!dir || !r.legal.includes(dir)) {
    illegal++
    // 不给本地算法，只从 Jev 自己给的概率里挑一个合法方向
    let best = null
    let bestP = -1
    for (const d of r.legal) {
      const p = Number(r.probabilities[d] ?? 0)
      if (p > bestP) {
        bestP = p
        best = d
      }
    }
    dir = best || r.legal[0]
  }

  const applied = applyMove(board, dir)
  board = applied.board
  score += applied.gained
  steps++

  const top = maxValue(board)
  if (top > peak) peak = top

  if (MILESTONES.includes(top) && !milestones[top]) {
    const sec = (Date.now() - startedAt) / 1000
    milestones[top] = { step: steps, score, sec }
    console.log(
      `\n  ◆ ${String(top).padStart(4)} 达成 ── 第 ${steps} 步 · 分数 ${score} · 用时 ${sec.toFixed(0)}s`
    )
    console.log(render(board))
  }

  if (top >= 2048) {
    stopped = '达成 2048'
    break
  }

  spawn(board)

  if (steps % 25 === 0) {
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length
    const sec = (Date.now() - startedAt) / 1000
    console.log(
      `  ${String(steps).padStart(4)} 步 · 分数 ${String(score).padStart(6)} · 最大 ${String(
        top
      ).padStart(4)} · 空格 ${String(countEmpty(board)).padStart(2)} · 均 ${avg.toFixed(
        0
      )}ms · 已跑 ${sec.toFixed(0)}s`
    )
  }
}

/* ---------------- 汇总 ---------------- */

const totalSec = (Date.now() - startedAt) / 1000

console.log('\n' + '─'.repeat(56))
console.log(render(board))
console.log('─'.repeat(56))
console.log(`结果         ${stopped}`)
console.log(`达成 2048    ${peak >= 2048 ? '是' : '否'}`)
console.log(`最终分数     ${score}`)
console.log(`总步数       ${steps}`)
console.log(`最大方块     ${peak}`)
console.log(`总耗时       ${totalSec.toFixed(1)} s（${(totalSec / 60).toFixed(1)} min）`)
console.log(`平均每步     ${((totalSec / Math.max(1, steps)) * 1000).toFixed(0)} ms`)
console.log(
  `非法方向     ${illegal} 次（占 ${((illegal / Math.max(1, steps)) * 100).toFixed(1)}%）`
)

if (latencies.length) {
  const s = [...latencies].sort((a, b) => a - b)
  const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))]
  console.log('')
  console.log(`Jev 最快     ${s[0].toFixed(0)} ms`)
  console.log(`Jev 中位     ${at(0.5).toFixed(0)} ms`)
  console.log(`Jev 平均     ${(s.reduce((a, b) => a + b, 0) / s.length).toFixed(0)} ms`)
  console.log(`Jev P95      ${at(0.95).toFixed(0)} ms`)
  console.log(`Jev 最慢     ${s[s.length - 1].toFixed(0)} ms`)
  console.log(`Jev 调用     ${latencies.length} 次`)
  console.log(`Token        输入 ${inTokens} · 输出 ${outTokens}`)
}

const hit = MILESTONES.filter((m) => milestones[m])
if (hit.length) {
  console.log('\n里程碑：')
  for (const m of hit) {
    console.log(
      `  ${String(m).padStart(4)}   第 ${String(milestones[m].step).padStart(4)} 步 · ` +
        `分数 ${String(milestones[m].score).padStart(6)} · ${milestones[m].sec.toFixed(0)}s`
    )
  }
}

console.log('─'.repeat(56) + '\n')

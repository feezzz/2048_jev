/**
 * 纯 Jev 对局 · v3 阵型策略版
 *
 * 和 v1 的区别只在 instructions：把高手的阵型打法明确写给模型看，
 * 让它判的不是「哪步能拿分」，而是「哪步能维持阵型」。
 *
 *   v1  开放式提问：「为了让最终分数尽可能高，往哪走？」
 *   v3  带策略提问：「先把最大方块钉在角落、沿边蛇形排列、始终留空格 —— 往哪走？」
 *
 * 用法：node test/play.v3.mjs [最大步数]
 */
import { SIZE, applyMove, maxValue, hasMove, countEmpty } from '../src/game.js'
import { legalDirs, boardToState } from '../src/ai.js'

const ENDPOINT = 'http://127.0.0.1:5173/api/jev'
const MAX_STEPS = Number(process.argv[2] || 600)
const MILESTONES = [128, 256, 512, 1024, 2048]

const DIR_LABEL = { up: '向上', down: '向下', left: '向左', right: '向右' }

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

/* ---------------- v3 提问：把策略讲清楚 ---------------- */

function buildQuestions(legal, board) {
  const criteria = {}
  for (const d of legal) criteria[d] = DIR_LABEL[d]

  const top = maxValue(board)

  return {
    formation: {
      type: 'score',
      instructions:
        '当前阵型保持得怎么样？高手的阵型是：最大的方块钉在一个角落，' +
        '其余数字沿着相邻的两条边从大到小蛇形排列。',
      criteria: [
        '很乱：大数散在中间，谈不上阵型',
        '有点乱：大数大致在一侧，但边上的数字不成序',
        '还行：大数靠近某个角落，排列基本有序',
        '不错：大数稳在角落，两条边上大体是有序的',
        '很好：标准的蛇形阵，最大方块牢牢钉在角落',
      ],
    },
    direction: {
      type: 'choice',
      instructions:
        '这是 2048。玩得好的关键不是单步拿分，而是维持阵型。高手的做法是：\n' +
        '1. 把最大的方块钉在一个角落，之后尽量不再让它挪动；\n' +
        '2. 其余数字沿着相邻的两条边，从大到小蛇形排列；\n' +
        '3. 始终保留空格，宁可暂时不合并，也不要把棋盘走满。\n' +
        `现在棋盘上最大的是 ${top}。结合上面三条，这一步往哪个方向滑动最合适？`,
      criteria,
    },
  }
}

async function judge(board, score, step, legal) {
  const payload = {
    model: 'jev-latest',
    state: boardToState(board, { score, steps: step }),
    questions: buildQuestions(legal, board),
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

      return {
        answers: json.answers || {},
        model: json.model,
        usage: json.usage || {},
        ms: performance.now() - t0,
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
const formationScores = []
let inTokens = 0
let outTokens = 0
let peak = 0
let stopped = null
let illegal = 0

const startedAt = Date.now()

console.log('\n纯 Jev 对局 · v3 阵型策略版')
console.log(`上限 ${MAX_STEPS} 步 · instructions 里写明阵型打法`)
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

  const legal = legalDirs(board)
  let r
  try {
    r = await judge(board, score, steps, legal)
  } catch (err) {
    stopped = `Jev 连续 3 次调用失败：${err.message}`
    break
  }

  latencies.push(r.ms)
  inTokens += r.usage.input_tokens || 0
  outTokens += r.usage.output_tokens || 0

  if (typeof r.answers.formation?.score === 'number') {
    formationScores.push(r.answers.formation.score)
  }

  let dir = (r.answers.direction || {}).choice
  if (!dir || !legal.includes(dir)) {
    illegal++
    dir = legal[0]
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
console.log(`非法方向     ${illegal} 次`)

if (formationScores.length) {
  const avgF = formationScores.reduce((a, b) => a + b, 0) / formationScores.length
  console.log(`阵型均分     ${avgF.toFixed(2)} / 4（越高越好）`)
  console.log(`阵型末值     ${formationScores[formationScores.length - 1].toFixed(1)}`)
}

if (latencies.length) {
  const s = [...latencies].sort((a, b) => a - b)
  const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))]
  console.log('')
  console.log(`Jev 中位     ${at(0.5).toFixed(0)} ms`)
  console.log(`Jev 平均     ${(s.reduce((a, b) => a + b, 0) / s.length).toFixed(0)} ms`)
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

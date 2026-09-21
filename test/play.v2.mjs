/**
 * 纯 Jev 对局 · 打分选向版
 *
 * 和 play.jev.mjs 的唯一区别是「怎么问」：
 *
 *   v1（直接问）  —— 一个 choice 问题：「下一步往哪走？」
 *                    等于让模型在心算全局策略，它不擅长这个。
 *
 *   v2（打分选向）—— 对每个合法方向各问一个 score 问题：
 *                    「如果走这个方向，对后续发展有多有利？」
 *                    再由代码取分数最高的那个。
 *                    这是 Jev 官方推荐的路子：原子问题 + 代码做加总。
 *                    同时吃到「多问题几乎不增加耗时」这个特性。
 *
 * 用法：node test/play.v2.mjs [最大步数]
 */
import { SIZE, applyMove, maxValue, hasMove, countEmpty } from '../src/game.js'
import { legalDirs, boardToState } from '../src/ai.js'

const ENDPOINT = 'http://127.0.0.1:5173/api/jev'
const MAX_STEPS = Number(process.argv[2] || 600)
const MILESTONES = [128, 256, 512, 1024, 2048]

const DIR_LABEL = { up: '向上', down: '向下', left: '向左', right: '向右' }

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

/* ---------------- v2 提问：拆成原子问题 ---------------- */

function buildQuestions(legal) {
  const questions = {
    anchor: {
      type: 'choice',
      instructions: '棋盘上最大的那个方块，最应该固定在哪一个角？',
      criteria: {
        tl: '左上角',
        tr: '右上角',
        bl: '左下角',
        br: '右下角',
      },
    },
    risk: {
      type: 'score',
      instructions: '当前局面有多危险？',
      criteria: [
        '很安全，空格很多',
        '还行，有足够腾挪空间',
        '偏紧，空格已经不多了',
        '危险，再走错几步就满',
        '濒死，几乎没有空格',
      ],
    },
  }

  for (const d of legal) {
    questions[`dir_${d}`] = {
      type: 'score',
      instructions:
        `如果这一步选择${DIR_LABEL[d]}滑动，对整局的后续发展有多有利？` +
        '评判时重点看三件事：能否留下更多空格、能否让最大的方块继续待在角落、' +
        '能否为后面凑出更大的数字创造机会。',
      criteria: [
        '很糟：棋盘会更满，或者把大数挤离角落',
        '偏差：损失了空格，或把大数挪出角落',
        '一般：没有改善，也没有明显损失',
        '不错：保住了空格，大数继续待在角落',
        '很好：空出新的合并位，大数稳稳留在角落',
      ],
    }
  }

  return questions
}

/* ---------------- 调用 ---------------- */

async function judge(board, score, step, legal) {
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

      return { answers: json.answers || {}, model: json.model, usage: json.usage || {}, ms: performance.now() - t0 }
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
let inTokens = 0
let outTokens = 0
let peak = 0
let stopped = null
let questionCount = 0
let tieBreak = 0

const startedAt = Date.now()

console.log('\n纯 Jev 对局 · v2 打分选向')
console.log(`上限 ${MAX_STEPS} 步 · 每步对每个合法方向分别打分，取最高`)
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
  questionCount += legal.length + 2

  // 代码做加总：取打分最高的方向；并列时保持 up>down>left>right 的稳定顺序
  const ranked = legal
    .map((d) => ({ d, s: Number((r.answers[`dir_${d}`] || {}).score ?? -1) }))
    .sort((a, b) => b.s - a.s)

  if (ranked.length > 1 && ranked[0].s === ranked[1].s) tieBreak++

  const dir = ranked[0].d

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
console.log(`问题总数     ${questionCount}（均 ${(questionCount / Math.max(1, steps)).toFixed(1)} 个/步）`)
console.log(`打分并列     ${tieBreak} 次`)

if (latencies.length) {
  const s = [...latencies].sort((a, b) => a - b)
  const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))]
  console.log('')
  console.log(`Jev 中位     ${at(0.5).toFixed(0)} ms`)
  console.log(`Jev 平均     ${(s.reduce((a, b) => a + b, 0) / s.length).toFixed(0)} ms`)
  console.log(`Jev P95      ${at(0.95).toFixed(0)} ms`)
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

/**
 * 两个对照实验：
 *   1. 问题数量会不会拖慢响应 —— Jev 宣称「加问题几乎不增加耗时」，验一下
 *   2. 并发吞吐 —— 同时打 8 个请求要多久
 *
 * 用法：node test/bench.compare.mjs [每组轮数]
 */
import { legalDirs, boardToState, buildQuestions } from '../src/ai.js'
import { SIZE } from '../src/game.js'

const URL = 'http://127.0.0.1:5173/api/jev'
const ROUNDS = Number(process.argv[2] || 10)

function randomBoard() {
  const b = Array.from({ length: SIZE }, () => Array(SIZE).fill(0))
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (Math.random() < 0.55) b[r][c] = 2 ** (1 + ((Math.random() * 7) | 0))
    }
  }
  return b
}

function makePayload(questionCount) {
  let b
  let legal
  do {
    b = randomBoard()
    legal = legalDirs(b)
  } while (legal.length < 2)

  const base = buildQuestions(legal)
  const questions = { direction: base.direction }
  if (questionCount >= 2) questions.risk = base.risk
  if (questionCount >= 3) {
    questions.outlook = {
      type: 'noul',
      instructions: '这个局面是否还有继续合并的空间？',
    }
  }

  return {
    model: 'jev-latest',
    state: boardToState(b, { score: 1200, steps: 90 }),
    questions,
  }
}

async function timed(payload) {
  const t0 = performance.now()
  const res = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const json = await res.json()
  const ms = performance.now() - t0
  if (res.status !== 200) throw new Error(`HTTP ${res.status} ${JSON.stringify(json).slice(0, 100)}`)
  return { ms, usage: json.usage || {} }
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

const avg = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length

console.log(`\n对照实验 · 每组 ${ROUNDS} 轮`)
console.log('─'.repeat(56))

const groups = { 1: [], 2: [], 3: [] }
const tokens = { 1: [], 2: [], 3: [] }

for (let i = 0; i < ROUNDS; i++) {
  for (const n of [1, 2, 3]) {
    try {
      const r = await timed(makePayload(n))
      groups[n].push(r.ms)
      tokens[n].push(r.usage.input_tokens || 0)
    } catch (err) {
      console.log(`  ! ${n} 问题组失败：${err.message}`)
    }
  }
  process.stdout.write(`  第 ${i + 1}/${ROUNDS} 轮完成\r`)
}
console.log(' '.repeat(30) + '\r')

console.log('问题数量 → 耗时')
for (const n of [1, 2, 3]) {
  const g = groups[n]
  if (!g.length) continue
  console.log(
    `  ${n} 个问题  中位 ${median(g).toFixed(0).padStart(4)} ms   平均 ${avg(g)
      .toFixed(0)
      .padStart(4)} ms   输入 token 均 ${avg(tokens[n]).toFixed(0).padStart(4)}`
  )
}

const m1 = median(groups[1])
const m3 = median(groups[3])
if (m1 && m3) {
  const delta = ((m3 - m1) / m1) * 100
  console.log(
    `\n  从 1 个问题加到 3 个：耗时变化 ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%，` +
      `输入 token 增加 ${(avg(tokens[3]) - avg(tokens[1])).toFixed(0)}`
  )
}

/* ---------------- 并发 ---------------- */
console.log('\n' + '─'.repeat(56))
console.log('并发 · 同时打 8 个请求')

const CONC = 8
const payloads = Array.from({ length: CONC }, () => makePayload(2))

const t0 = performance.now()
let results
try {
  results = await Promise.all(payloads.map((p) => timed(p)))
  const wall = performance.now() - t0
  const each = results.map((r) => r.ms)

  console.log(`  墙上时间 ${wall.toFixed(0)} ms`)
  console.log(`  单个中位 ${median(each).toFixed(0)} ms，最慢 ${Math.max(...each).toFixed(0)} ms`)
  console.log(
    `  吞吐约 ${((CONC / wall) * 1000).toFixed(1)} 次/秒（串行时约 ${(
      1000 / median(each)
    ).toFixed(1)} 次/秒）`
  )
} catch (err) {
  console.log(`  并发失败：${err.message}`)
}

console.log('─'.repeat(56) + '\n')

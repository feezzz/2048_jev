/**
 * Jev 延迟基准
 *
 * 走 dev server 的代理打真实请求 —— 测的就是页面里那条链路本身。
 * 每一轮用一个随机中盘当 state，问题和游戏里发的完全一致。
 *
 * 用法：node test/bench.jev.mjs [次数]
 */
import { legalDirs, boardToState, buildQuestions } from '../src/ai.js'
import { SIZE } from '../src/game.js'

const ENDPOINT = 'http://127.0.0.1:5173/api/jev'
const ROUNDS = Number(process.argv[2] || 30)

function randomBoard(fill = 0.6) {
  const b = Array.from({ length: SIZE }, () => Array(SIZE).fill(0))
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (Math.random() < fill) b[r][c] = 2 ** (1 + ((Math.random() * 7) | 0))
    }
  }
  return b
}

const samples = []
const failures = []

console.log(`\nJev 延迟基准 · ${ROUNDS} 次真实决策请求`)
console.log('─'.repeat(56))

for (let i = 0; i < ROUNDS; i++) {
  let board
  let legal
  let guard = 0
  do {
    board = randomBoard()
    legal = legalDirs(board)
    guard++
  } while (legal.length < 2 && guard < 300)

  const payload = {
    model: 'jev-latest',
    state: boardToState(board, { score: i * 24, steps: i }),
    questions: buildQuestions(legal),
  }

  const t0 = performance.now()
  let status = 0
  let json = null

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    status = res.status
    json = await res.json()
  } catch (err) {
    failures.push(`请求异常：${err.message}`)
    if (failures.length >= 3) break
    continue
  }

  const dt = performance.now() - t0

  if (status !== 200) {
    failures.push(`HTTP ${status} — ${JSON.stringify(json).slice(0, 140)}`)
    if (failures.length >= 3) break
    continue
  }

  const answer = (json.answers && json.answers.direction) || {}
  const dir = answer.choice
  const hit = legal.includes(dir)

  samples.push({
    ms: dt,
    usage: json.usage || {},
    dir,
    hit,
    conf: answer.confidence,
    model: json.model,
  })

  const bar = '█'.repeat(Math.max(1, Math.round(dt / 25)))
  console.log(
    `  ${String(i + 1).padStart(2)}. ${dt.toFixed(0).padStart(5)} ms  ${bar}  ` +
      `→ ${String(dir).padEnd(5)}${hit ? '' : '  ⚠ 非法方向'}`
  )
}

if (failures.length) {
  console.log('\n失败/异常：')
  for (const f of failures.slice(0, 6)) console.log(`  · ${f}`)
}

if (!samples.length) {
  console.log('\n一个有效样本都没拿到，先确认 .env 里的 key 和 dev server 状态。\n')
  process.exit(1)
}

const ms = samples.map((s) => s.ms).sort((a, b) => a - b)
const sum = ms.reduce((a, b) => a + b, 0)
const at = (p) => ms[Math.min(ms.length - 1, Math.floor(ms.length * p))]

const inTok = samples.reduce((a, s) => a + (s.usage.input_tokens || 0), 0)
const outTok = samples.reduce((a, s) => a + (s.usage.output_tokens || 0), 0)
const hitRate = samples.filter((s) => s.hit).length / samples.length

console.log('\n' + '─'.repeat(56))
console.log(`有效样本     ${samples.length} / ${ROUNDS}`)
console.log(`模型         ${samples[0].model}`)
console.log('')
console.log(`最快         ${ms[0].toFixed(0)} ms`)
console.log(`中位数       ${at(0.5).toFixed(0)} ms`)
console.log(`平均         ${(sum / ms.length).toFixed(0)} ms`)
console.log(`P95          ${at(0.95).toFixed(0)} ms`)
console.log(`最慢         ${ms[ms.length - 1].toFixed(0)} ms`)
console.log('')
console.log(`方向合法率   ${(hitRate * 100).toFixed(1)}%`)
console.log(
  `Token        输入 ${inTok}（均 ${(inTok / samples.length).toFixed(0)}/次）· 输出 ${outTok}`
)
console.log('─'.repeat(56) + '\n')

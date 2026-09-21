/**
 * AI 决策层测试
 *
 * 重点不是「Jev 判断得准不准」（那是模型的事），而是接入是否严密：
 *   1. 棋盘 → state / questions 的翻译对不对
 *   2. 给出去的方向必须真的能走，绝不能把走不动的方向交给模型去选
 *   3. Jev 返回非法值、报错、没配 key 时，能不能安稳退回本地而不崩
 *   4. 请求体是否符合官方规格
 */
import { legalDirs, boardToState, buildQuestions, localMove, decideMove } from '../src/ai.js'
import { SIZE, applyMove } from '../src/game.js'

let failures = 0
let checks = 0

function ok(cond, msg) {
  checks++
  if (!cond) {
    failures++
    if (failures <= 10) console.log(`  FAIL  ${msg}`)
  }
}

function eq(actual, expected, msg) {
  checks++
  if (actual !== expected) {
    failures++
    if (failures <= 10) console.log(`  FAIL  ${msg}（得到 ${actual}，应为 ${expected}）`)
  }
}

/* ---------------- 拦截 fetch，模拟各种 Jev 响应 ---------------- */
const realFetch = globalThis.fetch
let captured = null

function mockJev(handler) {
  globalThis.fetch = async (url, init) => {
    captured = { url, body: JSON.parse(init.body) }
    const out = handler(captured) || {}
    return new Response(JSON.stringify(out.body ?? {}), { status: out.status ?? 200 })
  }
}

function mockNetworkError() {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch')
  }
}

function restoreFetch() {
  globalThis.fetch = realFetch
}

const okAnswer = (choice) => () => ({
  status: 200,
  body: {
    model: 'jev-1.13.0',
    answers: {
      direction: {
        type: 'choice',
        choice,
        probabilities: { [choice]: 0.88 },
        confidence: 0.88,
      },
      risk: { type: 'score', score: 1.4 },
    },
    usage: { input_tokens: 174, output_tokens: 11 },
  },
})

/* ---------------- 随机棋盘 ---------------- */
function randomBoard(fill = 0.65) {
  const b = Array.from({ length: SIZE }, () => Array(SIZE).fill(0))
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (Math.random() < fill) b[r][c] = 2 ** (1 + ((Math.random() * 6) | 0))
    }
  }
  return b
}

console.log('\n2048 × Jev 决策层测试')
console.log('─'.repeat(52))

/* -------------------------------------------------------------------------
   1. legalDirs
   ------------------------------------------------------------------------- */
console.log('\n[legalDirs]')

const dead = [
  [2, 4, 2, 4],
  [4, 2, 4, 2],
  [2, 4, 2, 4],
  [4, 2, 4, 2],
]
eq(legalDirs(dead).length, 0, '死局应当没有任何合法方向')

const onlyRight = [
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 0, 2],
]
ok(legalDirs(onlyRight).includes('up'), '单个方块应当能向上推动')

{
  let checked = 0
  for (let i = 0; i < 500; i++) {
    const b = randomBoard()
    for (const d of legalDirs(b)) {
      ok(applyMove(b, d).moved, `legalDirs 给出了走不动的方向 ${d}`)
      checked++
    }
    for (const d of ['up', 'down', 'left', 'right']) {
      if (!legalDirs(b).includes(d)) {
        ok(!applyMove(b, d).moved, `legalDirs 漏掉了可走的方向 ${d}`)
      }
    }
  }
  console.log(`  ✓ 500 个随机棋盘，合法方向判定与推演结果一致（覆盖 ${checked} 个方向）`)
}

/* -------------------------------------------------------------------------
   2. boardToState
   ------------------------------------------------------------------------- */
console.log('\n[boardToState]')

{
  const board = [
    [2, 0, 0, 4],
    [0, 8, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 16, 0],
  ]
  const s = boardToState(board, { score: 12, steps: 3 })

  ok(s.includes('2048'), 'state 应说明这是 2048')
  ok(s.includes('2') && s.includes('4') && s.includes('8') && s.includes('16'), 'state 应包含所有方块数值')
  ok(s.includes('当前分数：12'), 'state 应包含分数')
  ok(s.includes('已走步数：3'), 'state 应包含步数')
  ok(s.includes('最大方块：16'), 'state 应包含最大方块')
  ok(s.includes('剩余空格：12'), 'state 应包含剩余空格数')
  ok(s.split('\n').length > 6, 'state 应当是多行文本')
  console.log('  ✓ 棋盘翻译成文本，含分数 / 步数 / 最大方块 / 空格数')
}

/* -------------------------------------------------------------------------
   3. buildQuestions
   ------------------------------------------------------------------------- */
console.log('\n[buildQuestions]')

{
  const q = buildQuestions(['left', 'down'])

  eq(q.direction.type, 'choice', 'direction 应当是 choice 类型')
  ok(typeof q.direction.instructions === 'string' && q.direction.instructions.length > 10, 'instructions 不能为空')

  const opts = Object.keys(q.direction.criteria)
  eq(opts.length, 2, '选项数应等于合法方向数')
  ok(opts.includes('left') && opts.includes('down'), '选项应恰好是合法方向')
  ok(!opts.includes('up') && !opts.includes('right'), '不该出现走不动的方向')

  eq(q.risk.type, 'score', 'risk 应当是 score 类型')
  ok(Array.isArray(q.risk.criteria), 'score 的 criteria 应当是有序数组')
  ok(q.risk.criteria.length >= 2 && q.risk.criteria.length <= 10, 'score 档位应在 2–10 之间')

  console.log(`  ✓ 只把 ${opts.length} 个合法方向放进选项，另带一个局面危险度评分`)
}

/* -------------------------------------------------------------------------
   4. localMove
   ------------------------------------------------------------------------- */
console.log('\n[localMove]')

{
  for (let i = 0; i < 400; i++) {
    const b = randomBoard()
    const legal = legalDirs(b)
    const d = localMove(b)

    if (legal.length === 0) ok(d === null, '无路可走时应返回 null')
    else ok(legal.includes(d), `localMove 返回了非法方向 ${d}`)
  }
  console.log('  ✓ 400 个随机棋盘，本地兜底永远只给合法方向')
}

/* -------------------------------------------------------------------------
   5. decideMove —— 正常路径
   ------------------------------------------------------------------------- */
console.log('\n[decideMove · 正常]')

{
  const board = [
    [2, 2, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]

  mockJev(okAnswer('left'))
  const r = await decideMove(board, { score: 0, steps: 0 })

  eq(r.source, 'jev', '应当走 Jev 这条路径')
  eq(r.dir, 'left', '方向应当来自 Jev 的答案')
  ok(typeof r.latency === 'number' && r.latency >= 0, 'latency 应当是数字')
  eq(r.model, 'jev-1.13.0', '应当回传服务端返回的模型号')
  eq(r.usage.input_tokens, 174, '应当回传 token 用量')
  eq(r.confidence, 0.88, '应当回传选择题的置信度')
  eq(r.risk, 1.4, '应当回传危险度评分')

  eq(captured.url, '/api/jev', '请求应当打到同源代理，避免暴露密钥')
  eq(captured.body.model, 'jev-latest', '默认模型别名应为 jev-latest')
  ok(typeof captured.body.state === 'string', 'state 应当是字符串')
  eq(captured.body.questions.direction.type, 'choice', '请求体的题型应当正确')

  const sent = Object.keys(captured.body.questions.direction.criteria)
  ok(sent.every((d) => legalDirs(board).includes(d)), '发给模型的方向必须都是能走的')

  console.log(`  ✓ 链路打通：方向 ${r.dir}，置信 ${r.confidence}，耗时字段就位`)
}

/* -------------------------------------------------------------------------
   6. decideMove —— 异常与兜底
   ------------------------------------------------------------------------- */
console.log('\n[decideMove · 兜底]')

{
  const board = [
    [2, 2, 4, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ]
  const legal = legalDirs(board)

  // 模型给了个不在选项里的方向
  mockJev(okAnswer('diagonal'))
  let r = await decideMove(board, {})
  eq(r.source, 'local', '模型返回非法方向时应退回本地')
  ok(legal.includes(r.dir), '兜底方向也必须是合法的')
  console.log(`  ✓ 模型返回非法方向 → 退回本地（${r.dir}）`)

  // 模型没给 choice 字段
  mockJev(() => ({ status: 200, body: { model: 'x', answers: {}, usage: {} } }))
  r = await decideMove(board, {})
  eq(r.source, 'local', '答案缺字段时应退回本地')
  console.log('  ✓ 答案缺字段 → 退回本地')

  // 401
  mockJev(() => ({ status: 401, body: { error: 'invalid api key' } }))
  r = await decideMove(board, {})
  eq(r.source, 'local', '401 时应退回本地')
  ok(r.reason.includes('401'), `401 的提示应当带上状态码，实际：${r.reason}`)
  ok(legal.includes(r.dir), '401 兜底方向也必须合法')
  console.log(`  ✓ 401 → 退回本地，提示：${r.reason.slice(0, 46)}…`)

  // 403 —— 实测缺 key 时官方返回的就是 403
  mockJev(() => ({
    status: 403,
    body: {
      detail: { error_type: 'authentication_error', message: 'Must supply an API key!' },
    },
  }))
  r = await decideMove(board, {})
  eq(r.source, 'local', '403 时应退回本地')
  ok(r.reason.includes('API key'), `403 应提示是密钥问题，实际：${r.reason}`)
  console.log('  ✓ 403（缺 key 的真实返回）→ 退回本地')

  // 429 限流
  mockJev(() => ({ status: 429, body: { error: 'rate limited' } }))
  r = await decideMove(board, {})
  eq(r.source, 'local', '限流时应退回本地')
  ok(r.reason.includes('限流'), '限流提示应当能看懂')
  console.log('  ✓ 限流 → 退回本地')

  // 网络不通
  mockNetworkError()
  r = await decideMove(board, {})
  eq(r.source, 'local', '网络异常时应退回本地')
  ok(legal.includes(r.dir), '网络异常兜底方向也必须合法')
  console.log('  ✓ 网络不通 → 退回本地')

  // 返回的不是 JSON
  globalThis.fetch = async () => new Response('<html>502</html>', { status: 502 })
  r = await decideMove(board, {})
  eq(r.source, 'local', '非 JSON 响应应退回本地')
  console.log('  ✓ 非 JSON 响应 → 退回本地')
}

/* -------------------------------------------------------------------------
   7. decideMove —— 边界情况
   ------------------------------------------------------------------------- */
console.log('\n[decideMove · 边界]')

{
  // 死局：不该发起任何请求
  let called = false
  globalThis.fetch = async () => {
    called = true
    return new Response('{}', { status: 200 })
  }

  const r = await decideMove(dead, {})
  eq(r.dir, null, '死局应当返回 null')
  eq(r.source, 'none', '死局应当标记为 none')
  ok(!called, '死局不该白白花一次调用')
  console.log('  ✓ 死局：直接返回，不发起请求')

  // 只有一个合法方向：也不该花调用
  // 底行占满，向下/向左/向右都推不动，只能整行上移
  const oneWay = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [2, 4, 8, 16],
  ]
  eq(legalDirs(oneWay).length, 1, '底行满行时应当只有向上可走')

  called = false
  const r2 = await decideMove(oneWay, {})
  eq(r2.source, 'skip', '只有一个方向时应跳过调用')
  eq(r2.dir, 'up', '跳过时应返回那个唯一方向')
  ok(!called, '只有一个方向时不该发起请求')
  console.log('  ✓ 唯一选择：跳过调用，省一次额度')

  // forceLocal
  called = false
  const r3 = await decideMove(randomBoard(), {}, { forceLocal: true })
  eq(r3.source, 'local', 'forceLocal 应当强制走本地')
  ok(!called, 'forceLocal 不该发起请求')
  console.log('  ✓ forceLocal：完全离线，一个请求都不发')
}

restoreFetch()

console.log('\n' + '─'.repeat(52))
console.log(`断言 ${checks} 条，失败 ${failures} 条`)
console.log(failures === 0 ? '结果：全部通过 ✅\n' : '结果：存在失败 ❌\n')

process.exit(failures === 0 ? 0 : 1)

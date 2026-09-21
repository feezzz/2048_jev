/**
 * 让 Jev 来玩 2048。
 *
 * 每次决策的链路：
 *   棋盘 → 文本 state + 一个 choice 问题（往哪走）→ Jev 返回带概率的选项 → 方向
 *
 * Jev 是「System One」决策模型，不生成文本，只在你给的选项里挑一个并给出概率，
 * 官方标称约 100ms 一次。这个模块同时记录真实耗时，供 UI 展示。
 *
 * 没配 API key 时自动退回本地贪心，保证功能始终可演示。
 */
import { SIZE, applyMove, maxValue, countEmpty } from './game.js'
import { ask } from './jev.js'

const ALL_DIRS = ['up', 'down', 'left', 'right']

const DIR_LABEL = {
  up: '向上滑动',
  down: '向下滑动',
  left: '向左滑动',
  right: '向右滑动',
}

/* ==========================================================================
   棋盘 → 提问
   ========================================================================== */

/** 列出当前真正能推动的方向 */
export function legalDirs(board) {
  return ALL_DIRS.filter((d) => applyMove(board, d).moved)
}

/**
 * 把棋盘写成 Jev 能读的文本。
 * 用等宽对齐，让模型一眼看清每一行有哪些格子。
 */
export function boardToState(board, meta = {}) {
  const rows = board.map((row) =>
    row.map((v) => (v === 0 ? '  ·' : String(v).padStart(3))).join(' ')
  )

  return [
    '2048 游戏局面，4x4 棋盘，· 表示空格：',
    '',
    ...rows.map((r) => `  ${r}`),
    '',
    `当前分数：${meta.score ?? 0}`,
    `已走步数：${meta.steps ?? 0}`,
    `最大方块：${maxValue(board)}`,
    `剩余空格：${countEmpty(board)}`,
  ].join('\n')
}

/** 只把合法方向放进选项，避免模型选出走不动的方向 */
export function buildQuestions(legal) {
  const criteria = {}
  for (const d of legal) criteria[d] = DIR_LABEL[d]

  return {
    direction: {
      type: 'choice',
      instructions:
        '这是一局 2048。为了让最终分数尽可能高，下一步应该往哪个方向滑动？' +
        '只在给出的选项里挑一个。',
      criteria,
    },
    risk: {
      type: 'score',
      instructions: '当前局面有多危险？',
      criteria: [
        '很安全，空格充足，随便走',
        '一般，需要留意布局',
        '危险，空格所剩不多',
        '濒临结束，几乎没有腾挪空间',
      ],
    },
  }
}

/* ==========================================================================
   本地兜底评分
   ========================================================================== */

/** 给一个局面打分，越高越好。纯启发式，用来在无 key / 请求失败时顶上。 */
export function scoreBoard(board) {
  const empties = countEmpty(board)
  const max = maxValue(board)

  // 最大的方块待在角上，就不会被两边同时堵死
  const corners = [
    board[0][0],
    board[0][SIZE - 1],
    board[SIZE - 1][0],
    board[SIZE - 1][SIZE - 1],
  ]
  const inCorner = max > 0 && corners.includes(max)

  // 相邻同值越多，后面能合并的机会越多
  let neighbors = 0
  // 单调性：行列尽量保持一个方向递减，避免高低交错
  let monotone = 0

  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = board[r][c]
      if (!v) continue
      if (c + 1 < SIZE) {
        if (board[r][c + 1] === v) neighbors++
        if (v >= board[r][c + 1]) monotone++
      }
      if (r + 1 < SIZE && board[r + 1][c] === v) neighbors++
    }
  }

  return empties * 120 + monotone * 20 + neighbors * 30 + (inCorner ? 200 : 0)
}

/** 本地贪心：把每个合法方向推演一遍，挑分最高的 */
export function localMove(board) {
  let best = null
  let bestScore = -Infinity

  for (const d of legalDirs(board)) {
    const { board: next, gained } = applyMove(board, d)
    const s = scoreBoard(next) + gained * 0.5
    if (s > bestScore) {
      bestScore = s
      best = d
    }
  }

  return best
}

/* ==========================================================================
   主决策
   ========================================================================== */

/**
 * 问出下一步该往哪走。
 *
 * @param {number[][]} board
 * @param {{ score?: number, steps?: number }} meta
 * @param {{ signal?: AbortSignal, forceLocal?: boolean }} [opts]
 * @returns {Promise<{
 *   dir: string|null,
 *   source: 'jev'|'local'|'none',
 *   reason?: string,
 *   latency?: number,
 *   usage?: { input_tokens: number, output_tokens: number },
 *   model?: string,
 *   confidence?: number,
 *   probabilities?: Record<string, number>,
 *   risk?: number,
 * }>}
 */
export async function decideMove(board, meta = {}, opts = {}) {
  const legal = legalDirs(board)

  if (legal.length === 0) {
    return { dir: null, source: 'none', reason: '没有可走的方向' }
  }

  // 只有一个选择时，默认不花这次调用；askEveryMove 可强制每步都问
  if (legal.length === 1 && !opts.askEveryMove) {
    return { dir: legal[0], source: 'skip', reason: '只有一个合法方向' }
  }

  if (opts.forceLocal) {
    return { dir: localMove(board), source: 'local', reason: '本地模式' }
  }

  const state = boardToState(board, meta)
  const questions = buildQuestions(legal)

  try {
    const res = await ask(state, questions, { signal: opts.signal })
    const answer = res.answers.direction
    const dir = answer && answer.choice

    // 模型偶尔会给个不在选项里的值，或者压根没给 —— 都退回本地
    if (!dir || !legal.includes(dir)) {
      return {
        dir: localMove(board),
        source: 'local',
        reason: `Jev 返回了不可用的方向：${dir === undefined ? '缺失' : dir}`,
        latency: res.latency,
        usage: res.usage,
        model: res.model,
      }
    }

    const riskAnswer = res.answers.risk

    return {
      dir,
      source: 'jev',
      latency: res.latency,
      usage: res.usage,
      model: res.model,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      risk: riskAnswer && typeof riskAnswer.score === 'number' ? riskAnswer.score : undefined,
    }
  } catch (err) {
    if (err && err.name === 'AbortError') throw err
    return {
      dir: localMove(board),
      source: 'local',
      reason: (err && err.message) || String(err),
    }
  }
}

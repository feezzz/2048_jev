/**
 * 2048 的纯规则层 —— 不碰 DOM，可以单独跑测试。
 *
 * 核心概念：
 *   line   棋盘按移动方向切出来的一条线（4 格），坐标按「越靠前越先到位」排列
 *   slot   一条线合并后的第 k 个落点，记录它由哪个来源填充
 */

export const SIZE = 4

const DIRS = {
  up: { vertical: true, reverse: false },
  down: { vertical: true, reverse: true },
  left: { vertical: false, reverse: false },
  right: { vertical: false, reverse: true },
}

/**
 * 把棋盘按移动方向切成 SIZE 条线。
 *
 * 顺序很关键：left 要从最左列开始处理，right 从最右列开始，
 * 这样先落位的方块才不会被后面的方块穿过。
 *
 * @param {'up'|'down'|'left'|'right'} dir
 * @returns {Array<Array<{r:number,c:number}>>}
 */
export function linesFor(dir) {
  const d = DIRS[dir]
  if (!d) throw new Error(`未知方向：${dir}`)

  const lines = []
  for (let k = 0; k < SIZE; k++) {
    const line = []
    for (let i = 0; i < SIZE; i++) {
      const j = d.reverse ? SIZE - 1 - i : i
      line.push(d.vertical ? { r: j, c: k } : { r: k, c: j })
    }
    lines.push(line)
  }
  return lines
}

/**
 * 滑动 + 合并一条线。
 *
 * 规则：先靠拢，再合并；同一个方块一回合只能参与一次合并，
 * 所以 [2,2,2] 向左是 [4,2] 而不是 [2,4] 或 [8]。
 *
 * @param {Array<number|null>} values 长度为 SIZE，空位传 null
 * @returns {{ slots: Array<{from:number, mergedWith?:number}>, gained: number }}
 *   slots[k] —— 第 k 个槽位由 values[slot.from] 填充；
 *              若带 mergedWith，说明这一格是 from 与 mergedWith 合并的结果。
 *   gained   —— 本次合并新增的分数。
 */
export function computeLine(values) {
  const filled = []
  for (let i = 0; i < values.length; i++) {
    if (values[i]) filled.push(i)
  }

  const slots = []
  let gained = 0

  for (let i = 0; i < filled.length; i++) {
    const a = filled[i]
    const b = filled[i + 1]

    if (b !== undefined && values[b] === values[a]) {
      slots.push({ from: a, mergedWith: b })
      gained += values[a] * 2
      i++ // b 已经被吞，跳过
    } else {
      slots.push({ from: a })
    }
  }

  return { slots, gained }
}

/** 读取棋盘上出现过的最大值 */
export function maxValue(board) {
  let max = 0
  for (const row of board) {
    for (const v of row) {
      if (v > max) max = v
    }
  }
  return max
}

/** 棋盘上是否还有可行的移动 */
export function hasMove(board) {
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      const v = board[r][c]
      if (!v) return true
      if (c + 1 < SIZE && board[r][c + 1] === v) return true
      if (r + 1 < SIZE && board[r + 1][c] === v) return true
    }
  }
  return false
}

/**
 * 把一次移动应用到数值棋盘上。
 *
 * 和渲染层不同，这里不关心「哪个方块是哪个」，只算数值结果，
 * 所以可以直接拿来做推演和评分。
 *
 * @param {number[][]} board
 * @param {'up'|'down'|'left'|'right'} dir
 * @returns {{ board: number[][], gained: number, moved: boolean }}
 */
export function applyMove(board, dir) {
  const next = board.map((row) => [...row])
  let gained = 0
  let moved = false

  for (const line of linesFor(dir)) {
    const olds = line.map((p) => next[p.r][p.c])
    const values = olds.map((v) => v || null)
    const plan = computeLine(values)
    gained += plan.gained

    for (const p of line) next[p.r][p.c] = 0

    plan.slots.forEach((slot, k) => {
      const p = line[k]
      const raw = olds[slot.from]
      next[p.r][p.c] = slot.mergedWith !== undefined ? raw * 2 : raw
      if (slot.from !== k || slot.mergedWith !== undefined) moved = true
    })
  }

  return { board: next, gained, moved }
}

/** 棋盘上的空格数 */
export function countEmpty(board) {
  let n = 0
  for (const row of board) {
    for (const v of row) {
      if (!v) n++
    }
  }
  return n
}

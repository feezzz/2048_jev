import './style.css'
import { SIZE, linesFor, computeLine, maxValue, hasMove } from './game.js'
import { decideMove } from './ai.js'

/* ==========================================================================
   2048 —— 渲染与交互层

   规则全部委托给 game.js（纯函数），这里只负责：
     · 用 tile 对象维护棋盘身份，让「同一个方块」在移动前后是同一个 DOM 元素
     · 位置交给 CSS 变量 + transition，所以位移是合成动画，不触发重排
   ========================================================================== */

const WIN_VALUE = 2048
const BEST_KEY = '2048:best'

/* ---------------- DOM ---------------- */
const $ = (id) => document.getElementById(id)

const $board = $('board')
const $grid = $('grid')
const $tiles = $('tiles')
const $score = $('score')
const $best = $('best')
const $steps = $('steps')
const $merges = $('merges')
const $perf = $('perf')
const $overlay = $('overlay')
const $overlayTitle = $('overlay-title')
const $overlayDesc = $('overlay-desc')
const $overlayBtn = $('overlay-btn')
const $newGame = $('new-game')
const $undo = $('undo')

const $aiToggle = $('ai-toggle')
const $aiDot = $('ai-dot')
const $aiNote = $('ai-note')
const $aiLog = $('ai-log')
const $mLast = $('m-last')
const $mAvg = $('m-avg')
const $mMin = $('m-min')
const $mMax = $('m-max')
const $mCalls = $('m-calls')
const $mTokens = $('m-tokens')

/* ---------------- 状态 ---------------- */
let cell // SIZE x SIZE，元素为 tile 或 null
let tiles // Map<id, tile>
let uid // 自增 id
let score
let steps
let merges
let history // 撤销栈
let finished // 本局是否已结束
let passed2048 // 是否已达成 2048 并选择继续
let overlayMode // 'win' | 'lose'
let best = Number(localStorage.getItem(BEST_KEY) || 0)

/* ---------------- Jev 托管 ---------------- */
let aiOn = false
let aiBusy = false
let aiTimer = 0
let aiController = null

const aiStats = {
  calls: 0,
  fails: 0,
  last: 0,
  min: Infinity,
  max: 0,
  sum: 0,
  tokens: 0,
}

// 由 vite.config.js 注入；在非打包环境（测试）里不存在，用 typeof 兜住
const JEV_READY =
  typeof __JEV_CONFIGURED__ !== 'undefined' && Boolean(__JEV_CONFIGURED__)

const KEYS = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  w: 'up',
  a: 'left',
  s: 'down',
  d: 'right',
}

/* ==========================================================================
   初始化
   ========================================================================== */

function buildGrid() {
  const frag = document.createDocumentFragment()
  for (let i = 0; i < SIZE * SIZE; i++) {
    const d = document.createElement('div')
    d.className = 'cell'
    frag.appendChild(d)
  }
  $grid.innerHTML = ''
  $grid.appendChild(frag)
}

function newGame() {
  cell = Array.from({ length: SIZE }, () => Array(SIZE).fill(null))
  tiles = new Map()
  uid = 0
  score = 0
  steps = 0
  merges = 0
  history = []
  finished = false
  passed2048 = false
  overlayMode = null

  $tiles.innerHTML = ''
  $overlay.hidden = true

  // 首屏两个方块给个入场动效
  for (const t of [spawn(), spawn()]) {
    if (t && t.el) animate(t.el, 'is-new')
  }

  paintStats()

  // 托管中就把节奏接上，别因为开了新局就停住
  if (aiOn) scheduleAI(220)
}

/* ==========================================================================
   方块
   ========================================================================== */

function makeTile(r, c, value) {
  return { id: ++uid, r, c, value, el: null }
}

/** 让 tile 拥有 DOM，并挂到棋盘上 */
function mount(t) {
  if (t.el) return t.el

  const el = document.createElement('div')
  el.className = 'tile'
  el.dataset.v = t.value
  el.dataset.len = String(t.value).length
  el.dataset.r = t.r
  el.dataset.c = t.c
  el.style.setProperty('--r', t.r)
  el.style.setProperty('--c', t.c)

  const face = document.createElement('div')
  face.className = 'tile-face'

  const num = document.createElement('span')
  num.className = 'tile-num'
  num.textContent = t.value
  face.appendChild(num)
  el.appendChild(face)

  t.el = el
  $tiles.appendChild(el)
  return el
}

/** 把 tile 的位置和外观同步到 DOM */
function syncTile(t) {
  const el = mount(t)
  const v = String(t.value)

  if (el.dataset.v !== v) {
    el.dataset.v = v
    el.dataset.len = String(v.length)
    el.firstElementChild.firstElementChild.textContent = v
  }

  el.dataset.r = t.r
  el.dataset.c = t.c
  el.style.setProperty('--r', t.r)
  el.style.setProperty('--c', t.c)
}

function repaint() {
  for (const t of tiles.values()) syncTile(t)
}

/** 播放一次性动画（先摘类再挂类，保证连续触发也能重放） */
function animate(el, cls) {
  el.classList.remove(cls)
  void el.offsetWidth
  el.classList.add(cls)
  window.setTimeout(() => el.classList.remove(cls), 240)
}

/** 在随机空位生成 2 或 4 */
function spawn() {
  const empty = []
  for (let r = 0; r < SIZE; r++) {
    for (let c = 0; c < SIZE; c++) {
      if (!cell[r][c]) empty.push({ r, c })
    }
  }
  if (empty.length === 0) return null

  const p = empty[(Math.random() * empty.length) | 0]
  const t = makeTile(p.r, p.c, Math.random() < 0.9 ? 2 : 4)
  cell[p.r][p.c] = t
  tiles.set(t.id, t)
  mount(t)
  return t
}

/* ==========================================================================
   移动
   ========================================================================== */

function move(dir) {
  // 遮罩亮着的时候挂起输入（输了就结束了，赢了等玩家点「继续挑战」）
  if (finished || !$overlay.hidden) return false

  const t0 = performance.now()
  const before = snapshot() // 撤销栈要存「移动前」的状态，晚一步就白存了

  let moved = false
  let gained = 0
  let mergeCount = 0
  const popped = [] // 本轮合并出来的方块，用来放弹跳动画

  for (const line of linesFor(dir)) {
    // 1) 先给这条线拍个快照，规则计算只认快照
    const occupants = line.map((p) => cell[p.r][p.c])
    const values = occupants.map((t) => (t ? t.value : null))

    const plan = computeLine(values)
    gained += plan.gained

    // 2) 清空整条线，再按计划落位
    for (const p of line) cell[p.r][p.c] = null

    plan.slots.forEach((slot, k) => {
      const target = line[k]
      const keeper = occupants[slot.from]

      if (slot.mergedWith !== undefined) {
        keeper.value *= 2
        popped.push(keeper)
        mergeCount++
        moved = true

        // 被吞掉的那个：先滑到落点，再淡出
        const victim = occupants[slot.mergedWith]
        tiles.delete(victim.id)
        if (victim.el) {
          victim.el.style.setProperty('--r', target.r)
          victim.el.style.setProperty('--c', target.c)
          victim.el.classList.add('is-ghost')
          window.setTimeout(() => victim.el.remove(), 220)
        }
      }

      if (keeper.r !== target.r || keeper.c !== target.c) moved = true
      keeper.r = target.r
      keeper.c = target.c
      cell[target.r][target.c] = keeper
    })
  }

  if (!moved) return false

  score += gained
  steps++
  merges += mergeCount
  history.push(before)
  if (history.length > 64) history.shift()

  // 先同步已有方块的位置和数值，再放新方块
  repaint()
  for (const t of popped) {
    if (t.el) animate(t.el, 'is-merged')
  }

  const fresh = spawn()
  if (fresh && fresh.el) animate(fresh.el, 'is-new')

  if (score > best) {
    best = score
    localStorage.setItem(BEST_KEY, String(best))
  }

  paintStats(gained)
  checkState()

  $perf.textContent = (performance.now() - t0).toFixed(1)

  return true
}

/* ==========================================================================
   局面判定
   ========================================================================== */

/** 棋盘当前的数值视图，喂给 game.js 的纯函数 */
function boardValues() {
  return cell.map((row) => row.map((t) => (t ? t.value : 0)))
}

function checkState() {
  const values = boardValues()

  if (maxValue(values) >= WIN_VALUE && !passed2048) {
    passed2048 = true
    showOverlay('达成 2048', `当前得分 ${score}`, '继续挑战', 'win')
    return
  }

  if (!hasMove(values)) {
    finished = true
    showOverlay('走不动了', `本局得分 ${score}`, '再来一局', 'lose')
  }
}

function showOverlay(title, desc, btn, mode) {
  overlayMode = mode
  $overlayTitle.textContent = title
  $overlayDesc.textContent = desc
  $overlayBtn.textContent = btn
  $overlay.hidden = false
}

/* ==========================================================================
   撤销
   ========================================================================== */

function snapshot() {
  return {
    tiles: [...tiles.values()].map((t) => ({
      id: t.id,
      r: t.r,
      c: t.c,
      value: t.value,
    })),
    score,
    steps,
    merges,
  }
}

function undo() {
  if (!history.length) return

  const s = history.pop()

  cell = Array.from({ length: SIZE }, () => Array(SIZE).fill(null))
  tiles = new Map()
  $tiles.innerHTML = ''

  for (const d of s.tiles) {
    const t = makeTile(d.r, d.c, d.value)
    t.id = d.id
    cell[d.r][d.c] = t
    tiles.set(t.id, t)
    mount(t)
  }

  score = s.score
  steps = s.steps
  merges = s.merges

  // 悔棋之后局面又有的走了，把结束状态和遮罩一起收回来
  finished = false
  $overlay.hidden = true

  paintStats()
}

/* ==========================================================================
   视图同步
   ========================================================================== */

function paintStats(gained = 0) {
  $score.textContent = score
  $best.textContent = best
  $steps.textContent = steps
  $merges.textContent = merges
  $undo.disabled = history.length === 0

  if (gained > 0) {
    $score.classList.add('bump')
    window.setTimeout(() => $score.classList.remove('bump'), 260)
  }
}

/* ==========================================================================
   交互
   ========================================================================== */

window.addEventListener('keydown', (e) => {
  // 托管期间不接受手动操作，免得和 AI 抢方向盘
  if (aiOn) return

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    undo()
    return
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return

  const dir = KEYS[e.key]
  if (!dir) return
  e.preventDefault()
  move(dir)
})

let drag = null
let dragged = false

$board.addEventListener('pointerdown', (e) => {
  if (aiOn) return
  if (e.pointerType === 'mouse' && e.button !== 0) return
  drag = { x: e.clientX, y: e.clientY }
  dragged = false
  if ($board.setPointerCapture) $board.setPointerCapture(e.pointerId)
})

$board.addEventListener('pointermove', (e) => {
  if (!drag || dragged) return

  const dx = e.clientX - drag.x
  const dy = e.clientY - drag.y
  const ax = Math.abs(dx)
  const ay = Math.abs(dy)
  if (Math.max(ax, ay) < 24) return

  dragged = true
  drag = null
  move(ax > ay ? (dx > 0 ? 'right' : 'left') : dy > 0 ? 'down' : 'up')
})

const endDrag = () => {
  drag = null
  dragged = false
}
$board.addEventListener('pointerup', endDrag)
$board.addEventListener('pointercancel', endDrag)

$newGame.addEventListener('click', newGame)
$undo.addEventListener('click', undo)

$overlayBtn.addEventListener('click', () => {
  if (overlayMode === 'win') {
    $overlay.hidden = true
  } else {
    newGame()
  }
})

/* ==========================================================================
   Jev 托管
   ========================================================================== */

const AI_STEP_DELAY = 110 // 留出移动动画的时间，太快反而看不清

function aiDot(state) {
  $aiDot.className = `ai-dot is-${state}`
}

function paintAi() {
  const s = aiStats
  $mLast.textContent = s.calls ? `${s.last.toFixed(0)} ms` : '—'
  $mAvg.textContent = s.calls ? `${(s.sum / s.calls).toFixed(0)} ms` : '—'
  $mMin.textContent = s.min === Infinity ? '—' : `${s.min.toFixed(0)} ms`
  $mMax.textContent = s.max ? `${s.max.toFixed(0)} ms` : '—'
  $mCalls.textContent = s.calls
  $mTokens.textContent = s.tokens
}

function noteAi(text, isWarn = false) {
  $aiNote.textContent = text
  $aiNote.classList.toggle('is-warn', Boolean(isWarn))
}

function logAi(text) {
  $aiLog.textContent = text
}

function scheduleAI(delay = AI_STEP_DELAY) {
  window.clearTimeout(aiTimer)
  if (!aiOn) return
  aiTimer = window.setTimeout(aiTick, delay)
}

function stopAI(reason, isWarn = true) {
  aiOn = false
  aiBusy = false
  window.clearTimeout(aiTimer)

  if (aiController) {
    aiController.abort()
    aiController = null
  }

  $aiToggle.checked = false
  aiDot('off')
  paintAi()
  noteAi(reason || '已停止。打开开关可以继续让 Jev 托管。', isWarn)
}

function startAI() {
  if (aiOn) return

  if (!hasMove(boardValues())) {
    $aiToggle.checked = false
    noteAi('这个局面已经走不动了，先开新局再托管。', true)
    return
  }

  aiOn = true
  aiStats.min = Infinity
  aiDot('on')
  noteAi(
    JEV_READY
      ? '已连接 Jev（jev-latest），每步的真实耗时记在下面。'
      : '没读到 TYPESAFE_API_KEY，暂时用本地启发式顶着。把 key 写进 .env 再重启 dev server 就能切到 Jev。',
    !JEV_READY
  )
  paintAi()
  scheduleAI(60)
}

async function aiTick() {
  if (!aiOn || aiBusy) return

  // 一局结束就收手：把结果留在屏幕上，不再自动开新局
  if (finished || !$overlay.hidden) {
    const peak = maxValue(boardValues())
    stopAI(
      `本局结束（${peak >= 2048 ? '达成 2048' : '无路可走'}）：${score} 分 · ` +
        `最大方块 ${peak} · 共 ${steps} 步。想再来一局就点「新游戏」。`,
      false
    )
    return
  }

  aiBusy = true
  aiDot('busy')

  let landed = false

  try {
    aiController = new AbortController()

    const result = await decideMove(
      boardValues(),
      { score, steps },
      {
        signal: aiController.signal,
        forceLocal: !JEV_READY,
        // 纯 Jev 托管：每一步都真的问，不用「只有一个方向」这种捷径省调用
        askEveryMove: true,
      }
    )

    aiController = null

    if (!result.dir) {
      stopAI('没有可走的方向了。')
      return
    }

    if (result.source === 'jev') {
      aiStats.calls++
      aiStats.last = result.latency
      aiStats.sum += result.latency
      aiStats.min = Math.min(aiStats.min, result.latency)
      aiStats.max = Math.max(aiStats.max, result.latency)
      aiStats.tokens += result.usage.input_tokens

      const conf =
        typeof result.confidence === 'number'
          ? `${Math.round(result.confidence * 100)}%`
          : '—'
      const risk =
        typeof result.risk === 'number' ? ` · 危险度 ${result.risk.toFixed(1)}` : ''

      logAi(
        `${result.dir} · ${result.latency.toFixed(0)} ms · 置信 ${conf}${risk} · ` +
          `${result.usage.input_tokens} tok · ${result.model}`
      )
      aiDot('on')
    } else if (result.source === 'local') {
      if (JEV_READY) {
        aiStats.fails++
        aiDot('err')
        logAi(`本地兜底（${result.reason}）`)
      } else {
        logAi(`本地启发式 → ${result.dir}`)
        aiDot('on')
      }
    } else {
      logAi(`跳过：${result.reason}`)
      aiDot('on')
    }

    paintAi()
    landed = move(result.dir)
  } catch (err) {
    if (!err || err.name !== 'AbortError') {
      aiDot('err')
      logAi(`出错：${(err && err.message) || err}`)
    }
    return
  } finally {
    aiBusy = false
  }

  if (!landed) {
    stopAI('选中的方向走不动，已经停止托管。')
    return
  }

  scheduleAI()
}

$aiToggle.addEventListener('change', () => {
  if ($aiToggle.checked) startAI()
  else stopAI()
})

/* ==========================================================================
   启动
   ========================================================================== */

buildGrid()
newGame()

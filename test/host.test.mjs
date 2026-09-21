/**
 * 托管行为测试
 *
 * 就验证一件事：托管跑完一局之后，应该【停手并把结果留在屏幕上】，
 * 而不是自动开新局 —— 后者会把刚打完的成绩刷掉。
 *
 * 测试环境里没有注入 __JEV_CONFIGURED__，所以托管走的是本地模式。
 * 但「一局结束就收手」这段控制流跟决策来源无关，照样覆盖得到。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

const runtimeErrors = []
const vc = new VirtualConsole()
vc.on('jsdomError', (e) => runtimeErrors.push(e.message || String(e)))

const dom = new JSDOM(read('index.html'), {
  url: 'http://localhost:5173/',
  virtualConsole: vc,
})
const { window } = dom

globalThis.window = window
globalThis.document = window.document
globalThis.localStorage = window.localStorage

const strip = (src) =>
  src
    .replace(/^\s*import\s+['"][^'"]*\.css['"]\s*;?/gm, '')
    .replace(/^\s*import\s+\{[^}]*\}\s+from\s+['"][^'"]*['"]\s*;?/gm, '')
    .replace(/^export\s+/gm, '')

// 注意：不要拼 snake.js —— 它和 ai.js 都有顶层 ALL_DIRS，会重复声明
new Function(
  ['src/game.js', 'src/jev.js', 'src/ai.js', 'src/main.js'].map((f) => strip(read(f))).join('\n')
)()

let failures = 0
let checks = 0

function ok(cond, msg) {
  checks++
  if (!cond) {
    failures++
    console.log(`  FAIL  ${msg}`)
  }
}

const $ = (id) => window.document.getElementById(id)
const score = () => Number($('score').textContent)
const stepsNow = () => Number($('steps').textContent)
const tileCount = () =>
  window.document.querySelectorAll('#tiles .tile:not(.is-ghost)').length

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitFor(fn, timeoutMs, stepMs = 120) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true
    await sleep(stepMs)
  }
  return false
}

console.log('\n托管行为测试')
console.log('─'.repeat(52))

/* -------------------------------------------------------------------------
   1. 打开托管，它应该自己跑起来
   ------------------------------------------------------------------------- */
{
  const before = score()

  $('ai-toggle').checked = true
  $('ai-toggle').dispatchEvent(new window.Event('change'))

  ok($('ai-toggle').checked, '点击开关后托管应当开启')

  // 给它一点时间走几步
  await waitFor(() => stepsNow() > 3, 20000)

  ok(stepsNow() > 3, `托管开启后应当自动走棋，实际走了 ${stepsNow()} 步`)
  ok(score() >= before, '分数不应回退')
  console.log(`  ✓ 托管启动：自动走了 ${stepsNow()} 步，分数 ${score()}`)
}

/* -------------------------------------------------------------------------
   2. 一局结束后应当自动停手，并保留结果
   ------------------------------------------------------------------------- */
{
  const stopped = await waitFor(() => $('ai-toggle').checked === false, 120000)

  ok(stopped, '一局结束后托管应当自动停止')
  ok(!$('overlay').hidden, '结束后遮罩应当还在，用于展示本局结果')

  const finalScore = score()
  const finalSteps = stepsNow()
  const finalTiles = tileCount()

  console.log(`  ✓ 本局结束：${finalSteps} 步 · ${finalScore} 分 · 场上 ${finalTiles} 个方块`)

  /* -----------------------------------------------------------------------
     3. 停手之后不应该偷偷开新局
     ----------------------------------------------------------------------- */
  await sleep(2500)

  ok(score() === finalScore, `停止后分数被改动了：${finalScore} → ${score()}`)
  ok(stepsNow() === finalSteps, `停止后步数被重置了：${finalSteps} → ${stepsNow()}`)
  ok(tileCount() === finalTiles, '停止后棋盘被重置了，说明又开了新局')
  ok($('ai-toggle').checked === false, '停止后开关应当保持关闭')

  console.log('  ✓ 停止后 2.5 秒内没有自动开新局，成绩完整保留')

  const note = $('ai-note').textContent
  ok(note.includes('本局结束'), `提示语应当说明本局已结束，实际：${note}`)
  console.log(`  ✓ 提示语：${note}`)
}

/* -------------------------------------------------------------------------
   4. 用户主动开新局时，托管不该自己跳回来
   ------------------------------------------------------------------------- */
{
  $('new-game').click()
  await sleep(1500)

  ok(score() === 0, `新局重置后分数应为 0，实际 ${score()}`)
  ok($('ai-toggle').checked === false, '新局后托管应保持关闭状态，等用户再打开')
  console.log('  ✓ 重开后分数归零，托管保持关闭（不自动接管）')
}

ok(runtimeErrors.length === 0, `存在未捕获异常：${runtimeErrors[0] || ''}`)

console.log('\n' + '─'.repeat(52))
console.log(`断言 ${checks} 条，失败 ${failures} 条`)
console.log(failures === 0 ? '结果：全部通过 ✅\n' : '结果：存在失败 ❌\n')

process.exit(failures === 0 ? 0 : 1)

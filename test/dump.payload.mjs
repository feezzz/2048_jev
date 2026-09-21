/**
 * 打印实际发给 Jev 的请求体，用来核对「到底传了什么」。
 *
 * 用法：node test/dump.payload.mjs
 */
import { legalDirs, boardToState, buildQuestions } from '../src/ai.js'

// 挑一个中盘局面，四个方向里有一个走不动，正好能看出 options 是怎么筛的
const board = [
  [2, 0, 0, 4],
  [0, 8, 0, 0],
  [0, 0, 0, 0],
  [0, 0, 16, 0],
]

const legal = legalDirs(board)
const state = boardToState(board, { score: 128, steps: 20 })
const questions = buildQuestions(legal)

console.log('\n===== state（传给模型看的局面）=====\n')
console.log(state)

console.log('\n===== questions（传给模型的问题表）=====\n')
console.log(JSON.stringify(questions, null, 2))

console.log('\n===== 完整的 HTTP 请求体 =====\n')
console.log(
  JSON.stringify({ model: 'jev-latest', state, questions }, null, 2)
)

console.log(`\n合法方向：${legal.join(', ')}`)
console.log(`（另外 ${['up', 'down', 'left', 'right'].filter((d) => !legal.includes(d)).join(', ')} 走不动，已经被排除在选项之外）\n`)

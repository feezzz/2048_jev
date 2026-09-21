/**
 * Jev 客户端（TypeSafe System One）
 *
 * 为什么要走代理而不是直连：
 *   直连 https://api.typesafe.ai 会有 CORS 问题，而且 API key 会暴露在浏览器里。
 *   所以前端只请求同源的 /api/jev，由 Vite dev server 转发到官方端点，
 *   Authorization 头在转发时注入（见 vite.config.js），密钥不进前端产物。
 *
 * 官方规格：
 *   POST https://api.typesafe.ai/v1/systemone
 *   => { model, state, questions }
 *   <= { model, answers, usage: { input_tokens, output_tokens } }
 *   问题类型：choice / score / noul
 */

const ENDPOINT = '/api/jev'

export class JevError extends Error {
  constructor(message, status) {
    super(message)
    this.name = 'JevError'
    this.status = status
  }
}

const STATUS_HINT = {
  // 403 是实测结果：缺 key 时官方返回的就是 403，不是文档写的 401
  401: 'API key 缺失或无效',
  403: 'API key 缺失或无效',
  422: '请求体不合法',
  429: '触发限流',
  529: '服务过载',
}

/**
 * 向 Jev 提问。
 *
 * @param {unknown} state 需要判定的内容，字符串 / 对象 / 数组都可以
 * @param {Record<string, object>} questions 问题表，键是自定义 ID
 * @param {{ model?: string, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ model: string, answers: object, usage: object, latency: number }>}
 *          latency 是这次调用的墙钟耗时（毫秒）
 */
export async function ask(state, questions, opts = {}) {
  const { model = 'jev-latest', signal } = opts

  const t0 = performance.now()
  let res

  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, state, questions }),
      signal,
    })
  } catch (err) {
    if (err && err.name === 'AbortError') throw err
    throw new JevError(`请求发不出去：${(err && err.message) || err}`, 0)
  }

  // 先量时间再解析，把解析开销也算进去，数据更接近用户体感
  const latency = performance.now() - t0
  const text = await res.text()

  if (!res.ok) {
    const hint = STATUS_HINT[res.status]
    throw new JevError(
      `HTTP ${res.status}${hint ? ` · ${hint}` : ''}${text ? ` — ${text.slice(0, 180)}` : ''}`,
      res.status
    )
  }

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    throw new JevError('返回的不是合法 JSON', res.status)
  }

  return {
    model: payload.model || model,
    answers: payload.answers || {},
    usage: payload.usage || { input_tokens: 0, output_tokens: 0 },
    latency,
  }
}

/**
 * 探活：用一个极小的请求确认 key 配好了、代理通了。
 * 返回毫秒耗时；失败则抛出 JevError。
 */
export async function probe(signal) {
  const t0 = performance.now()
  await ask(
    'ok',
    { ping: { type: 'noul', instructions: 'Is this state the literal text "ok"?' } },
    { signal }
  )
  return performance.now() - t0
}

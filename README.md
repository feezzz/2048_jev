# 2048 × Jev

一个纯原生实现的 2048，接入了 [Jev](https://docs.typesafe.ai)（TypeSafe 的 System One 决策模型），每一步都由它看着棋盘决定往哪走，面板实时显示真实延迟。

没有 React / Vue，就是 HTML + CSS + 原生 ESM。Vite 只负责起服务、热更新和打包，不参与运行时。**零运行时依赖，产物 gzip 约 9 kB。**

## 快速开始

```bash
npm install
npm run dev      # 打开 http://127.0.0.1:5173
npm test         # 跑测试，约 2.95 万条断言
npm run build    # 打包到 dist/
```

**不配 Jev 也能玩。** 托开会自动退回本地启发式，面板会说明当前用的是哪一路。方向键 / WASD / 鼠标拖拽 / 手机滑动都能操作。

## 接入 Jev

1. 去 [console.typesafe.ai](https://console.typesafe.ai) 创建一个 API key
2. `cp .env.example .env`，把 key 填进 `TYPESAFE_API_KEY`
3. 重启 dev server

**密钥不会进前端产物。** 前端只请求同源 `/api/jev`，由 Vite dev server 代理转发到 `https://api.typesafe.ai/v1/systemone`，`Authorization` 头在 `proxyReq` 阶段注入（见 `vite.config.js`）。浏览器网络面板和打包产物里都看不到 key。

> 注意：代理是 dev server 提供的，所以 `dist/` 静态托管时 Jev 功能不可用（会退回本地）。要在生产环境用 Jev，把代理那段挪到自己的后端即可。

## 为什么用 choice 题型

Jev 的 `choice` 要求你**事先给出候选集**，它只能从里面挑一个：

```js
{
  direction: {
    type: 'choice',
    instructions: '这是一局 2048。为了让最终分数尽可能高，下一步应该往哪个方向滑动？',
    criteria: { up: '向上滑动', down: '向下滑动', left: '向左滑动', right: '向右滑动' }
  }
}
```

两个好处：

- **只在合法方向里给选项。** 代码先推演出哪几个方向真的走得动，走不动的根本不进 `criteria`。实测 13 局，模型给出非法方向 0 次。
- **返回值保证是你定义过的 ID。** 换成让 LLM 自由输出，就得处理 `north` / `上` / `向上` / `UP` 各种变体。

`state` 里放的是纯文本局面，人也能读：

```
2048 游戏局面，4x4 棋盘，· 表示空格：

    2   ·   ·   4
    ·   8   ·   ·
    ·   ·   ·   ·
    ·   ·  16   ·

当前分数：128
已走步数：20
最大方块：16
剩余空格：12
```

想看真实请求体：`node test/dump.payload.mjs`

## 项目结构

```
index.html            单一页面
src/
  game.js             规则层，纯函数，不碰 DOM
  main.js             渲染与交互层
  ai.js               决策层：棋盘 → 提问、解析答案、本地兜底
  jev.js              Jev 客户端（延迟与 token 统计）
  snake.js            经典评估 + expectimax，用于对照实验
  style.css           简约留白风
test/
  game.test.mjs       规则层单测
  ai.test.mjs         决策层单测（含 mock 各种异常响应）
  ui.test.mjs         jsdom 集成测试
  host.test.mjs       托管行为测试
  bench.*.mjs         延迟基准
  play.*.mjs          对局实验脚本
```

**规则层和渲染层是分开的**：`game.js` 完全不碰 DOM，可以单独跑测试和推演；`main.js` 用 tile 对象持有 DOM 身份，位移交给 CSS 变量 + `transition`，所以移动是合成动画、不触发重排。

## 测试

```bash
npm test
```

| 文件 | 覆盖 | 断言数 |
|---|---|---|
| `game.test.mjs` | 靠拢性、合并顺序、牌面总和守恒、数值合法性 | ~24,500 |
| `ai.test.mjs` | 合法方向判定、401/403/429/断网/非法返回值兜底、请求体格式 | ~2,450 |
| `ui.test.mjs` | 随机 800 步不崩、撤销、重开、指针捕获时机 | ~2,400 |
| `host.test.mjs` | 托管启动、一局结束自动停手、不自动重开 | 19 |

跑测试时踩过的两个坑，都写进了用例：

1. **事件回调里抛的异常不会冒泡**，jsdom 会静默吞掉，测试全绿但游戏是坏的。必须用 `VirtualConsole` 监听 `jsdomError` 并计入断言。
2. **`element.click()` 测不出「按钮点不动」**。它直接派发 click、绕开 `pointerdown`/`pointerup` 整条序列。涉及指针的交互必须走完整序列。

## 实测数据

### 延迟（30 次真实请求，走 dev server 代理）

| 指标 | 值 |
|---|---|
| 最快 / 中位 / 平均 | 693 / 759 / 784 ms |
| P95 / 最慢 | 932 / 1034 ms |
| 方向合法率 | **100%** |
| 输入 token | 均 578 / 次 |

官方标称约 100ms，实测 784ms。**差在网络上，不在模型上**：

- 问题数从 1 个加到 3 个，耗时变化 **−0.9%**（噪声内），token 只多 107
- 8 个请求并发，墙上时间 766ms —— 和单次差不多，服务端不排队
- 到 `api.typesafe.ai` 的网络分段：TCP 握手 2ms，但 TLS 完成 430–520ms，首字节 870–1000ms

结论：那 700 多毫秒几乎全是跨太平洋往返。部署到离 API 近的机器上应该能接近官方数字。

复现：`node test/bench.jev.mjs 30`、`node test/bench.compare.mjs 10`

### 它能打到 2048 吗？不能

五组独立对照实验：

| 方案 | 局数 | 平均分数 | 最好成绩 | 通关率 |
|---|---|---|---|---|
| Jev · 开放式提问 | 5 | 2,850 | 512 | 0% |
| Jev · 逐方向打分 | 4 | 2,238 | 256 | 0% |
| Jev · 加阵型策略提示 | 4 | 3,417 | 512 | 0% |
| 弱启发式（对照） | 20 | 9,089 | 1024 | 0% |
| 经典策略 + 前瞻（对照） | 5 | **22,216** | **4096** | **40%** |

三点结论：

1. **换问法没用。** 换成官方推荐的「原子问题 + 代码加总」反而更差。瓶颈不在怎么问。
2. **Jev 懂规则，但不会规划。** 方向合法率始终 100%，它完全读得懂棋盘，缺的是「这一步要为 20 步之后布局」的能力。
3. **它打不过几行规则代码。** 一个只用「空格数 + 单调性 + 相邻同值」的弱启发式就能稳定到 1024。

**Jev 是快速局部判断器件（分类 / 评分 / 路由），不是策略引擎。** 让它替代策略规划是方向性错误。真要通关，得让代码承担策略（`src/snake.js` 那套经典评估 + expectimax，本地一局 0.5 秒）。

复现：

```bash
node test/play.local.mjs 20 4000        # 弱启发式对照
node test/play.snake.mjs 20 6000 3      # 经典策略对照
node test/play.jev.mjs 600              # 纯 Jev（需要配 key，很慢）
```

## 已知限制

- Jev 代理只存在于 dev server，静态托管时该功能不可用
- 一局纯 Jev 对局约需 100–600 次调用、十几分钟，注意额度
- 移动端滑动阈值固定 24px，没有做成可配置

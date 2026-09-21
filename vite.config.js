import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // 只从环境变量读，不落进代码
  const env = loadEnv(mode, process.cwd(), '')
  const apiKey = env.TYPESAFE_API_KEY || process.env.TYPESAFE_API_KEY || ''

  return {
    base: './',

    // 让前端知道 key 配没配，好给出准确提示（值为布尔，不泄露密钥）
    define: {
      __JEV_CONFIGURED__: JSON.stringify(Boolean(apiKey)),
    },

    server: {
      port: 5173,
      open: false,
      host: '127.0.0.1',

      proxy: {
        // 浏览器 -> /api/jev -> https://api.typesafe.ai/v1/systemone
        // 绕开 CORS，同时在转发时注入 Authorization，密钥不进前端产物
        '/api/jev': {
          target: 'https://api.typesafe.ai',
          changeOrigin: true,
          secure: true,
          rewrite: (p) => p.replace(/^\/api\/jev/, '/v1/systemone'),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (apiKey) {
                proxyReq.setHeader('Authorization', `Bearer ${apiKey}`)
              }
            })
          },
        },
      },
    },

    build: {
      target: 'es2020',
      cssMinify: true,
      reportCompressedSize: true,
    },
  }
})

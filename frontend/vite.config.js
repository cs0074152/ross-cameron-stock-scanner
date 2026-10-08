import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react(), {
    name: 'scanner-launcher-identity',
    configureServer(server) {
      server.middlewares.use('/__scanner_launcher__', (req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(JSON.stringify({ service: 'ross-cameron-stock-scanner-frontend',
          launchId: process.env.SCANNER_LAUNCH_ID || null }))
      })
    }
  }],
  server: {
    port: 5173
  }
})

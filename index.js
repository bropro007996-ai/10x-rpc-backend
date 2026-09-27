// 10X RPC — Lightweight 24/7 Backend Server (Standalone)
// Runs as a long-lived process on Render/Railway/VPS/Docker.
// Uses tsx to load the TypeScript daemon code directly (no build step needed).
require('dotenv').config()
const { execSync } = require('child_process')
const http = require('http')
const https = require('https')
const crypto = require('crypto')

// Register tsx require hook so we can import .ts files directly
require('tsx/cjs')

const PORT = process.env.SERVER_PORT || process.env.PORT || 3000
const MS_PER_DAY = 24 * 60 * 60 * 1000

console.log('====================================================')
console.log('   10X RPC — 24/7 Backend Server')
console.log('   Endpoints: /health, /sync-user, /stop-rpc, /auth/callback')
console.log('====================================================')

// Fallback DATABASE_URL_UNPOOLED → DATABASE_URL (for prisma db push)
if (!process.env.DATABASE_URL_UNPOOLED && process.env.DATABASE_URL) {
  process.env.DATABASE_URL_UNPOOLED = process.env.DATABASE_URL
}

// === Session helpers ===
const SESSION_SECRET = process.env.SESSION_SECRET || '10x-rpc-dev-secret-change-me-in-production-32bytes-min'
function sign(payload) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(payload).digest('base64url')
}

// === In-process daemon ===
let daemonInstance = null
async function getDaemon() {
  if (!daemonInstance) {
    const { getRpcDaemon } = require('./src/lib/rpc-daemon')
    daemonInstance = getRpcDaemon()
    await daemonInstance.start()
    console.log('[10X RPC Server] 24/7 daemon started in-process')
  }
  return daemonInstance
}

// === HTTP server ===
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`)
  const path = url.pathname

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return }

  // === /health ===
  if (path === '/health' || path === '/') {
    try {
      const d = daemonInstance
      const status = d ? (d.getStatus ? d.getStatus() : {}) : {}
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        status: 'ok',
        service: '10x-rpc-backend',
        uptime: Math.floor(process.uptime()),
        timestamp: new Date().toISOString(),
        daemon: {
          running: !!d,
          uptimeSeconds: Math.floor(process.uptime()),
          activeConnections: status.activeConnections || 0,
          totalTrackedUsers: status.totalTrackedUsers || 0,
        }
      }))
    } catch (e) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'ok', uptime: Math.floor(process.uptime()), daemon: { running: false } }))
    }
    return
  }

  // === POST /sync-user?userId=xxx ===
  if (path === '/sync-user' && req.method === 'POST') {
    try {
      const userId = url.searchParams.get('userId')
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'missing userId param' }))
        return
      }
      const d = await getDaemon()
      const result = await d.syncUser(userId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: result.ok, method: result.method, message: result.message }))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: e.message }))
    }
    return
  }

  // === POST /stop-rpc?userId=xxx ===
  if (path === '/stop-rpc' && req.method === 'POST') {
    try {
      const userId = url.searchParams.get('userId')
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'missing userId param' }))
        return
      }
      const d = await getDaemon()
      await d.stopUserRpc(userId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, message: 'RPC stopped & cleared from Discord' }))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: e.message }))
    }
    return
  }

  // === POST /force-push?userId=xxx ===
  if (path === '/force-push' && req.method === 'POST') {
    try {
      const userId = url.searchParams.get('userId')
      if (!userId) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: false, error: 'missing userId' }))
        return
      }
      const d = await getDaemon()
      try { d.disconnectUser(userId) } catch {}
      await new Promise(r => setTimeout(r, 1000))
      const result = await d.syncUser(userId)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: result.ok, method: result.method, message: result.message }))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message }))
    }
    return
  }

  // === GET /auth/callback — Discord OAuth callback ===
  if (path === '/auth/callback' && req.method === 'GET') {
    try {
      const code = url.searchParams.get('code')
      const state = url.searchParams.get('state')
      const error = url.searchParams.get('error')
      const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'

      if (error) {
        res.writeHead(302, { Location: `${APP_URL}/?error=${encodeURIComponent(error)}` })
        res.end()
        return
      }
      if (!code || !state) {
        res.writeHead(302, { Location: `${APP_URL}/?error=missing_code` })
        res.end()
        return
      }

      const { PrismaClient } = require('@prisma/client')
      const db = new PrismaClient()

      // Look up PKCE verifier
      const oauthState = await db.oAuthState.findUnique({ where: { state } })
      if (!oauthState) {
        await db.$disconnect()
        res.writeHead(302, { Location: `${APP_URL}/?error=invalid_state` })
        res.end()
        return
      }
      if (oauthState.expiresAt < new Date()) {
        await db.oAuthState.delete({ where: { id: oauthState.id } }).catch(() => {})
        await db.$disconnect()
        res.writeHead(302, { Location: `${APP_URL}/?error=state_expired` })
        res.end()
        return
      }

      const verifier = oauthState.verifier
      await db.oAuthState.delete({ where: { id: oauthState.id } }).catch(() => {})

      // Exchange code for tokens
      const { exchangeCode, fetchDiscordUser } = require('./src/lib/discord-oauth')
      const redirectUri = process.env.DISCORD_REDIRECT_URI
      const tokens = await exchangeCode(code, verifier, redirectUri)
      const discordUser = await fetchDiscordUser(tokens.access_token)

      // Upsert user
      const user = await db.user.upsert({
        where: { discordId: discordUser.id },
        create: {
          discordId: discordUser.id,
          username: discordUser.username,
          discriminator: discordUser.discriminator,
          avatar: discordUser.avatar,
        },
        update: {
          username: discordUser.username,
          discriminator: discordUser.discriminator,
          avatar: discordUser.avatar,
        },
      })

      // Create trial if not present
      const existingTrial = await db.trial.findUnique({ where: { userId: user.id } })
      if (!existingTrial) {
        await db.trial.create({
          data: {
            userId: user.id,
            startsAt: new Date(),
            endsAt: new Date(Date.now() + 30 * MS_PER_DAY),
          },
        })
      }

      // Create default GlobalConfig
      const existingConfig = await db.globalConfig.findUnique({ where: { userId: user.id } })
      if (!existingConfig) {
        await db.globalConfig.create({ data: { userId: user.id } })
      }

      // Create session
      const raw = `${user.id}.${Date.now()}.${crypto.randomBytes(16).toString('hex')}`
      const sig = sign(raw)
      const sessionToken = `${raw}.${sig}`

      await db.session.create({
        data: {
          userId: user.id,
          token: sessionToken,
          expiresAt: new Date(Date.now() + 7 * MS_PER_DAY),
          discordAccessToken: tokens.access_token,
          discordRefreshToken: tokens.refresh_token,
          discordTokenExpiresAt: new Date(Date.now() + (tokens.expires_in || 604800) * 1000),
        },
      })

      await db.$disconnect()

      // Redirect to frontend with token
      res.writeHead(302, { Location: `${APP_URL}/set-session?token=${encodeURIComponent(sessionToken)}` })
      res.end()
    } catch (e) {
      console.error('[Auth] Callback error:', e.message)
      const APP_URL = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
      res.writeHead(302, { Location: `${APP_URL}/?error=${encodeURIComponent(e.message)}` })
      res.end()
    }
    return
  }

  // === GET /test-ws — test Discord gateway connectivity ===
  if (path === '/test-ws') {
    try {
      const WebSocket = require('ws')
      const gatewayUrl = process.env.DISCORD_GATEWAY_URL || 'wss://gateway.discord.gg/?v=10&encoding=json'
      const ws = new WebSocket(gatewayUrl)
      let result = { gatewayUrl, steps: [] }

      const timeout = setTimeout(() => {
        result.steps.push({ step: 'timeout', message: 'No HELLO within 10s' })
        try { ws.close() } catch {}
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result, null, 2))
      }, 10000)

      ws.on('open', () => { result.steps.push({ step: 'open', ok: true }) })
      ws.on('message', (data) => {
        try {
          const pl = JSON.parse(data.toString())
          if (pl.op === 10) {
            clearTimeout(timeout)
            result.steps.push({ step: 'HELLO', ok: true, heartbeat_interval: pl.d.heartbeat_interval })
            result.success = true
            try { ws.close() } catch {}
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(result, null, 2))
          }
        } catch {}
      })
      ws.on('error', (err) => {
        clearTimeout(timeout)
        result.steps.push({ step: 'error', message: err.message })
        result.success = false
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(result, null, 2))
      })
      return
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: e.message }))
    }
  }

  // === 404 ===
  res.writeHead(404, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'not_found', path }))
})

// === Start server ===
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[10X RPC Server] HTTP listening on 0.0.0.0:${PORT}`)
  console.log(`[10X RPC Server] Health: http://localhost:${PORT}/health`)
  console.log(`[10X RPC Server] DATABASE_URL: ${process.env.DATABASE_URL ? 'SET' : 'NOT SET'}`)
  console.log(`[10X RPC Server] DISCORD_CLIENT_ID: ${process.env.DISCORD_CLIENT_ID ? 'SET' : 'NOT SET'}`)
})

// === Generate Prisma Client on first start (if not already generated) ===
console.log('[10X RPC Server] Ensuring Prisma Client is generated...')
try {
  execSync('npx prisma generate', { stdio: 'pipe' })
  console.log('[10X RPC Server] Prisma Client ready.')
} catch (err) {
  console.warn('[10X RPC Server] Prisma generate warning:', err.message?.substring(0, 100))
}

// === Start the 24/7 RPC daemon ===
console.log('[10X RPC Server] Starting 24/7 Discord RPC & Status Daemon...')
getDaemon().catch(err => {
  console.error('[10X RPC Server] Daemon failed to start:', err.message)
})

// === Keep-alive pinger (pings Vercel frontend every 4 min) ===
const KEEPALIVE_URL = process.env.NEXT_PUBLIC_APP_URL
  ? process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '') + '/api/keep-awake'
  : null

if (KEEPALIVE_URL) {
  console.log(`[10X RPC KeepAlive] Pinging ${KEEPALIVE_URL} every 4 min`)
  function pingKeepAlive() {
    const r = https.get(KEEPALIVE_URL, { timeout: 15000 }, (resp) => {
      let body = ''
      resp.on('data', (chunk) => { body += chunk })
      resp.on('end', () => {
        try {
          const data = JSON.parse(body)
          console.log(`[10X RPC KeepAlive] OK -> db:${data?.results?.database?.ms || '?'}ms`)
        } catch {
          console.log(`[10X RPC KeepAlive] OK -> HTTP ${resp.statusCode}`)
        }
      })
    })
    r.on('error', (err) => console.warn(`[10X RPC KeepAlive] FAIL ${err.message}`))
    r.on('timeout', () => { r.destroy(); console.warn('[10X RPC KeepAlive] FAIL timeout') })
  }
  setTimeout(pingKeepAlive, 10000)
  setInterval(pingKeepAlive, 4 * 60 * 1000)
}

// === Graceful shutdown ===
process.on('SIGINT', () => {
  console.log('[10X RPC Server] SIGINT received. Shutting down...')
  server.close()
  process.exit(0)
})
process.on('SIGTERM', () => {
  console.log('[10X RPC Server] SIGTERM received. Shutting down...')
  server.close()
  process.exit(0)
})

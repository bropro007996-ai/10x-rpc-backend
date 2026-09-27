// 10X RPC — Central configuration
// All secrets come from environment variables in production.

export const CONFIG = {
  discord: {
    clientId: process.env.DISCORD_CLIENT_ID || '',
    clientSecret: process.env.DISCORD_CLIENT_SECRET || '',
    botToken: process.env.DISCORD_BOT_TOKEN || '',
    // The redirect_uri MUST point to the Render backend (where /auth/callback runs).
    // This must match what's registered in Discord Developer Portal.
    redirectUri: process.env.DISCORD_REDIRECT_URI || 'http://localhost:3000/auth/callback',
    // Gaming SDK scope — required for the Gaming SDK gateway connection.
    scope: process.env.DISCORD_OAUTH_SCOPE || 'openid identify sdk.social_layer_presence',
    authorizeUrl: 'https://discord.com/api/oauth2/authorize',
    tokenUrl: 'https://discord.com/api/oauth2/token',
    apiBase: 'https://discord.com/api/v9',
    // Main Discord gateway — supports app assets (large_image) for user OAuth tokens.
    // The Gaming SDK gateway (gateway.gaming-sdk.com) does NOT support custom images.
    gatewayUrl: process.env.DISCORD_GATEWAY_URL || 'wss://gateway.discord.gg/?v=10&encoding=json',
    serverId: process.env.DISCORD_SERVER_ID || '1549302358926823496',
    inviteUrl: process.env.DISCORD_INVITE_URL || 'https://discord.gg/JjsPqbWnrH',
  },
  app: {
    name: '10X RPC',
    tagline: 'Premium Discord Rich Presence',
    // app.url = where the user's browser is. After OAuth callback, redirect here.
    // On Render: set NEXT_PUBLIC_APP_URL to the Vercel frontend URL (so callback redirects to Vercel).
    // On Vercel: NEXT_PUBLIC_APP_URL = the Vercel URL itself (default).
    url: process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000',
    trialDays: 30,
  },
  weather: {
    geocodeUrl: 'https://geocoding-api.open-meteo.com/v1/search',
    forecastUrl: 'https://api.open-meteo.com/v1/forecast',
  },
  // Render backend (24/7 daemon) — used by /uptime to health-check the daemon.
  // Set RENDER_BACKEND_URL in production; empty/absent = daemon not deployed.
  render: {
    backendUrl: process.env.RENDER_BACKEND_URL || 'https://one0x-rpc-backend-sg.onrender.com',
    healthPath: '/health',
  },
  session: {
    cookieName: '10x_rpc_session',
    ttlDays: 7,
    secret: process.env.SESSION_SECRET || '10x-rpc-dev-secret-change-me-in-production-32bytes-min',
  },
  admin: {
    // Discord user IDs that have admin access
    discordIds: ['824940038617694279', '1526539220586467351'],
  },
}

export type AppConfig = typeof CONFIG

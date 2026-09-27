# 10X RPC Backend Server

Standalone 24/7 backend daemon for 10X RPC. Maintains persistent Discord Gateway WebSocket connections, handles OAuth callback, and syncs/stops user RPC.

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Copy env file and fill in values
cp .env.example .env

# 3. Push schema to database (first time only)
npx prisma db push --accept-data-loss

# 4. Start the server
npm start
```

Server starts on `http://localhost:3000`.

## Deploy to Render

1. **Create a new GitHub repo** with these files
2. Go to [Render Dashboard](https://dashboard.render.com) → New → Web Service
3. Connect your GitHub repo
4. Settings:
   - **Name**: `10x-rpc-backend`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `node index.js`
   - **Health Check Path**: `/health`
5. Add environment variables (from `.env.example`):
   - `DATABASE_URL` — Neon Postgres pooled URL
   - `DATABASE_URL_UNPOOLED` — Neon Postgres direct URL
   - `DISCORD_CLIENT_ID`
   - `DISCORD_CLIENT_SECRET`
   - `DISCORD_BOT_TOKEN`
   - `DISCORD_REDIRECT_URI` — `https://your-app.onrender.com/auth/callback`
   - `SESSION_SECRET`
   - `NEXT_PUBLIC_APP_URL` — `https://www.10xrpc.shop`
6. Deploy

## Deploy to Railway

1. Go to [Railway](https://railway.app) → New Project → Deploy from GitHub
2. Connect your repo
3. Railway auto-detects Node.js
4. Add the same environment variables
5. Set `DISCORD_REDIRECT_URI` to `https://your-app.up.railway.app/auth/callback`
6. Deploy

## Deploy to VPS (PM2)

```bash
# Upload files to your VPS
scp -r backend-server/ user@your-vps:/app/

# SSH in
ssh user@your-vps
cd /app/backend-server

# Install + generate
npm install
npx prisma db push --accept-data-loss

# Start with PM2 (keeps running 24/7 + auto-restart)
npm install -g pm2
pm2 start index.js --name "10x-rpc-backend"
pm2 save
pm2 startup
```

## Deploy with Docker

```bash
docker build -t 10x-rpc-backend .
docker run -d --name 10x-rpc-backend -p 3000:3000 \
  --env-file .env 10x-rpc-backend
```

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check (used by uptime monitors) |
| POST | `/sync-user?userId=xxx` | Sync a user's presence to Discord |
| POST | `/stop-rpc?userId=xxx` | Stop a user's RPC |
| POST | `/force-push?userId=xxx` | Force reconnect + push presence |
| GET | `/auth/callback` | Discord OAuth callback |
| GET | `/test-ws` | Test Discord Gateway connectivity |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | ✅ | Neon Postgres pooled connection string |
| `DATABASE_URL_UNPOOLED` | ✅ | Neon Postgres direct connection (for migrations) |
| `DISCORD_CLIENT_ID` | ✅ | Discord app client ID |
| `DISCORD_CLIENT_SECRET` | ✅ | Discord app client secret |
| `DISCORD_BOT_TOKEN` | ✅ | Discord bot token |
| `DISCORD_REDIRECT_URI` | ✅ | OAuth callback URL (`https://your-backend/auth/callback`) |
| `SESSION_SECRET` | ✅ | Random 32+ char secret (`openssl rand -hex 32`) |
| `NEXT_PUBLIC_APP_URL` | ✅ | Frontend URL (`https://www.10xrpc.shop`) |
| `PORT` | Auto | Server port (Render/Railway auto-set) |

## After Deploying

1. **Update Discord Developer Portal**:
   - Go to https://discord.com/developers/applications/1549299168562905148/oauth2
   - Add redirect URI: `https://your-backend-url/auth/callback`

2. **Update Vercel frontend**:
   - Set `RENDER_BACKEND_URL` env var to your new backend URL
   - Or update `src/lib/config.ts` in the frontend repo

3. **Test**:
   - `https://your-backend-url/health` → `{"status":"ok"}`
   - `https://your-backend-url/test-ws` → should show `HELLO` from Discord Gateway
   - Login on `www.10xrpc.shop` → toggle RPC → should push presence to Discord

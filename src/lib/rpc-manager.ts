// 10X RPC — Real Discord RPC Manager
// Connects to Discord's Gaming SDK gateway, identifies with the user's OAuth token,
// and sends PRESENCE_UPDATE (op-3) to set the user's rich presence activity and custom status.

import WebSocket from 'ws'
import { CONFIG } from './config'
import type { RpcConfig } from './api-client'
import type { PlaceholderContext } from './placeholders'
import { resolvePlaceholders } from './placeholders'
import { resolveRpcActivityName } from './constants'
import { resolveImageToAssetKey } from './discord-assets'

/**
 * Convert an image reference to Discord's expected format.
 *
 * Discord's `large_image` / `small_image` fields accept:
 *   1. A Discord asset key (uploaded via Developer Portal) — returned as-is
 *   2. `mp:external/<base64url>` for external images — HTTPS URLs are encoded
 *   3. If omitted entirely, Discord shows the app's default icon based on application_id
 *
 * Raw HTTPS URLs are NOT accepted — Discord silently drops them, causing the image
 * to not appear. This helper converts HTTPS URLs to the mp:external format.
 */
function toDiscordImage(image: string | null | undefined): string | null {
  if (!image) return null
  const trimmed = image.trim()
  if (!trimmed) return null
  // Already a Discord asset key or mp:external format
  if (trimmed.startsWith('mp:') || trimmed.startsWith('spotify:')) return trimmed
  // HTTPS URL → convert to mp:external/<base64url>
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const b64 = Buffer.from(trimmed).toString('base64url')
      return `mp:external/${b64}`
    } catch {
      return null
    }
  }
  // Otherwise it's a Discord asset key — return as-is
  return trimmed
}

// Activity types mapped to Discord's numeric values
export const ACTIVITY_TYPE_MAP: Record<string, number> = {
  PLAYING: 0,
  STREAMING: 1,
  LISTENING: 2,
  WATCHING: 3,
  CUSTOM: 4,
  COMPETING: 5,
}

export interface PresenceResult {
  ok: boolean
  method: 'gateway' | 'rest' | 'none'
  message: string
  activities?: object[]
  activity?: object
}

/**
 * Build a Discord activity payload from the user's RPC config.
 * Resolves dynamic placeholders in state/details using the placeholder engine.
 */
export async function buildActivityPayload(
  cfg: RpcConfig,
  placeholderCtx: PlaceholderContext,
  applicationIdOverride?: string
): Promise<object> {
  const state = await resolvePlaceholders(cfg.state || '', placeholderCtx)
  const details = await resolvePlaceholders(cfg.details || '', placeholderCtx)
  const type = ACTIVITY_TYPE_MAP[cfg.type || 'PLAYING'] ?? 0
  const activityName = resolveRpcActivityName(cfg.name, cfg.platform)

  const activity: Record<string, unknown> = {
    type,
    name: activityName,
  }

  if (state) activity.state = state
  if (details) activity.details = details

  // URLs
  if ((cfg as any).url) activity.url = (cfg as any).url

  // Timestamps — Discord Gateway OP 3 expects Unix time in MILLISECONDS (not seconds)
  const now = Date.now()
  const rawUpdated = (cfg as any).updatedAt
  const baseTime = rawUpdated
    ? new Date(rawUpdated).getTime()
    : (placeholderCtx?.rpcStartedAt && !isNaN(placeholderCtx.rpcStartedAt) ? placeholderCtx.rpcStartedAt : now)
  const safeBase = (!isNaN(baseTime) && baseTime <= now) ? Math.floor(baseTime) : now

  if (cfg.startMinsAgo != null && cfg.startMinsAgo >= 0) {
    const startMs = Math.floor(safeBase - (cfg.startMinsAgo * 60 * 1000))
    activity.timestamps = {
      start: startMs,
    }
  }
  if (cfg.endTotalMins != null && cfg.endTotalMins > 0) {
    const startMs = (activity.timestamps as any)?.start ?? Math.floor(safeBase - ((cfg.startMinsAgo || 0) * 60 * 1000))
    const endMs = Math.floor(startMs + (cfg.endTotalMins * 60 * 1000))
    if (endMs > now) {
      activity.timestamps = {
        ...(activity.timestamps as object),
        end: endMs,
      }
    }
  }

  // Party
  if (cfg.partyMax != null && cfg.partyMax > 0) {
    const party: Record<string, unknown> = {
      size: [cfg.partyCurrent ?? 0, cfg.partyMax],
    }
    if (cfg.partyId) party.id = cfg.partyId
    if (cfg.partySecret) party.join = cfg.partySecret
    activity.party = party
  }

  // Assets (images) — upload custom images to Discord app as assets (returns asset key)
  // Raw HTTPS URLs and mp:external/ do NOT work on the Gaming SDK gateway — the image
  // is silently dropped. We upload the image via the bot token and use the asset key.
  const assets: Record<string, string> = {}
  const largeImg = await resolveImageToAssetKey(cfg.largeImage)
  if (largeImg) assets.large_image = largeImg
  if (cfg.largeText) assets.large_text = cfg.largeText
  const smallImg = await resolveImageToAssetKey(cfg.smallImage)
  if (smallImg) assets.small_image = smallImg
  if (cfg.smallText) assets.small_text = cfg.smallText
  if (Object.keys(assets).length > 0) activity.assets = assets

  // Buttons — CORRECT Discord format per the Rich Presence SDK:
  //   `buttons`: array of STRINGS (label names), NOT objects
  //   `metadata.button_urls`: array of URL strings (parallel to buttons)
  //
  // Previous bug: we sent `buttons: [{label, url}]` (objects) — Discord validates
  // the format and silently drops the ENTIRE activity when buttons contains objects
  // instead of strings. The correct format is:
  //   buttons: ["Join", "Website"]
  //   metadata: { button_urls: ["https://...", "https://..."] }
  const buttonLabels: string[] = []
  const buttonUrls: string[] = []
  const b1Label = (cfg.button1Label || '').trim()
  const b1Url = (cfg.button1Url || '').trim()
  const b2Label = (cfg.button2Label || '').trim()
  const b2Url = (cfg.button2Url || '').trim()
  if (b1Label && b1Url && /^https?:\/\//i.test(b1Url)) {
    buttonLabels.push(b1Label)
    buttonUrls.push(b1Url)
  }
  if (b2Label && b2Url && /^https?:\/\//i.test(b2Url)) {
    buttonLabels.push(b2Label)
    buttonUrls.push(b2Url)
  }
  if (buttonLabels.length > 0) {
    activity.buttons = buttonLabels        // array of STRINGS (labels)
    activity.metadata = { button_urls: buttonUrls }  // array of URL strings
  }

  // Platform — send-side field for headless/embedded sessions
  if (cfg.platform) activity.platform = cfg.platform

  // Application ID — required for Discord to accept the activity.
  // Normal RPC uses CONFIG.discord.clientId (the OAuth app).
  // Games RPC overrides this with a real game's app_id (spoofing).
  activity.application_id = applicationIdOverride || CONFIG.discord.clientId

  return activity
}

/**
 * Build a Games RPC activity payload.
 * Uses the game's real Discord app_id as application_id — this is what makes
 * Discord display the game's official icon and name (spoofing).
 *
 * SEPARATE from buildActivityPayload (Normal RPC) — different application_id,
 * different config source (GameRpcConfig vs RpcConfig), never shared.
 */
export async function buildGameActivityPayload(
  cfg: {
    gameSlug: string
    name: string
    appId: string
    img: string
    state?: string | null
    details?: string | null
    largeImage?: string | null
    largeText?: string | null
    smallImage?: string | null
    smallText?: string | null
    button1Label?: string | null
    button1Url?: string | null
    button2Label?: string | null
    button2Url?: string | null
    partyCurrent?: number | null
    partyMax?: number | null
    startMinsAgo?: number
    endTotalMins?: number | null
    updatedAt?: string | Date
  },
  placeholderCtx: PlaceholderContext
): Promise<Record<string, unknown>> {
  const state = await resolvePlaceholders(cfg.state || '', placeholderCtx)
  const details = await resolvePlaceholders(cfg.details || '', placeholderCtx)

  const activity: Record<string, unknown> = {
    type: 0, // PLAYING
    name: cfg.name,
  }

  if (state) activity.state = state
  if (details) activity.details = details

  // Timestamps
  const now = Date.now()
  const rawUpdated = cfg.updatedAt
  const baseTime = rawUpdated
    ? new Date(rawUpdated as string).getTime()
    : (placeholderCtx?.rpcStartedAt && !isNaN(placeholderCtx.rpcStartedAt) ? placeholderCtx.rpcStartedAt : now)
  const safeBase = (!isNaN(baseTime) && baseTime <= now) ? Math.floor(baseTime) : now

  if (cfg.startMinsAgo != null && cfg.startMinsAgo >= 0) {
    const startMs = Math.floor(safeBase - (cfg.startMinsAgo * 60 * 1000))
    activity.timestamps = { start: startMs }
  }
  if (cfg.endTotalMins != null && cfg.endTotalMins > 0) {
    const startMs = (activity.timestamps as any)?.start ?? Math.floor(safeBase - ((cfg.startMinsAgo || 0) * 60 * 1000))
    const endMs = Math.floor(startMs + (cfg.endTotalMins * 60 * 1000))
    if (endMs > now) {
      activity.timestamps = { ...(activity.timestamps as object), end: endMs }
    }
  }

  // Party
  if (cfg.partyMax != null && cfg.partyMax > 0) {
    const party: Record<string, unknown> = { size: [cfg.partyCurrent ?? 0, cfg.partyMax] }
    activity.party = party
  }

  // Assets
  // For spoofed games (application_id = game's app_id), if no custom image is provided,
  // OMIT large_image entirely — Discord shows the game's official icon via application_id.
  // If a custom image IS provided, upload it as a Discord app asset (returns key) —
  // raw HTTPS URLs and mp:external/ do NOT work on the Gaming SDK gateway.
  const assets: Record<string, string> = {}
  if (cfg.largeImage) {
    const largeKey = await resolveImageToAssetKey(cfg.largeImage)
    if (largeKey) assets.large_image = largeKey
  }
  if (cfg.largeText) assets.large_text = cfg.largeText
  else if (cfg.name) assets.large_text = cfg.name
  if (cfg.smallImage) {
    const smallKey = await resolveImageToAssetKey(cfg.smallImage)
    if (smallKey) assets.small_image = smallKey
  }
  if (cfg.smallText) assets.small_text = cfg.smallText
  if (Object.keys(assets).length > 0) activity.assets = assets

  // Buttons — CORRECT Discord format (same as Normal RPC).
  // buttons = array of STRINGS (labels), metadata.button_urls = array of URL strings.
  const gButtonLabels: string[] = []
  const gButtonUrls: string[] = []
  const gb1Label = (cfg.button1Label || '').trim()
  const gb1Url = (cfg.button1Url || '').trim()
  const gb2Label = (cfg.button2Label || '').trim()
  const gb2Url = (cfg.button2Url || '').trim()
  if (gb1Label && gb1Url && /^https?:\/\//i.test(gb1Url)) { gButtonLabels.push(gb1Label); gButtonUrls.push(gb1Url) }
  if (gb2Label && gb2Url && /^https?:\/\//i.test(gb2Url)) { gButtonLabels.push(gb2Label); gButtonUrls.push(gb2Url) }
  if (gButtonLabels.length > 0) {
    activity.buttons = gButtonLabels
    activity.metadata = { button_urls: gButtonUrls }
  }

  // CRITICAL: application_id = the game's real Discord app_id (spoofing)
  activity.application_id = cfg.appId

  return activity
}

/**
 * Build Discord custom status activity payload (Activity Type 4).
 */
export function buildCustomStatusActivity(
  text: string | null,
  emoji: string | null
): Record<string, unknown> | null {
  if (!text && !emoji) return null
  const activity: Record<string, unknown> = {
    type: 4, // CUSTOM
    name: 'Custom Status',
  }
  if (text) activity.state = text
  if (emoji) {
    activity.emoji = {
      name: emoji,
    }
  }
  return activity
}

/**
 * Build the full activities array for Discord Gateway OP 3.
 * Supports:
 *   - Custom Status (type 4) — if statusEnabled
 *   - Games RPC activity (type 0, game's app_id) — if gamesRpcEnabled (PRIORITY over normal RPC)
 *   - Normal RPC activity (type 0, OAuth client_id) — if rpcEnabled and gamesRpc NOT active
 *
 * Games RPC and Normal RPC are NEVER both pushed simultaneously — Discord only shows
 * one type-0 activity. Games RPC takes priority (more specific). Both have independent
 * enable flags in the DB; the daemon picks which to display.
 */
export async function buildPresenceActivities(options: {
  rpcConfig?: RpcConfig | null
  gameActivity?: Record<string, unknown> | null
  customStatus?: string | null
  customStatusEmoji?: string | null
  placeholderCtx?: PlaceholderContext
  vrStatusActive?: boolean
  platform?: string
}): Promise<Array<Record<string, unknown>>> {
  const activities: Array<Record<string, unknown>> = []

  // 1. Custom status activity (type 4) — independent of RPC
  const customActivity = buildCustomStatusActivity(
    options.customStatus || null,
    options.customStatusEmoji || null
  )
  if (customActivity) {
    activities.push(customActivity)
  }

  // 2. Games RPC activity (type 0, game's app_id) — PRIORITY over normal RPC
  if (options.gameActivity) {
    activities.push(options.gameActivity)
  }

  // 3. Normal RPC activity (type 0, OAuth client_id) — ONLY if no game activity
  const explicitPlatform = options.platform || options.rpcConfig?.platform
  const isVr = explicitPlatform === 'meta_quest' || (!!options.vrStatusActive && (!explicitPlatform || explicitPlatform === 'meta_quest'))

  if (!options.gameActivity && options.rpcConfig && options.rpcConfig.enabled !== false) {
    const ctx = options.placeholderCtx || {
      timezone: 'UTC',
      rpcStartedAt: Date.now(),
    }
    const rpcActivity = (await buildActivityPayload(options.rpcConfig, ctx)) as Record<string, unknown>
    if (isVr) {
      rpcActivity.platform = 'meta_quest'
      if (!rpcActivity.state) {
        rpcActivity.state = 'In Virtual Reality'
      }
    }
    rpcActivity.name = resolveRpcActivityName(options.rpcConfig?.name, isVr ? 'meta_quest' : explicitPlatform)
    activities.push(rpcActivity)
  }

  return activities
}

// Active gateway connections managed in-memory to persist presence and heartbeats
interface GatewayConnection {
  ws: WebSocket
  heartbeatTimer?: NodeJS.Timeout
  platform?: string
  lastStatus?: string
  lastActivities?: object[]
}

declare global {
  var __discordGatewaySockets: Map<string, GatewayConnection> | undefined
}
const gatewaySockets = global.__discordGatewaySockets ?? new Map<string, GatewayConnection>()
global.__discordGatewaySockets = gatewaySockets

/**
 * Send presence via Discord's Gaming SDK gateway.
 *
 * Uses the Gaming SDK gateway (wss://gateway.gaming-sdk.com/?v=10&encoding=json)
 * which accepts user OAuth2 tokens with the `sdk.social_layer_presence` scope.
 */
export async function sendPresenceViaGateway(
  accessToken: string,
  activityOrActivities: object | object[] | null,
  status: string = 'online',
  platform?: string
): Promise<PresenceResult> {
  const tokenKey = accessToken.slice(-32)
  const isQuest = platform === 'meta_quest' || (Array.isArray(activityOrActivities)
    ? activityOrActivities.some((a: any) => a?.platform === 'meta_quest')
    : (activityOrActivities as Record<string, unknown> | null)?.platform === 'meta_quest')
  const targetPlatform = isQuest ? 'meta_quest' : (platform || 'desktop')

  const activities: object[] = Array.isArray(activityOrActivities)
    ? activityOrActivities
    : activityOrActivities ? [activityOrActivities] : []

  // If clearing presence
  if (activities.length === 0 && (!status || status === 'offline')) {
    const existing = gatewaySockets.get(tokenKey)
    if (existing) {
      try {
        if (existing.ws.readyState === WebSocket.OPEN) {
          existing.ws.send(JSON.stringify({
            op: 3,
            d: {
              status: 'online',
              activities: [],
              afk: false,
              since: null,
            },
          }))
        }
        clearInterval(existing.heartbeatTimer)
        existing.ws.close()
      } catch {}
      gatewaySockets.delete(tokenKey)
    }
    return {
      ok: true,
      method: 'gateway',
      message: 'Presence cleared on gateway',
      activities: [],
    }
  }

  // If already connected and socket is open
  const existing = gatewaySockets.get(tokenKey)
  if (existing && existing.ws.readyState === WebSocket.OPEN) {
    // If the platform changed (e.g. desktop <-> meta_quest <-> mobile), re-identify
    if (existing.platform !== targetPlatform) {
      clearInterval(existing.heartbeatTimer)
      try { existing.ws.close() } catch {}
      gatewaySockets.delete(tokenKey)
    } else {
      try {
        existing.ws.send(JSON.stringify({
          op: 3,
          d: {
            status,
            activities,
            afk: false,
            since: null,
          },
        }))
        existing.lastStatus = status
        existing.lastActivities = activities
        return {
          ok: true,
          method: 'gateway',
          message: isQuest
            ? 'Meta Quest VR presence active on Discord'
            : 'Presence updated via active gateway connection',
          activities,
          activity: activities[0],
        }
      } catch {
        clearInterval(existing.heartbeatTimer)
        gatewaySockets.delete(tokenKey)
      }
    }
  }

  return new Promise((resolve) => {
    try {
      const gatewayUrl = CONFIG.discord.gatewayUrl
      const ws = new WebSocket(gatewayUrl)
      let heartbeatTimer: NodeJS.Timeout | undefined
      let resolved = false

      const finish = (result: PresenceResult) => {
        if (resolved) return
        resolved = true
        resolve(result)
      }

      // Timeout after 15 seconds
      const timeout = setTimeout(() => {
        clearInterval(heartbeatTimer)
        try { ws.close() } catch {}
        gatewaySockets.delete(tokenKey)
        finish({
          ok: false,
          method: 'gateway',
          message: 'Gateway connection timed out (15s)',
        })
      }, 15000)

      ws.on('open', () => {})

      ws.on('message', async (data: Buffer | string) => {
        try {
          const raw = typeof data === 'string' ? data : data.toString()
          const payload = JSON.parse(raw)
          const op = payload.op
          const t = payload.t

          if (op === 10) {
            // HELLO — start heartbeats and send IDENTIFY
            const heartbeatInterval = payload.d?.heartbeat_interval || 41250
            heartbeatTimer = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ op: 1, d: null }))
              }
            }, heartbeatInterval)

            const isMobile = targetPlatform === 'android' || targetPlatform === 'ios' || targetPlatform === 'samsung' || targetPlatform === 'mobile'
            const isConsole = targetPlatform === 'console' || targetPlatform === 'xbox' || targetPlatform === 'ps4' || targetPlatform === 'ps5'
            const isWeb = targetPlatform === 'web'

            const properties = isQuest
              ? {
                  os: 'Android',
                  browser: 'Discord VR',
                  device: 'Meta Quest',
                }
              : isMobile
              ? {
                  os: targetPlatform === 'ios' ? 'iOS' : 'Android',
                  browser: targetPlatform === 'ios' ? 'Discord iOS' : 'Discord Android',
                  device: targetPlatform === 'ios' ? 'iPhone' : (targetPlatform === 'samsung' ? 'Samsung Galaxy' : 'Android Device'),
                }
              : isConsole
              ? {
                  os: targetPlatform === 'xbox' ? 'Xbox' : 'PlayStation',
                  browser: targetPlatform === 'xbox' ? 'Discord Xbox' : 'Discord PlayStation',
                  device: targetPlatform === 'xbox' ? 'Xbox Series X' : 'PlayStation 5',
                }
              : isWeb
              ? {
                  os: 'Windows',
                  browser: 'Discord Web',
                  device: 'Chrome',
                }
              : {
                  os: 'Windows',
                  browser: 'Discord Client',
                  device: 'Desktop',
                }

            const bearerToken = accessToken.startsWith('Bearer ') ? accessToken : `Bearer ${accessToken}`
            const identify = {
              op: 2,
              d: {
                token: bearerToken,
                properties,
                intents: 0,
              },
            }
            ws.send(JSON.stringify(identify))
          } else if (op === 0 && t === 'READY') {
            // READY — send OP 3 PRESENCE_UPDATE (do not re-send on SESSIONS_REPLACE to avoid loop)
            clearTimeout(timeout)
            ws.send(JSON.stringify({
              op: 3,
              d: {
                status,
                activities,
                afk: false,
                since: null,
              },
            }))

            gatewaySockets.set(tokenKey, {
              ws,
              heartbeatTimer,
              platform: targetPlatform,
              lastStatus: status,
              lastActivities: activities,
            })

            finish({
              ok: true,
              method: 'gateway',
              message: isQuest
                ? 'Meta Quest VR presence active on Discord'
                : 'Presence sent via Gaming SDK gateway',
              activities,
              activity: activities[0],
            })
          } else if (op === 0 && t === 'PRESENCE_UPDATE') {
            clearTimeout(timeout)
            finish({
              ok: true,
              method: 'gateway',
              message: isQuest
                ? 'Meta Quest VR presence active on Discord'
                : 'Presence confirmed by Discord',
              activities,
              activity: activities[0],
            })
          } else if (op === 7) {
            // Reconnect requested by Discord
            clearTimeout(timeout)
            clearInterval(heartbeatTimer)
            try { ws.close(4000, 'Discord requested reconnect') } catch {}
            gatewaySockets.delete(tokenKey)
          } else if (op === 9) {
            clearTimeout(timeout)
            clearInterval(heartbeatTimer)
            gatewaySockets.delete(tokenKey)
            finish({
              ok: false,
              method: 'gateway',
              message: 'Invalid session — token may be expired or invalid',
            })
          } else if (op === 1) {
            // Server requested heartbeat
            ws.send(JSON.stringify({ op: 1, d: null }))
          }
        } catch {
          // Ignore parse errors
        }
      })

      ws.on('error', (err: Error) => {
        clearTimeout(timeout)
        clearInterval(heartbeatTimer)
        gatewaySockets.delete(tokenKey)
        finish({
          ok: false,
          method: 'gateway',
          message: `Gateway error: ${err.message}`,
        })
      })

      ws.on('close', (code: number, reason: Buffer) => {
        clearTimeout(timeout)
        clearInterval(heartbeatTimer)
        gatewaySockets.delete(tokenKey)
        if (!resolved) {
          let msg = 'Gateway connection closed before READY'
          if (code === 4004) {
            msg = 'Authentication failed — Discord rejected the OAuth2 token. Make sure your app has the sdk.social_layer_presence scope.'
          } else if (code === 4014) {
            msg = 'Disallowed intent(s) — your Discord app may not have the required permissions.'
          } else if (code) {
            const reasonStr = reason.toString()
            msg = `Gateway closed (code ${code}): ${reasonStr || 'no reason given'}`
          }
          finish({
            ok: false,
            method: 'gateway',
            message: msg,
          })
        }
      })
    } catch (e) {
      resolve({
        ok: false,
        method: 'gateway',
        message: `Failed to init gateway: ${e instanceof Error ? e.message : 'unknown'}`,
      })
    }
  })
}

/**
 * Set custom status via Discord REST API (fallback).
 * Note: Discord requires user token for /users/@me/settings.
 * For OAuth2 tokens, Gateway OP 3 is the standard working mechanism.
 */
export async function setCustomStatusViaRest(
  accessToken: string,
  emoji: string | null,
  text: string | null
): Promise<PresenceResult> {
  try {
    const body: Record<string, unknown> = {}
    if (text || emoji) {
      body.custom_status = {
        text: text || '',
        emoji_name: emoji || '',
      }
    } else {
      body.custom_status = null
    }

    const res = await fetch(`${CONFIG.discord.apiBase}/users/@me/settings`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return {
        ok: false,
        method: 'rest',
        message: `REST API ${res.status}: ${txt.slice(0, 200)}`,
      }
    }

    return {
      ok: true,
      method: 'rest',
      message: text ? `Custom status set: ${emoji || ''} ${text}` : 'Custom status cleared',
    }
  } catch (e) {
    return {
      ok: false,
      method: 'rest',
      message: `REST error: ${e instanceof Error ? e.message : 'unknown'}`,
    }
  }
}

/**
 * Set user status via Discord REST API (fallback).
 */
export async function setStatusViaRest(
  accessToken: string,
  status: string
): Promise<PresenceResult> {
  try {
    const res = await fetch(`${CONFIG.discord.apiBase}/users/@me/settings`, {
      method: 'PATCH',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status }),
    })

    if (!res.ok) {
      const txt = await res.text().catch(() => '')
      return {
        ok: false,
        method: 'rest',
        message: `Status API ${res.status}: ${txt.slice(0, 200)}`,
      }
    }

    return {
      ok: true,
      method: 'rest',
      message: `Status set to ${status}`,
    }
  } catch (e) {
    return {
      ok: false,
      method: 'rest',
      message: `Status error: ${e instanceof Error ? e.message : 'unknown'}`,
    }
  }
}

/**
 * Refresh the Discord access token using the refresh token.
 * Returns new tokens or null on failure.
 */
export async function refreshDiscordToken(
  refreshToken: string
): Promise<{ access_token: string; refresh_token: string; expires_in: number } | null> {
  try {
    const body = new URLSearchParams({
      client_id: CONFIG.discord.clientId,
      client_secret: CONFIG.discord.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    })
    const res = await fetch(CONFIG.discord.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })
    if (!res.ok) return null
    return res.json()
  } catch {
    return null
  }
}

/**
 * Full presence update pipeline:
 * 1. Get the user's Discord access token (refresh if expired)
 * 2. Build complete activities (Custom Status + Rich Presence) + resolve placeholders
 * 3. Send presence via gateway (OP 3)
 * 4. Update session state in DB
 */
export async function applyPresence(
  session: {
    id: string
    userId: string
    discordAccessToken: string | null
    discordRefreshToken: string | null
    discordTokenExpiresAt: Date | null
    userStatus: string
    customStatus: string | null
    customStatusEmoji: string | null
    vrStatusActive?: boolean
  },
  rpcConfig: RpcConfig | null,
  placeholderCtx: PlaceholderContext
): Promise<PresenceResult> {
  if (!session.discordAccessToken) {
    return {
      ok: false,
      method: 'none',
      message: 'No Discord access token. Please sign in with Discord (not demo mode).',
    }
  }

  let accessToken = session.discordAccessToken
  const now = new Date()
  if (session.discordTokenExpiresAt && session.discordTokenExpiresAt < now) {
    if (session.discordRefreshToken) {
      const refreshed = await refreshDiscordToken(session.discordRefreshToken)
      if (refreshed) {
        accessToken = refreshed.access_token
        const { db } = await import('./db')
        await db.session.update({
          where: { id: session.id },
          data: {
            discordAccessToken: refreshed.access_token,
            discordRefreshToken: refreshed.refresh_token,
            discordTokenExpiresAt: new Date(Date.now() + (refreshed.expires_in || 604800) * 1000),
          },
        })
      } else {
        return {
          ok: false,
          method: 'none',
          message: 'Discord token expired and refresh failed. Please sign in again.',
        }
      }
    } else {
      return {
        ok: false,
        method: 'none',
        message: 'Discord token expired. Please sign in again.',
      }
    }
  }

  const isRpcActive = !!((session as any).rpcEnabled && rpcConfig && rpcConfig.enabled !== false)
  const isStatusActive = !!(session as any).statusEnabled
  const statusPlatform = (session as any).statusPlatform || 'mobile'
  const explicitPlatform = isRpcActive ? (rpcConfig?.platform || 'desktop') : statusPlatform
  const isVr = (isStatusActive && statusPlatform === 'meta_quest') || (isRpcActive && rpcConfig?.platform === 'meta_quest')

  // Build combined activities (custom status + rich presence)
  const activities = await buildPresenceActivities({
    rpcConfig: isRpcActive ? rpcConfig : null,
    customStatus: isStatusActive ? session.customStatus : null,
    customStatusEmoji: isStatusActive ? session.customStatusEmoji : null,
    placeholderCtx,
    vrStatusActive: isVr,
    platform: isVr ? 'meta_quest' : explicitPlatform,
  })

  // Send presence via Gaming SDK gateway
  const gatewayResult = await sendPresenceViaGateway(
    accessToken,
    activities,
    isStatusActive ? (session.userStatus || 'online') : (isRpcActive ? 'online' : 'invisible'),
    isVr ? 'meta_quest' : explicitPlatform
  )

  // Update session state in DB
  // IMPORTANT: Never write `rpcEnabled` or `statusEnabled` from a presence send result.
  // The database enable flags are the single source of truth for both features and are
  // owned exclusively by their toggle endpoints (/api/status/toggle, /api/rpc/toggle).
  // A gateway send succeeding/failing must never flip either feature on or off
  // (prevents Status <-> RPC cross-triggering and silent feature deactivation).
  const { db } = await import('./db')
  await db.session.update({
    where: { id: session.id },
    data: {
      gatewayReady: gatewayResult.ok,
      lastPresenceUpdate: new Date(),
    },
  })

  return gatewayResult
}

/**
 * Clear all presence (when RPC is disabled or cleared).
 * Sends an empty activity list via gateway.
 */
export async function clearPresence(
  session: {
    id: string
    discordAccessToken: string | null
    discordRefreshToken: string | null
    discordTokenExpiresAt: Date | null
  }
): Promise<PresenceResult> {
  if (!session.discordAccessToken) {
    return {
      ok: false,
      method: 'none',
      message: 'No Discord access token.',
    }
  }

  const gatewayResult = await sendPresenceViaGateway(
    session.discordAccessToken,
    [],
    'online'
  )

  const { db } = await import('./db')
  await db.session.update({
    where: { id: session.id },
    data: {
      rpcEnabled: false,
      gatewayReady: false,
      lastPresenceUpdate: new Date(),
    },
  })

  return gatewayResult
}

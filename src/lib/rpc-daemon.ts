// 10X RPC — 24/7 Background RPC & Status Daemon
// Maintains persistent Discord Gateway WebSocket connections for all active sessions,
// automatically recovers from drops, refreshes expired OAuth tokens, ticks status rotator,
// updates dynamic placeholders, and enforces sleep timers.

import WebSocket from 'ws'
import { CONFIG } from './config'
import { db } from './db'
import {
  buildPresenceActivities,
  buildCustomStatusActivity,
  buildGameActivityPayload,
  refreshDiscordToken,
  type PresenceResult,
} from './rpc-manager'
import { resolvePlaceholders, type PlaceholderContext } from './placeholders'
import { findSpoofGame } from './spoof-games'

interface ActiveUserSocket {
  userId: string
  sessionId: string
  ws: WebSocket | null
  heartbeatTimer?: NodeJS.Timeout
  heartbeatAck: boolean
  retryCount: number
  retryTimer?: NodeJS.Timeout
  platform: string
  lastStatus: string
  lastActivitiesHash: string
  connected: boolean
  lastConnectedAt?: Date
  isConnecting: boolean
  // Track previous enabled state to detect TRANSITIONS (ON→OFF) and force-clear Discord.
  // Without this, the hash-dedup in pushPresenceForUser can skip the clear-push when
  // the computed activities happen to match what's already cached.
  lastRpcActive: boolean
  lastStatusActive: boolean
  lastGamesRpcActive: boolean
}

export class RpcDaemon {
  private sockets = new Map<string, ActiveUserSocket>()
  private tickTimer?: NodeJS.Timeout
  private isRunning = false
  private startTime = Date.now()
  private lastTickAt: Date | null = null

  /**
   * Start the 24/7 background daemon.
   */
  public async start(): Promise<void> {
    if (this.isRunning) return
    this.isRunning = true
    this.startTime = Date.now()
    console.log('[10X RPC Daemon] Starting 24/7 background daemon...')

    // Run initial sync
    await this.syncAllUsers().catch(err => {
      console.error('[10X RPC Daemon] Initial sync error:', err)
    })

    // Tick every 30 seconds
    this.tickTimer = setInterval(async () => {
      try {
        await this.tick()
      } catch (err) {
        console.error('[10X RPC Daemon] Tick error:', err)
      }
    }, 30000)

    console.log('[10X RPC Daemon] 24/7 daemon started successfully.')
  }

  /**
   * Stop the daemon and disconnect sockets.
   */
  public stop(): void {
    if (!this.isRunning) return
    this.isRunning = false
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = undefined
    }

    for (const [userId, userSock] of this.sockets.entries()) {
      this.cleanupSocket(userSock)
    }
    this.sockets.clear()
    console.log('[10X RPC Daemon] Daemon stopped.')
  }

  /**
   * Background tick loop:
   * - Rotates custom status if rotator is enabled
   * - Checks and expires sleep timers
   * - Re-resolves dynamic placeholders ({time}, {uptime}, etc.)
   * - Refreshes near-expiry Discord tokens
   * - Syncs any DB state changes
   */
  public async tick(): Promise<void> {
    this.lastTickAt = new Date()
    const now = new Date()

    // 1. Sync users from DB
    await this.syncAllUsers()

    // 2. Iterate connected users
    for (const [userId, userSock] of this.sockets.entries()) {
      try {
        const session = await db.session.findFirst({
          where: { userId, expiresAt: { gt: now } },
          include: {
            user: {
              include: {
                globalConfig: true,
                rotatorPresets: { orderBy: { order: 'asc' } },
                trial: true,
              },
            },
          },
        })

        if (!session) {
          this.disconnectUser(userId)
          continue
        }

        // Check trial
        if (!session.user.trial || !session.user.trial.active || session.user.trial.endsAt < now) {
          console.log(`[10X RPC Daemon] Trial expired for user ${userId}, disabling presence`)
          await db.session.update({
            where: { id: session.id },
            data: { rpcEnabled: false, statusEnabled: false, gatewayReady: false },
          })
          this.disconnectUser(userId)
          continue
        }

        // Check sleep timer
        if (session.sleepTimerActive && session.sleepTimerEndsAt && session.sleepTimerEndsAt <= now) {
          console.log(`[10X RPC Daemon] Sleep timer elapsed for user ${userId}`)
          await db.session.update({
            where: { id: session.id },
            data: {
              sleepTimerActive: false,
              sleepTimerEndsAt: null,
              rpcEnabled: false,
              statusEnabled: false,
              gatewayReady: false,
            },
          })
          await db.rpcConfig.updateMany({
            where: { userId, enabled: true },
            data: { enabled: false },
          })
          this.disconnectUser(userId)
          continue
        }

        // Check token expiration (refresh if < 30 mins left)
        if (session.discordTokenExpiresAt && session.discordTokenExpiresAt.getTime() - now.getTime() < 30 * 60 * 1000) {
          if (session.discordRefreshToken) {
            console.log(`[10X RPC Daemon] Refreshing Discord token for user ${userId}...`)
            const refreshed = await refreshDiscordToken(session.discordRefreshToken)
            if (refreshed) {
              await db.session.update({
                where: { id: session.id },
                data: {
                  discordAccessToken: refreshed.access_token,
                  discordRefreshToken: refreshed.refresh_token,
                  discordTokenExpiresAt: new Date(Date.now() + (refreshed.expires_in || 604800) * 1000),
                },
              })
              session.discordAccessToken = refreshed.access_token
            }
          }
        }

        // Check status rotator
        if (session.user.globalConfig?.rotatorEnabled) {
          const presets = session.user.rotatorPresets.filter(p => p.enabled)
          if (presets.length > 0) {
            const totalDurationSecs = presets.reduce((sum, p) => sum + Math.max(1, p.durationMins * 60), 0)
            const referenceTime = presets[0].createdAt.getTime()
            const elapsedSecs = Math.floor((now.getTime() - referenceTime) / 1000)
            const positionInCycle = ((elapsedSecs % totalDurationSecs) + totalDurationSecs) % totalDurationSecs

            let accumulated = 0
            let activeIndex = 0
            for (let i = 0; i < presets.length; i++) {
              const dur = Math.max(1, presets[i].durationMins * 60)
              if (accumulated + dur > positionInCycle) {
                activeIndex = i
                break
              }
              accumulated += dur
            }

            const activePreset = presets[activeIndex]
            if (session.customStatus !== activePreset.text || session.customStatusEmoji !== activePreset.emoji) {
              await db.session.update({
                where: { id: session.id },
                data: {
                  customStatus: activePreset.text,
                  customStatusEmoji: activePreset.emoji,
                },
              })
              session.customStatus = activePreset.text
              session.customStatusEmoji = activePreset.emoji
            }
          }
        }

        // Re-evaluate activities and push OP 3 if needed
        await this.pushPresenceForUser(userId, session)
      } catch (userTickErr) {
        console.error(`[10X RPC Daemon] Error in tick for user ${userId}:`, userTickErr)
      }
    }
  }

  /**
   * Synchronize all active users from Postgres DB.
   * Only keeps connections alive for users with active RPC, custom status, or status rotator.
   * Cleans up and disconnects any user whose RPC and status are disabled.
   */
  public async syncAllUsers(): Promise<void> {
    const now = new Date()
    const activeSessions = await db.session.findMany({
      where: {
        expiresAt: { gt: now },
        discordAccessToken: { not: null },
      },
      include: {
        user: {
          include: {
            trial: true,
            globalConfig: true,
            rpcConfigs: true,
            gameRpcConfigs: true,
            rotatorPresets: true,
          },
        },
      },
    })

    const activeUserIds = new Set<string>()

    for (const session of activeSessions) {
      // Check trial
      if (!session.user.trial || !session.user.trial.active || session.user.trial.endsAt < now) {
        continue
      }
      // Check sleep timer
      if (session.sleepTimerActive && session.sleepTimerEndsAt && session.sleepTimerEndsAt <= now) {
        continue
      }

      const rpcConfig = session.user.rpcConfigs?.[0]
      const gameRpcConfig = session.user.gameRpcConfigs?.[0]
      const hasRpc = !!(session.rpcEnabled && rpcConfig?.enabled)
      const hasGamesRpc = !!(session.gamesRpcEnabled && gameRpcConfig?.enabled)
      const hasStatus = !!session.statusEnabled
      const hasRotator = !!(session.statusEnabled && session.user.globalConfig?.rotatorEnabled && session.user.rotatorPresets?.some(p => p.enabled))

      // Only track if user actually has active RPC, Games RPC, status, or rotator
      if (!hasRpc && !hasGamesRpc && !hasStatus && !hasRotator) {
        continue
      }

      activeUserIds.add(session.userId)
      let userSock = this.sockets.get(session.userId)

      if (!userSock) {
        userSock = {
          userId: session.userId,
          sessionId: session.id,
          ws: null,
          heartbeatAck: true,
          retryCount: 0,
          platform: rpcConfig?.platform || 'desktop',
          lastStatus: session.userStatus || 'online',
          lastActivitiesHash: '',
          connected: false,
          isConnecting: false,
          lastRpcActive: false,
          lastStatusActive: false,
          lastGamesRpcActive: false,
        }
        this.sockets.set(session.userId, userSock)
      }

      // If socket is disconnected, connect it
      if (!userSock.connected && !userSock.isConnecting) {
        this.connectUserSocket(session.userId)
      }
    }

    // Cleanup and disconnect users that are no longer active (prevents background restarts)
    for (const [userId, userSock] of this.sockets.entries()) {
      if (!activeUserIds.has(userId)) {
        this.disconnectUser(userId)
      }
    }
  }

  /**
   * Stop RPC completely for a user:
   * - Sends OP 3 with empty activities (or custom status only) to clear Discord Rich Presence
   * - Stops all timers and intervals
   * - Disconnects socket if no other presence (e.g. custom status) is needed
   * - Prevents background restarts
   */
  public async stopUserRpc(userId: string): Promise<void> {
    const session = await db.session.findFirst({
      where: { userId, discordAccessToken: { not: null }, expiresAt: { gt: new Date() } },
      orderBy: { discordTokenExpiresAt: 'desc' },
    })
    if (!session || !session.discordAccessToken) return

    const userSock = this.sockets.get(userId)
    const hasStatus = !!session.statusEnabled
    const hasCustomStatus = !!(session.customStatus || session.customStatusEmoji)

    if (userSock && userSock.ws && userSock.ws.readyState === WebSocket.OPEN) {
      const activities: Array<Record<string, unknown>> = []
      if (hasStatus && hasCustomStatus) {
        const customActivity = buildCustomStatusActivity(
          session.customStatus,
          session.customStatusEmoji
        )
        if (customActivity) activities.push(customActivity)
      }

      const status = hasStatus ? (session.userStatus || 'online') : 'invisible'

      try {
        userSock.ws.send(JSON.stringify({
          op: 3,
          d: {
            status,
            activities,
            afk: false,
            since: null,
          },
        }))
        userSock.lastActivitiesHash = JSON.stringify({ status, activities })
        userSock.lastStatus = status
      } catch (err) {
        console.error(`[10X RPC Daemon] Error sending clear OP 3 for user ${userId}:`, err)
      }

      // If status is not active, close socket cleanly and stop all timers
      if (!hasStatus) {
        this.cleanupSocket(userSock)
        this.sockets.delete(userId)
      }
    } else if (hasStatus) {
      // Connect to Discord Gateway to maintain user status
      await this.connectUserSocket(userId)
    }
  }

  /**
   * Sync a specific user immediately on UI actions (button click, toggle, status change).
   */
  public async syncUser(userId: string): Promise<PresenceResult> {
    const now = new Date()
    const session = await db.session.findFirst({
      where: { userId, expiresAt: { gt: now } },
      include: {
        user: {
          include: {
            trial: true,
            globalConfig: true,
            rotatorPresets: true,
          },
        },
      },
    })

    if (!session || !session.discordAccessToken) {
      this.disconnectUser(userId)
      return {
        ok: false,
        method: 'none',
        message: 'No active session with Discord token',
      }
    }

    // Trial check
    if (!session.user.trial || !session.user.trial.active || session.user.trial.endsAt < now) {
      this.disconnectUser(userId)
      return {
        ok: false,
        method: 'none',
        message: 'Trial expired',
      }
    }

    const rpcConfig = await db.rpcConfig.findFirst({ where: { userId } })
    const gameRpcConfig = await db.gameRpcConfig.findUnique({ where: { userId } })
    const hasRpc = !!(session.rpcEnabled && rpcConfig?.enabled)
    const hasGamesRpc = !!(session.gamesRpcEnabled && gameRpcConfig?.enabled)
    const hasStatus = !!session.statusEnabled
    const hasRotator = !!(session.statusEnabled && session.user.globalConfig?.rotatorEnabled && session.user.rotatorPresets?.some(p => p.enabled))

    // If neither status, RPC, Games RPC, nor rotator is active: stop & clear
    if (!hasRpc && !hasGamesRpc && !hasStatus && !hasRotator) {
      await this.stopUserRpc(userId)
      return {
        ok: true,
        method: 'gateway',
        message: 'Presence disabled & cleared from Discord',
      }
    }

    let userSock = this.sockets.get(userId)
    if (!userSock) {
      userSock = {
        userId,
        sessionId: session.id,
        ws: null,
        heartbeatAck: true,
        retryCount: 0,
        platform: rpcConfig?.platform || 'desktop',
        lastStatus: session.userStatus || 'online',
        lastActivitiesHash: '',
        connected: false,
        isConnecting: false,
        lastRpcActive: false,
        lastStatusActive: false,
        lastGamesRpcActive: false,
      }
      this.sockets.set(userId, userSock)
    }

    if (!userSock.connected && !userSock.isConnecting) {
      await this.connectUserSocket(userId)
    } else {
      await this.pushPresenceForUser(userId, session, true)
    }

    return {
      ok: true,
      method: 'gateway',
      message: 'Presence synced to 24/7 Gateway',
    }
  }

  /**
   * Connect or reconnect a user's WebSocket to Discord Gaming SDK Gateway.
   */
  private async connectUserSocket(userId: string): Promise<void> {
    const userSock = this.sockets.get(userId)
    if (!userSock || userSock.isConnecting) return

    // Clean up previous socket cleanly before starting new connection
    this.cleanupSocket(userSock)
    userSock.isConnecting = true

    try {
      const session = await db.session.findFirst({
        where: { userId, discordAccessToken: { not: null }, expiresAt: { gt: new Date() } },
        orderBy: { discordTokenExpiresAt: 'desc' },
      })
      if (!session || !session.discordAccessToken) {
        userSock.isConnecting = false
        this.disconnectUser(userId)
        return
      }

      // Check if token is expired and refresh before connecting
      let accessToken = session.discordAccessToken
      const now = new Date()
      if (session.discordTokenExpiresAt && session.discordTokenExpiresAt < now) {
        if (session.discordRefreshToken) {
          const refreshed = await refreshDiscordToken(session.discordRefreshToken)
          if (refreshed) {
            accessToken = refreshed.access_token
            await db.session.update({
              where: { id: session.id },
              data: {
                discordAccessToken: refreshed.access_token,
                discordRefreshToken: refreshed.refresh_token,
                discordTokenExpiresAt: new Date(Date.now() + (refreshed.expires_in || 604800) * 1000),
              },
            })
          }
        }
      }

      // Check target platform based on active mode
      const rpcConfig = await db.rpcConfig.findFirst({ where: { userId } })
      const isRpcActive = !!(session.rpcEnabled && rpcConfig?.enabled)
      const isStatusActive = !!session.statusEnabled

      // Determine the IDENTIFY platform. When RPC is active, use the RPC's platform
      // (e.g. desktop) so Discord accepts the type=0 activity. Using statusPlatform
      // (e.g. meta_quest) causes Discord to reject desktop RPC activities.
      const activePlatform = isRpcActive
        ? (rpcConfig?.platform || 'desktop')
        : (isStatusActive ? (session.statusPlatform || 'mobile') : (session.statusPlatform || 'mobile'))

      const isQuest = activePlatform === 'meta_quest' || (isStatusActive && session.vrStatusActive && !isRpcActive)
      const targetPlatform = isQuest ? 'meta_quest' : activePlatform
      userSock.platform = targetPlatform

      const ws = new WebSocket(CONFIG.discord.gatewayUrl)
      userSock.ws = ws

      ws.on('open', () => {
        // Awaiting HELLO (OP 10)
      })

      ws.on('message', async (data: Buffer | string) => {
        try {
          const raw = typeof data === 'string' ? data : data.toString()
          const payload = JSON.parse(raw)
          const op = payload.op
          const t = payload.t

          if (op === 10) {
            // HELLO: Start heartbeats and send IDENTIFY
            const heartbeatInterval = payload.d?.heartbeat_interval || 41250
            userSock.heartbeatAck = true

            userSock.heartbeatTimer = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                if (!userSock.heartbeatAck) {
                  console.warn(`[10X RPC Daemon] Zombie socket detected for user ${userId} (missing ACK). Reconnecting...`)
                  this.cleanupSocket(userSock)
                  this.scheduleReconnect(userId)
                  return
                }
                userSock.heartbeatAck = false
                ws.send(JSON.stringify({ op: 1, d: null }))
              }
            }, heartbeatInterval)

            const isMobile = targetPlatform === 'android' || targetPlatform === 'ios' || targetPlatform === 'samsung' || targetPlatform === 'mobile'
            const isConsole = targetPlatform === 'console' || targetPlatform === 'xbox' || targetPlatform === 'ps4' || targetPlatform === 'ps5'
            const isWeb = targetPlatform === 'web'

            const properties = isQuest
              ? { os: 'Android', browser: 'Discord VR', device: 'Meta Quest' }
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
              ? { os: 'Windows', browser: 'Discord Web', device: 'Chrome' }
              : { os: 'Windows', browser: 'Discord Client', device: 'Desktop' }

            const bearerToken = accessToken.startsWith('Bearer ') ? accessToken : `Bearer ${accessToken}`
            const identify = {
              op: 2,
              d: {
                token: bearerToken,
                properties,
                // Intents: 0 = no privileged intents needed for presence updates.
                // The main gateway requires the intents field; the Gaming SDK gateway ignores it.
                intents: 0,
              },
            }
            ws.send(JSON.stringify(identify))
          } else if (op === 11) {
            // Heartbeat ACK
            userSock.heartbeatAck = true
          } else if (op === 1) {
            // Server requested heartbeat
            ws.send(JSON.stringify({ op: 1, d: null }))
          } else if (op === 0 && t === 'READY') {
            // Authenticated and ready! Only trigger initial presence push on READY (NOT on SESSIONS_REPLACE to avoid infinite loop)
            userSock.connected = true
            userSock.isConnecting = false
            userSock.retryCount = 0
            userSock.lastConnectedAt = new Date()

            await db.session.update({
              where: { id: session.id },
              data: {
                gatewayReady: true,
                lastPresenceUpdate: new Date(),
              },
            }).catch(() => {})

            // Push current presence immediately
            await this.pushPresenceForUser(userId, session, true)
          } else if (op === 7) {
            // Discord requested reconnect
            console.log(`[10X RPC Daemon] Discord Gateway sent OP 7 RECONNECT for user ${userId}. Reconnecting...`)
            this.cleanupSocket(userSock)
            this.scheduleReconnect(userId, 1000)
          } else if (op === 9) {
            // Invalid session
            console.warn(`[10X RPC Daemon] Discord Gateway sent OP 9 INVALID_SESSION for user ${userId}`)
            this.cleanupSocket(userSock)
            this.scheduleReconnect(userId, 3000)
          }
        } catch (err) {
          console.error(`[10X RPC Daemon] Error handling WS message for user ${userId}:`, err)
        }
      })

      ws.on('error', (err) => {
        console.error(`[10X RPC Daemon] Gateway WS error for user ${userId}:`, err.message)
        userSock.connected = false
        userSock.isConnecting = false
        this.cleanupSocket(userSock)
        this.scheduleReconnect(userId)
      })

      ws.on('close', async (code, reason) => {
        console.log(`[10X RPC Daemon] Gateway WS closed for user ${userId} (code: ${code}, reason: ${reason.toString() || 'none'})`)
        userSock.connected = false
        userSock.isConnecting = false
        this.cleanupSocket(userSock)

        if (code === 4004) {
          // Auth failed — try refreshing token
          console.log(`[10X RPC Daemon] Auth failed (4004) for user ${userId}. Refreshing token...`)
          if (session.discordRefreshToken) {
            const refreshed = await refreshDiscordToken(session.discordRefreshToken)
            if (refreshed) {
              await db.session.update({
                where: { id: session.id },
                data: {
                  discordAccessToken: refreshed.access_token,
                  discordRefreshToken: refreshed.refresh_token,
                  discordTokenExpiresAt: new Date(Date.now() + (refreshed.expires_in || 604800) * 1000),
                },
              })
              this.scheduleReconnect(userId, 2000)
              return
            }
          }
        } else if (code === 4008) {
          // Rate limited — back off for 60 seconds to allow rate limit window to clear
          console.warn(`[10X RPC Daemon] Rate limited by Discord Gateway for user ${userId}. Backing off for 60s...`)
          this.scheduleReconnect(userId, 60000)
          return
        }

        this.scheduleReconnect(userId)
      })
    } catch (err) {
      console.error(`[10X RPC Daemon] Failed to initialize connection for user ${userId}:`, err)
      userSock.connected = false
      userSock.isConnecting = false
      this.scheduleReconnect(userId)
    }
  }

  /**
   * Schedule reconnection with exponential backoff.
   */
  private scheduleReconnect(userId: string, customDelayMs?: number): void {
    const userSock = this.sockets.get(userId)
    if (!userSock || userSock.retryTimer) return

    const delay = customDelayMs ?? Math.min(30000, 1000 * Math.pow(1.5, Math.min(userSock.retryCount, 8)))
    userSock.retryCount++

    userSock.retryTimer = setTimeout(() => {
      userSock.retryTimer = undefined
      this.connectUserSocket(userId)
    }, delay)
  }

  /**
   * Build activities and send OP 3 for the user if anything changed or on reconnect.
   *
   * Handles THREE independent features:
   *   - Status (custom status, type 4) — session.statusEnabled
   *   - Games RPC (type 0, game's app_id) — session.gamesRpcEnabled + gameRpcConfig.enabled  [PRIORITY]
   *   - Normal RPC (type 0, OAuth client_id) — session.rpcEnabled + rpcConfig.enabled
   *
   * Games RPC takes priority over Normal RPC (Discord only shows one type-0 activity).
   * Both have independent enable flags; disabling one never touches the other.
   */
  private async pushPresenceForUser(userId: string, session: any, force: boolean = false): Promise<void> {
    const userSock = this.sockets.get(userId)
    if (!userSock || !userSock.ws || userSock.ws.readyState !== WebSocket.OPEN) return

    let rpcConfig = null
    let gameRpcConfig = null
    let globalConfig = null
    try {
      [rpcConfig, gameRpcConfig, globalConfig] = await Promise.all([
        db.rpcConfig.findFirst({ where: { userId } }),
        db.gameRpcConfig.findUnique({ where: { userId } }),
        db.globalConfig.findUnique({ where: { userId } }),
      ])
    } catch (dbErr) {
      console.warn(`[10X RPC Daemon] Transient DB error in pushPresenceForUser for user ${userId}:`, dbErr)
      return
    }

    const placeholderCtx: PlaceholderContext = {
      timezone: globalConfig?.timezone || 'UTC',
      city: globalConfig?.city || undefined,
      rpcStartedAt: rpcConfig?.updatedAt
        ? new Date(rpcConfig.updatedAt).getTime()
        : (session.lastPresenceUpdate ? new Date(session.lastPresenceUpdate).getTime() : Date.now()),
    }

    // DATABASE IS SINGLE SOURCE OF TRUTH for all three features (independent):
    const isRpcActive = !!(session.rpcEnabled && rpcConfig?.enabled)
    const isGamesRpcActive = !!(session.gamesRpcEnabled && gameRpcConfig?.enabled)
    const isStatusActive = !!session.statusEnabled

    // Detect state TRANSITIONS to force a re-push (clears Discord on disable).
    const rpcTurnedOff = userSock.lastRpcActive && !isRpcActive
    const gamesRpcTurnedOff = userSock.lastGamesRpcActive && !isGamesRpcActive
    const statusTurnedOff = userSock.lastStatusActive && !isStatusActive
    const forceDueToTransition = rpcTurnedOff || gamesRpcTurnedOff || statusTurnedOff

    // Build Games RPC activity if active (uses the game's real app_id — spoofs the game)
    let gameActivity: Record<string, unknown> | null = null
    if (isGamesRpcActive && gameRpcConfig) {
      const game = findSpoofGame(gameRpcConfig.gameSlug)
      if (game) {
        try {
          gameActivity = await buildGameActivityPayload({
            gameSlug: game.slug,
            name: game.name,
            appId: game.app_id,
            img: game.img,
            state: gameRpcConfig.state,
            details: gameRpcConfig.details,
            largeImage: gameRpcConfig.largeImage,
            largeText: gameRpcConfig.largeText,
            smallImage: gameRpcConfig.smallImage,
            smallText: gameRpcConfig.smallText,
            button1Label: gameRpcConfig.button1Label,
            button1Url: gameRpcConfig.button1Url,
            button2Label: gameRpcConfig.button2Label,
            button2Url: gameRpcConfig.button2Url,
            partyCurrent: gameRpcConfig.partyCurrent,
            partyMax: gameRpcConfig.partyMax,
            startMinsAgo: gameRpcConfig.startMinsAgo,
            endTotalMins: gameRpcConfig.endTotalMins,
            updatedAt: gameRpcConfig.updatedAt,
          }, placeholderCtx)
        } catch (err) {
          console.error(`[10X RPC Daemon] Error building game activity for user ${userId}:`, err)
        }
      }
    }

    // Use RPC platform when RPC is active (so Discord accepts the type=0 activity).
    // Using statusPlatform (e.g. meta_quest) causes Discord to reject desktop RPC activities.
    const activePlatform = isRpcActive
      ? (rpcConfig?.platform || 'desktop')
      : (isGamesRpcActive ? 'desktop' : (isStatusActive ? (session.statusPlatform || 'mobile') : (session.statusPlatform || 'mobile')))
    userSock.platform = activePlatform === 'meta_quest' ? 'meta_quest' : activePlatform

    const activities = await buildPresenceActivities({
      rpcConfig: isRpcActive ? rpcConfig : null,
      gameActivity: gameActivity,
      customStatus: isStatusActive ? session.customStatus : null,
      customStatusEmoji: isStatusActive ? session.customStatusEmoji : null,
      placeholderCtx,
      vrStatusActive: (isStatusActive && session.statusPlatform === 'meta_quest') || (isRpcActive && rpcConfig?.platform === 'meta_quest'),
      platform: isGamesRpcActive ? 'desktop' : (isRpcActive ? (rpcConfig?.platform || 'desktop') : (session.statusPlatform || 'mobile')),
    })

    const status = isStatusActive ? (session.userStatus || 'online') : ((isRpcActive || isGamesRpcActive) ? 'online' : 'invisible')
    const activitiesHash = JSON.stringify({ status, activities })

    // Avoid spamming identical OP 3 payloads unless forced.
    if (!force && !forceDueToTransition && userSock.lastActivitiesHash === activitiesHash && userSock.lastStatus === status) {
      return
    }

    if (!userSock.ws || userSock.ws.readyState !== WebSocket.OPEN) return

    try {
      const reason = forceDueToTransition
        ? ` (transition: rpc ${userSock.lastRpcActive}→${isRpcActive}, gamesRpc ${userSock.lastGamesRpcActive}→${isGamesRpcActive}, status ${userSock.lastStatusActive}→${isStatusActive})`
        : ''
      console.log(`[10X RPC Daemon] Sending OP 3 for user ${userId}: status=${status}, activities=${JSON.stringify(activities)}${reason}`)
      userSock.ws.send(JSON.stringify({
        op: 3,
        d: {
          status,
          activities,
          afk: false,
          since: null,
        },
      }))
      userSock.lastStatus = status
      userSock.lastActivitiesHash = activitiesHash
      userSock.lastRpcActive = isRpcActive
      userSock.lastGamesRpcActive = isGamesRpcActive
      userSock.lastStatusActive = isStatusActive
    } catch (err) {
      console.error(`[10X RPC Daemon] Failed to send OP 3 for user ${userId}:`, err)
    }
  }

  /**
   * Disconnect and remove a user from the daemon.
   */
  public disconnectUser(userId: string): void {
    const userSock = this.sockets.get(userId)
    if (!userSock) return

    this.cleanupSocket(userSock)
    this.sockets.delete(userId)
    console.log(`[10X RPC Daemon] Disconnected user ${userId}`)
  }

  /**
   * Clean up a socket and its timers.
   */
  private cleanupSocket(userSock: ActiveUserSocket): void {
    if (userSock.heartbeatTimer) {
      clearInterval(userSock.heartbeatTimer)
      userSock.heartbeatTimer = undefined
    }
    if (userSock.retryTimer) {
      clearTimeout(userSock.retryTimer)
      userSock.retryTimer = undefined
    }
    if (userSock.ws) {
      try {
        userSock.ws.removeAllListeners()
        userSock.ws.close()
      } catch {}
      userSock.ws = null
    }
    userSock.connected = false
    userSock.isConnecting = false
  }

  /**
   * Get daemon metrics and status for health endpoint.
   */
  public getStatus() {
    return {
      running: this.isRunning,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
      lastTickAt: this.lastTickAt,
      activeConnections: Array.from(this.sockets.values()).filter(s => s.connected).length,
      totalTrackedUsers: this.sockets.size,
      users: Array.from(this.sockets.values()).map(s => ({
        userId: s.userId,
        connected: s.connected,
        platform: s.platform,
        lastStatus: s.lastStatus,
        lastConnectedAt: s.lastConnectedAt,
      })),
    }
  }
}

// Global singleton for Next.js and server environments
declare global {
  var __rpcDaemonInstance: RpcDaemon | undefined
}

export function getRpcDaemon(): RpcDaemon {
  if (!global.__rpcDaemonInstance) {
    global.__rpcDaemonInstance = new RpcDaemon()
  }
  return global.__rpcDaemonInstance
}

/**
 * Helper to ensure the 24/7 daemon is started.
 */
export function ensureDaemonRunning(): RpcDaemon {
  const daemon = getRpcDaemon()
  daemon.start().catch(err => {
    console.error('[10X RPC Daemon] Failed to start daemon:', err)
  })
  return daemon
}

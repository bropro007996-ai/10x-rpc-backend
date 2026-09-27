// 10X RPC — Daemon bridge helper
//
// In the split deployment (Vercel frontend + Render backend), the 24/7 Discord
// Gateway WebSocket connections live ONLY in the Render daemon process.
// Vercel serverless functions are short-lived and cannot reach the Render
// daemon's in-memory sockets.
//
// This helper lets Vercel API routes tell the Render daemon to sync/stop a user
// via HTTP. If RENDER_BACKEND_URL is set (production), it calls the Render
// daemon's /sync-user or /stop-rpc HTTP endpoint. Otherwise (sandbox / no
// Discord creds), it falls back to the in-process ephemeral daemon (best-effort
// immediate push that won't persist, but works for the demo).

import { CONFIG } from './config'
import { ensureDaemonRunning } from './rpc-daemon'

export interface DaemonBridgeResult {
  ok: boolean
  method: 'render-http' | 'local-daemon' | 'skipped'
  message?: string
}

/**
 * Tell the daemon to immediately sync (push presence for) a user.
 * Called after any UI action that changes RPC/Status state (toggle, update).
 */
export async function daemonSyncUser(userId: string): Promise<DaemonBridgeResult> {
  const renderUrl = CONFIG.render.backendUrl
  if (renderUrl) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 12000)
      const res = await fetch(`${renderUrl}/sync-user?userId=${encodeURIComponent(userId)}`, {
        method: 'POST',
        signal: ctrl.signal,
        cache: 'no-store',
      })
      clearTimeout(t)
      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        return {
          ok: !!data.ok,
          method: 'render-http',
          message: data.message || 'Synced via Render daemon',
        }
      }
      return { ok: false, method: 'render-http', message: `Render /sync-user returned ${res.status}` }
    } catch (e) {
      return {
        ok: false,
        method: 'render-http',
        message: e instanceof Error ? e.message : 'fetch failed',
      }
    }
  }
  // Fallback: in-process ephemeral daemon (sandbox / no Render backend)
  try {
    const daemon = ensureDaemonRunning()
    await daemon.syncUser(userId)
    return { ok: true, method: 'local-daemon', message: 'Synced via local daemon' }
  } catch (e) {
    return { ok: false, method: 'local-daemon', message: e instanceof Error ? e.message : 'failed' }
  }
}

/**
 * Tell the daemon to STOP RPC for a user (clear Discord presence).
 * Called when /api/rpc/toggle disables RPC, or when /api/rpc clears presence.
 */
export async function daemonStopUserRpc(userId: string): Promise<DaemonBridgeResult> {
  const renderUrl = CONFIG.render.backendUrl
  if (renderUrl) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), 12000)
      const res = await fetch(`${renderUrl}/stop-rpc?userId=${encodeURIComponent(userId)}`, {
        method: 'POST',
        signal: ctrl.signal,
        cache: 'no-store',
      })
      clearTimeout(t)
      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        return {
          ok: !!data.ok,
          method: 'render-http',
          message: data.message || 'RPC stopped via Render daemon',
        }
      }
      return { ok: false, method: 'render-http', message: `Render /stop-rpc returned ${res.status}` }
    } catch (e) {
      return {
        ok: false,
        method: 'render-http',
        message: e instanceof Error ? e.message : 'fetch failed',
      }
    }
  }
  // Fallback: in-process ephemeral daemon
  try {
    const daemon = ensureDaemonRunning()
    await daemon.stopUserRpc(userId)
    return { ok: true, method: 'local-daemon', message: 'RPC stopped via local daemon' }
  } catch (e) {
    return { ok: false, method: 'local-daemon', message: e instanceof Error ? e.message : 'failed' }
  }
}

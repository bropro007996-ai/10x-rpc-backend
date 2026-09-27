// 10X RPC — OAuth callback handler
// Looks up the PKCE verifier from the database by state (NOT cookies).
// This works across the Vercel→Render proxy.
import { NextResponse } from 'next/server'
import { exchangeCode, fetchDiscordUser, avatarUrl } from '@/lib/discord-oauth'
import { CONFIG } from '@/lib/config'
import { db } from '@/lib/db'
import { setSessionCookie } from '@/lib/session'
import { syncSubscriptionState } from '@/lib/subscription'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const url = new URL(req.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const error = url.searchParams.get('error')

  if (error) {
    return NextResponse.redirect(`${CONFIG.app.url}/?error=${encodeURIComponent(error)}`)
  }
  if (!code || !state) {
    return NextResponse.redirect(`${CONFIG.app.url}/?error=missing_code`)
  }

  // Look up the PKCE verifier from the database by state
  const oauthState = await db.oAuthState.findUnique({
    where: { state },
  })

  if (!oauthState) {
    return NextResponse.redirect(`${CONFIG.app.url}/?error=invalid_state`)
  }

  // Check if the state has expired
  if (oauthState.expiresAt < new Date()) {
    await db.oAuthState.delete({ where: { id: oauthState.id } }).catch(() => {})
    return NextResponse.redirect(`${CONFIG.app.url}/?error=state_expired`)
  }

  const verifier = oauthState.verifier

  // Delete the state so it can't be reused (one-time use)
  await db.oAuthState.delete({ where: { id: oauthState.id } }).catch(() => {})

  try {
    const redirectUri = CONFIG.discord.redirectUri
    const tokens = await exchangeCode(code, verifier, redirectUri)
    const discordUser = await fetchDiscordUser(tokens.access_token)

    // Upsert the user
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
    if (!await db.trial.findUnique({ where: { userId: user.id } })) {
      await db.trial.create({
        data: {
          userId: user.id,
          startsAt: new Date(),
          endsAt: new Date(Date.now() + CONFIG.app.trialDays * 24 * 60 * 60 * 1000),
        },
      })
    }

    // Create default GlobalConfig if not present
    if (!await db.globalConfig.findUnique({ where: { userId: user.id } })) {
      await db.globalConfig.create({ data: { userId: user.id } })
    }

    // Create the session and get the token back
    const sessionToken = await setSessionCookie(user.id)

    // Store the Discord OAuth tokens in that session
    if (sessionToken) {
      await db.session.update({
        where: { token: sessionToken },
        data: {
          discordAccessToken: tokens.access_token,
          discordRefreshToken: tokens.refresh_token,
          discordTokenExpiresAt: new Date(Date.now() + (tokens.expires_in || 604800) * 1000),
        },
      })
    }

    // ─────────────────────────────────────────────────────────────────────
    // Run syncSubscriptionState on login — ensures any expired subscription
    // is immediately detected and suspended, so the user sees the Suspended
    // Page on their very next dashboard load (not the normal dashboard).
    // This also stops any RPC services that were left running.
    // ─────────────────────────────────────────────────────────────────────
    try {
      await syncSubscriptionState(user.id)
    } catch (e) {
      console.error('syncSubscriptionState error on login (non-fatal):', e)
    }

    // Redirect through Vercel's /set-session route so the session cookie is
    // set on Vercel's domain (where the browser lives).
    // Render can't set cookies for Vercel's domain, so we pass the token via URL.
    const frontendUrl = CONFIG.app.url
    return NextResponse.redirect(`${frontendUrl}/set-session?token=${encodeURIComponent(sessionToken)}`)
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown_error'
    return NextResponse.redirect(`${CONFIG.app.url}/?error=${encodeURIComponent(msg)}`)
  }
}

// 10X RPC — Discord OAuth2 with PKCE
import crypto from 'crypto'
import { CONFIG } from './config'

function base64url(buf: Buffer | string): string {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  return b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function generatePkce() {
  const verifier = base64url(crypto.randomBytes(32))
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest())
  return { verifier, challenge }
}

export function buildAuthorizeUrl(state: string, challenge: string, redirectUri?: string) {
  const params = new URLSearchParams({
    client_id: CONFIG.discord.clientId,
    redirect_uri: redirectUri || CONFIG.discord.redirectUri,
    response_type: 'code',
    scope: CONFIG.discord.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    prompt: 'consent',
  })
  return `${CONFIG.discord.authorizeUrl}?${params.toString()}`
}

export interface TokenResponse {
  access_token: string
  token_type: string
  expires_in: number
  refresh_token: string
  scope: string
}

export async function exchangeCode(code: string, verifier: string, redirectUri?: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    client_id: CONFIG.discord.clientId,
    client_secret: CONFIG.discord.clientSecret,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri || CONFIG.discord.redirectUri,
    code_verifier: verifier,
  })
  const res = await fetch(CONFIG.discord.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token exchange failed: ${res.status} ${text}`)
  }
  return res.json()
}

export interface DiscordUser {
  id: string
  username: string
  discriminator: string
  avatar: string | null
  email?: string
}

export async function fetchDiscordUser(accessToken: string): Promise<DiscordUser> {
  const res = await fetch(`${CONFIG.discord.apiBase}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!res.ok) throw new Error(`Failed to fetch Discord user: ${res.status}`)
  return res.json()
}

export function avatarUrl(user: { id: string; avatar: string | null; discriminator: string }) {
  if (user.avatar) {
    const ext = user.avatar.startsWith('a_') ? 'gif' : 'png'
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.${ext}?size=256`
  }
  // Default avatar based on discriminator
  const idx = Number(user.discriminator) % 5
  return `https://cdn.discordapp.com/embed/avatars/${idx}.png`
}

// 10X RPC — Session management with signed HMAC cookies
import { cookies } from 'next/headers'
import crypto from 'crypto'
import { db } from './db'
import { CONFIG } from './config'

const COOKIE_NAME = CONFIG.session.cookieName
const SECRET = CONFIG.session.secret

function sign(payload: string): string {
  return crypto.createHmac('sha256', SECRET).update(payload).digest('base64url')
}

export function createSessionToken(userId: string): string {
  const raw = `${userId}.${Date.now()}.${crypto.randomBytes(16).toString('hex')}`
  const sig = sign(raw)
  return `${raw}.${sig}`
}

export function verifySessionToken(token: string): { userId: string; ok: boolean } {
  try {
    const parts = token.split('.')
    if (parts.length !== 4) return { userId: '', ok: false }
    const raw = `${parts[0]}.${parts[1]}.${parts[2]}`
    const sig = parts[3]
    const expected = sign(raw)
    if (sig !== expected) return { userId: '', ok: false }
    const userId = parts[0]
    return { userId, ok: true }
  } catch {
    return { userId: '', ok: false }
  }
}

export async function getSession() {
  try {
    const cookieStore = await cookies()
    const token = cookieStore.get(COOKIE_NAME)?.value
    if (!token) return null
    const { userId, ok } = verifySessionToken(token)
    if (!ok || !userId) return null

    // Retry up to 3 times in case Neon Postgres compute is waking up (P1001)
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const session = await db.session.findFirst({
          where: { userId, token, expiresAt: { gt: new Date() } },
          include: { user: true },
        })
        return session || null
      } catch (err: any) {
        const isConnectionError = err?.code === 'P1001' || err?.message?.includes('database') || err?.message?.includes('reach')
        if (isConnectionError && attempt < 3) {
          await new Promise(r => setTimeout(r, 600 * attempt))
          continue
        }
        console.error('getSession error:', err)
        return null
      }
    }
    return null
  } catch (e) {
    console.error('getSession cookie error:', e)
    return null
  }
}

export async function setSessionCookie(userId: string) {
  const cookieStore = await cookies()
  const token = createSessionToken(userId)
  const expiresAt = new Date(Date.now() + CONFIG.session.ttlDays * 24 * 60 * 60 * 1000)
  cookieStore.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  })
  await db.session.create({
    data: { userId, token, expiresAt },
  })
  return token
}

export async function clearSessionCookie() {
  const cookieStore = await cookies()
  const token = cookieStore.get(COOKIE_NAME)?.value
  if (token) {
    await db.session.deleteMany({ where: { token } }).catch(() => {})
  }
  cookieStore.delete(COOKIE_NAME)
}

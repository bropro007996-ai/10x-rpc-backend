// 10X RPC — Discord app asset uploader
// Uploads custom images to the Discord OAuth application as "assets" via the bot token.
// Returns the asset KEY, which is used as large_image/small_image in RPC activities.
//
// Why: Discord's Gaming SDK gateway does NOT accept raw HTTPS URLs or mp:external/
// for the large_image field — the image is silently dropped (shows blank).
// Only Discord app asset IDs/keys (uploaded via the Developer Portal or this API)
// are displayed. This module automates the 2-step upload:
//   1. POST /applications/{app}/assets/upload → get a Google Cloud Storage upload URL
//   2. PUT the image bytes to that URL
//   3. POST /applications/{app}/assets → register the asset, get its key

import { CONFIG } from './config'

export interface UploadedAsset {
  key: string
  assetId: string
  url: string
}

const UPLOAD_API = `${CONFIG.discord.apiBase}/applications/${CONFIG.discord.clientId}/assets`
const LIST_API = `${CONFIG.discord.apiBase}/applications/${CONFIG.discord.clientId}/assets`

// In-memory cache of already-uploaded asset keys by URL hash (avoids re-uploading)
const assetCache = new Map<string, UploadedAsset>()

/**
 * List all assets currently uploaded to the Discord app.
 */
export async function listAppAssets(): Promise<Array<{ key: string; asset_id: string }>> {
  try {
    const res = await fetch(LIST_API, {
      headers: { Authorization: `Bot ${CONFIG.discord.botToken}` },
    })
    if (!res.ok) return []
    return await res.json()
  } catch {
    return []
  }
}

/**
 * Upload an image to the Discord app and return the asset key.
 * If the URL was already uploaded, returns the cached key (no re-upload).
 *
 * @param imageUrl HTTPS URL of the image to upload
 * @param keyName Optional custom key name (defaults to a hash of the URL)
 */
export async function uploadImageAsAsset(
  imageUrl: string,
  keyName?: string
): Promise<UploadedAsset | null> {
  if (!CONFIG.discord.botToken) return null
  if (!CONFIG.discord.clientId) return null

  const trimmed = imageUrl.trim()
  if (!/^https?:\/\//i.test(trimmed)) return null

  // Cache hit — return existing asset
  const cacheKey = trimmed
  const cached = assetCache.get(cacheKey)
  if (cached) return cached

  const key = keyName || hashUrl(trimmed)

  // Check if an asset with this key already exists (avoids "key already exists" error
  // when the daemon restarts and the in-memory cache is cleared)
  try {
    const listRes = await fetch(LIST_API, {
      headers: { Authorization: `Bot ${CONFIG.discord.botToken}` },
    })
    if (listRes.ok) {
      const existing = await listRes.json()
      const found = existing.find((a: any) => a.key === key)
      if (found) {
        // Ensure the existing asset is public (may have been uploaded as private before the fix)
        if (found.visibility !== 'public') {
          await setAssetPublic(found.key)
        }
        const result: UploadedAsset = {
          key: found.key,
          assetId: found.asset_id,
          url: `https://cdn.discordapp.com/app-assets/${CONFIG.discord.clientId}/${found.asset_id}.png`,
        }
        assetCache.set(cacheKey, result)
        return result
      }
    }
  } catch {
    // Non-fatal — proceed with upload
  }

  try {
    // 1. Download the image
    const imgRes = await fetch(trimmed)
    if (!imgRes.ok) return null
    const imgBuf = Buffer.from(await imgRes.arrayBuffer())
    const contentType = imgRes.headers.get('content-type') || 'image/png'
    const ext = contentType.includes('jpeg') || contentType.includes('jpg')
      ? 'jpg'
      : contentType.includes('gif')
      ? 'gif'
      : 'png'
    const filename = `${key}.${ext}`

    // 2. Request an upload URL from Discord
    const uploadReqRes = await fetch(`${UPLOAD_API}/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${CONFIG.discord.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        filename,
        file_size: imgBuf.length,
        is_public: true,
      }),
    })
    if (!uploadReqRes.ok) return null
    const { upload_url, upload_filename } = await uploadReqRes.json()
    if (!upload_url || !upload_filename) return null

    // 3. Upload the image bytes to Google Cloud Storage
    const putRes = await fetch(upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: imgBuf,
    })
    if (!putRes.ok) return null

    // 4. Register the asset with Discord
    const createRes = await fetch(UPLOAD_API, {
      method: 'POST',
      headers: {
        Authorization: `Bot ${CONFIG.discord.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        key,
        upload_filename,
      }),
    })
    if (!createRes.ok) {
      // If create fails (e.g., key already exists from a race condition),
      // try listing again to find the existing asset
      const listRes2 = await fetch(LIST_API, {
        headers: { Authorization: `Bot ${CONFIG.discord.botToken}` },
      })
      if (listRes2.ok) {
        const existing = await listRes2.json()
        const found = existing.find((a: any) => a.key === key)
        if (found) {
          const result: UploadedAsset = {
            key: found.key,
            assetId: found.asset_id,
            url: `https://cdn.discordapp.com/app-assets/${CONFIG.discord.clientId}/${found.asset_id}.png`,
          }
          assetCache.set(cacheKey, result)
          return result
        }
      }
      return null
    }
    const asset = await createRes.json()

    // 5. Set the asset's visibility to PUBLIC (required for it to display in RPC).
    // Discord defaults bot-uploaded assets to "private" — they won't show in
    // Rich Presence activities until PATCHed to "public".
    await setAssetPublic(asset.key)

    const result: UploadedAsset = {
      key: asset.key,
      assetId: asset.asset_id,
      url: `https://cdn.discordapp.com/app-assets/${CONFIG.discord.clientId}/${asset.asset_id}.png`,
    }

    assetCache.set(cacheKey, result)
    return result
  } catch (e) {
    console.error('[uploadImageAsAsset] Error:', e)
    return null
  }
}

/**
 * Set an asset's visibility to "public" via PATCH.
 * Required for the asset to display in Discord Rich Presence.
 * Uses the asset KEY (not asset_id) in the URL.
 */
async function setAssetPublic(key: string): Promise<boolean> {
  try {
    const res = await fetch(`${UPLOAD_API}/${key}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${CONFIG.discord.botToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ visibility: 'public' }),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Convert an image reference to a Discord-acceptable large_image value.
 *
 * Strategy (in priority order):
 *   1. If it's already a Discord asset ID/key (no http://), return as-is
 *   2. If it's an HTTPS URL, upload it as a Discord app asset and return the ASSET ID (numeric)
 *   3. If upload fails, return null (omit large_image — Discord shows app icon)
 *
 * CRITICAL: Discord's gateway accepts the ASSET ID (numeric string), NOT the asset key.
 * Using the key causes Discord to silently strip the assets block (blank image).
 */
export async function resolveImageToAssetKey(
  image: string | null | undefined
): Promise<string | null> {
  if (!image) return null
  const trimmed = image.trim()
  if (!trimmed) return null

  // Already a Discord asset ID/key or mp:external format
  if (!/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  // HTTPS URL — try uploading as a Discord app asset
  try {
    const asset = await uploadImageAsAsset(trimmed)
    if (asset) {
      // Return the ASSET ID (numeric string) — Discord's gateway requires this, not the key.
      // Using the key causes Discord to silently strip the assets block (image won't show).
      return asset.assetId
    }
  } catch (e) {
    console.error('[resolveImageToAssetKey] Upload failed:', e)
  }

  // Upload failed — fall back to mp:external format (may work on some gateway versions)
  try {
    const b64 = Buffer.from(trimmed).toString('base64url')
    return `mp:external/${b64}`
  } catch {
    return null
  }
}

function hashUrl(url: string): string {
  // Simple hash for the key name (must be alphanumeric + underscores, max 32 chars)
  let hash = 0
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0
  }
  return `10xrpc_${Math.abs(hash).toString(36).substring(0, 12)}`
}

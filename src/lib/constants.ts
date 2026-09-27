// 10X RPC — Platform and status constants

export interface PlatformOption {
  value: string
  label: string
  description: string
  group: string
  emoji: string
}

export const PLATFORMS: PlatformOption[] = [
  { value: 'console', label: 'Console', description: 'Console session (generic)', group: 'Console', emoji: '🎮' },
  { value: 'xbox', label: 'Xbox', description: 'Xbox integration badge', group: 'Console', emoji: '🎮' },
  { value: 'ps4', label: 'PlayStation 4', description: 'PS4 integration badge', group: 'Console', emoji: '🎮' },
  { value: 'ps5', label: 'PlayStation 5', description: 'PS5 integration badge', group: 'Console', emoji: '🎮' },
  { value: 'embedded', label: 'Embedded', description: 'Embedded session', group: 'VR & Embedded', emoji: '🥽' },
  { value: 'meta_quest', label: 'Meta Quest', description: 'Meta Quest VR session — shows VR headset icon', group: 'VR & Embedded', emoji: '🥽' },
]

export const PLATFORM_GROUPS = ['Console', 'VR & Embedded']

export interface ActivityType {
  value: number
  label: string
}

export const ACTIVITY_TYPES: ActivityType[] = [
  { value: 0, label: 'PLAYING' },
  { value: 1, label: 'STREAMING' },
  { value: 2, label: 'LISTENING' },
  { value: 3, label: 'WATCHING' },
  { value: 5, label: 'COMPETING' },
]

export interface DiscordStatus {
  value: string
  label: string
  color: string
  emoji: string
}

export const DISCORD_STATUSES: DiscordStatus[] = [
  { value: 'online', label: 'Online', color: 'bg-green-500', emoji: '🟢' },
  { value: 'idle', label: 'Idle', color: 'bg-yellow-500', emoji: '🟡' },
  { value: 'dnd', label: 'Do Not Disturb', color: 'bg-red-500', emoji: '🔴' },
  { value: 'invisible', label: 'Invisible', color: 'bg-gray-500', emoji: '⚫' },
]

export function platformByValue(value: string) {
  return PLATFORMS.find(p => p.value === value)
}

export const PLATFORM_FALLBACK_NAMES: Record<string, string> = {
  meta_quest: 'Meta Quest',
  xbox: 'Xbox',
  ps4: 'PlayStation 4',
  ps5: 'PlayStation 5',
  console: 'Console',
  embedded: 'Embedded',
  mobile: 'Mobile',
  ios: 'iOS',
  android: 'Android',
  samsung: 'Samsung',
  web: 'Web',
  desktop: '10X RPC',
  none: '10X RPC',
}

/**
 * Get fallback activity name for a platform when NAME field is empty or contains no valid name.
 */
export function getPlatformFallbackName(platform?: string | null): string {
  if (!platform) return '10X RPC'
  const key = platform.toLowerCase().trim()
  if (PLATFORM_FALLBACK_NAMES[key]) {
    return PLATFORM_FALLBACK_NAMES[key]
  }
  const match = PLATFORMS.find(p => p.value.toLowerCase() === key)
  if (match) return match.label
  return '10X RPC'
}

/**
 * Resolve the visible Activity/Application name:
 * Always prioritize custom NAME. Only if NAME is empty or contains no valid name,
 * fallback to the platform name.
 */
export function resolveRpcActivityName(name?: string | null, platform?: string | null): string {
  const trimmed = name?.trim()
  if (trimmed && trimmed.length > 0) {
    return trimmed
  }
  return getPlatformFallbackName(platform)
}

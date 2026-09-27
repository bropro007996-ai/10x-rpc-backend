// 10X RPC — Dynamic placeholder engine
// Supports: {time}, {time_12h}, {time_bold}, {time_emoji}, {date}, {date_bold},
//           {weather}, {weather_emoji}, {temp}, {city}, {uptime}, {countdown:HH:MM},
//           {day}, {month}, {year}

import { fetchWeather, type WeatherInfo } from './weather'

export interface PlaceholderContext {
  timezone: string
  city?: string
  rpcStartedAt: number // ms timestamp
}

export async function resolvePlaceholders(text: string, ctx: PlaceholderContext): Promise<string> {
  if (!text) return text
  let out = text
  const now = new Date()

  // Time-based — formatted in user's timezone
  const timeStr = formatInTz(now, ctx.timezone, 'HH:mm')
  const time12h = formatInTz(now, ctx.timezone, 'hh:mm a')
  const dateStr = formatInTz(now, ctx.timezone, 'MM/dd/yyyy')
  const day = formatInTz(now, ctx.timezone, 'dd')
  const month = formatInTz(now, ctx.timezone, 'MM')
  const year = formatInTz(now, ctx.timezone, 'yyyy')

  out = out.replaceAll('{time}', timeStr)
  out = out.replaceAll('{time_12h}', time12h)
  out = out.replaceAll('{time_bold}', `**${timeStr}**`)
  out = out.replaceAll('{time_emoji}', timeEmoji(now, ctx.timezone))
  out = out.replaceAll('{date}', dateStr)
  out = out.replaceAll('{date_bold}', `**${dateStr}**`)
  out = out.replaceAll('{day}', day)
  out = out.replaceAll('{month}', month)
  out = out.replaceAll('{year}', year)

  // Uptime
  const uptimeMs = Date.now() - ctx.rpcStartedAt
  out = out.replaceAll('{uptime}', formatUptime(uptimeMs))

  // Countdown: {countdown:HH:MM} → "Xh Ym left"
  out = out.replace(/\{countdown:(\d{2}):(\d{2})\}/g, (_m, hStr, mStr) => {
    const targetH = Number(hStr)
    const targetM = Number(mStr)
    const nowInTz = toTzDate(now, ctx.timezone)
    const target = new Date(nowInTz)
    target.setHours(targetH, targetM, 0, 0)
    if (target.getTime() < Date.now()) target.setDate(target.getDate() + 1)
    const diff = target.getTime() - Date.now()
    const totalMins = Math.floor(diff / 60000)
    const hoursLeft = Math.floor(totalMins / 60)
    const minsLeft = totalMins % 60
    return `${hoursLeft}h ${minsLeft}m left`
  })

  // Weather-based (only if city is configured)
  if (/{weather}|{weather_emoji}|{temp}|{city}/.test(out) && ctx.city) {
    const w = await fetchWeather(ctx.city)
    if (w) {
      out = out.replaceAll('{weather}', w.condition)
      out = out.replaceAll('{weather_emoji}', w.emoji)
      out = out.replaceAll('{temp}', `${w.tempC}°C`)
      out = out.replaceAll('{city}', w.city)
    } else {
      out = out.replaceAll('{weather}', 'Unknown')
      out = out.replaceAll('{weather_emoji}', '🌡️')
      out = out.replaceAll('{temp}', 'N/A')
      out = out.replaceAll('{city}', ctx.city)
    }
  }

  return out
}

function timeEmoji(now: Date, tz: string): string {
  const hour = Number(formatInTz(now, tz, 'HH'))
  if (hour >= 6 && hour < 18) return '☀️'
  return '🌙'
}

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  const s = totalSec % 60
  return `${m}m ${s}s`
}

function toTzDate(date: Date, tz: string): Date {
  // Convert a Date to the equivalent local time in the given IANA tz.
  // Simple approach: use Intl and re-parse.
  const opts: Intl.DateTimeFormatOptions = {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }
  const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(date)
  const get = (type: string) => parts.find(p => p.type === type)?.value || '00'
  const iso = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`
  return new Date(iso)
}

function formatInTz(date: Date, tz: string, pattern: string): string {
  // Simple pattern replacement (HH, hh, mm, a, yyyy, MM, dd)
  const d = toTzDate(date, tz)
  const HH = String(d.getHours()).padStart(2, '0')
  let hh = d.getHours() % 12
  if (hh === 0) hh = 12
  const hhStr = String(hh).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const a = d.getHours() < 12 ? 'AM' : 'PM'
  const yyyy = d.getFullYear()
  const MM = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return pattern
    .replace('yyyy', String(yyyy))
    .replace('MM', MM)
    .replace('dd', dd)
    .replace('HH', HH)
    .replace('hh', hhStr)
    .replace('mm', mm)
    .replace('a', a)
}

export const PLACEHOLDER_CHEAT_SHEET = [
  { token: '{time}', desc: 'Current time (24hr e.g. 14:35)' },
  { token: '{time_12h}', desc: 'Current time (12hr e.g. 2:35 PM)' },
  { token: '{time_bold}', desc: 'Bold time (e.g. **14:35**)' },
  { token: '{time_emoji}', desc: 'Dynamic day/night emoji (e.g. ☀️, 🌙)' },
  { token: '{date}', desc: 'Current date (MM/DD/YYYY)' },
  { token: '{date_bold}', desc: 'Bold date (e.g. **05/07/2026**)' },
  { token: '{weather}', desc: 'Current weather condition (e.g. Clear, Sunny)' },
  { token: '{weather_emoji}', desc: 'Weather based emoji (e.g. ☀️, 🌧️)' },
  { token: '{temp}', desc: 'Temperature only (e.g. 28°C)' },
  { token: '{city}', desc: 'Your configured city' },
  { token: '{uptime}', desc: 'Time since RPC started (e.g. 2h 15m)' },
  { token: '{countdown:HH:MM}', desc: 'Countdown relative to start (e.g. {countdown:02:44} → "2h 44m left")' },
  { token: '{day}', desc: 'Day of month (01-31)' },
  { token: '{month}', desc: 'Month (01-12)' },
  { token: '{year}', desc: 'Year (e.g. 2026)' },
]

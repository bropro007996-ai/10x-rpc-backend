// 10X RPC — Weather engine (Open-Meteo, no API key needed)
import { CONFIG } from './config'

export interface WeatherInfo {
  tempC: number
  condition: string // "Clear", "Sunny", "Partly cloudy", "Rain", "Snow", etc.
  emoji: string
  city: string
  fetchedAt: number
}

const weatherCache = new Map<string, WeatherInfo>()

export async function geocode(city: string): Promise<{ lat: number; lon: number; name: string } | null> {
  const url = `${CONFIG.weather.geocodeUrl}?name=${encodeURIComponent(city)}&count=1&language=en&format=json`
  const res = await fetch(url)
  if (!res.ok) return null
  const json = await res.json()
  const hit = json?.results?.[0]
  if (!hit) return null
  return { lat: hit.latitude, lon: hit.longitude, name: hit.name }
}

export async function fetchWeather(city: string): Promise<WeatherInfo | null> {
  const key = city.toLowerCase().trim()
  const cached = weatherCache.get(key)
  // Cache for 10 minutes
  if (cached && Date.now() - cached.fetchedAt < 10 * 60 * 1000) return cached

  const geo = await geocode(city)
  if (!geo) return null

  const url = `${CONFIG.weather.forecastUrl}?latitude=${geo.lat}&longitude=${geo.lon}&current=temperature_2m,weather_code&timezone=auto`
  const res = await fetch(url)
  if (!res.ok) return null
  const json = await res.json()
  const temp = json?.current?.temperature_2m
  const code = json?.current?.weather_code
  if (typeof temp !== 'number' || typeof code !== 'number') return null

  const condition = weatherCodeToText(code)
  const emoji = weatherCodeToEmoji(code)
  const info: WeatherInfo = {
    tempC: Math.round(temp),
    condition,
    emoji,
    city: geo.name,
    fetchedAt: Date.now(),
  }
  weatherCache.set(key, info)
  return info
}

function weatherCodeToText(code: number): string {
  // WMO weather codes — https://open-meteo.com/en/docs
  if (code === 0) return 'Clear'
  if (code <= 3) return 'Partly cloudy'
  if (code <= 48) return 'Foggy'
  if (code <= 57) return 'Drizzle'
  if (code <= 67) return 'Rain'
  if (code <= 77) return 'Snow'
  if (code <= 82) return 'Showers'
  if (code <= 86) return 'Snow showers'
  if (code <= 99) return 'Thunderstorm'
  return 'Unknown'
}

function weatherCodeToEmoji(code: number): string {
  if (code === 0) return '☀️'
  if (code <= 3) return '⛅'
  if (code <= 48) return '🌫️'
  if (code <= 57) return '🌦️'
  if (code <= 67) return '🌧️'
  if (code <= 77) return '❄️'
  if (code <= 82) return '🌧️'
  if (code <= 86) return '🌨️'
  if (code <= 99) return '⛈️'
  return '🌡️'
}

// 10X RPC — Game presets catalog
// Each game has a slug, name, default largeImage (Discord asset ID or URL),
// default state/details text, default platform, and a search tag list.

export interface GamePreset {
  slug: string
  name: string
  largeImage: string
  iconUrl?: string
  largeText: string
  defaultState: string
  defaultDetails: string
  defaultPlatform: string
  defaultPartyMax: number
  defaultPartyCurrent: number
  defaultEndTotalMins: number | null
  tags: string[]
}

export const GAME_PRESETS: GamePreset[] = [
  {
    slug: 'minecraft',
    name: 'Minecraft',
    largeImage: 'minecraft',
    iconUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/minecraft.png',
    largeText: 'Minecraft',
    defaultState: 'Mining diamonds',
    defaultDetails: 'Survival Mode',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 1,
    defaultPartyMax: 8,
    defaultEndTotalMins: null,
    tags: ['minecraft', 'sandbox', 'block game'],
  },
  {
    slug: 'genshin-impact',
    name: 'Genshin Impact',
    largeImage: 'genshin',
    iconUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/genshin-impact.png',
    largeText: 'Genshin Impact',
    defaultState: 'Exploring Teyvat',
    defaultDetails: 'Adventure Rank 55',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 1,
    defaultPartyMax: 4,
    defaultEndTotalMins: null,
    tags: ['genshin', 'impact', 'genshin impact', 'gacha', 'arpg'],
  },
  {
    slug: 'wuthering-waves',
    name: 'Wuthering Waves',
    largeImage: 'wuthering-waves',
    iconUrl: 'https://cdn2.steamgriddb.com/icon/41c6999335f639a0fa578c772e0980c6/32/256x256.png',
    largeText: 'Wuthering Waves',
    defaultState: 'Echo hunting',
    defaultDetails: 'Union Level 40',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 1,
    defaultPartyMax: 4,
    defaultEndTotalMins: null,
    tags: ['wuthering waves', 'wuwa', 'gacha'],
  },
  {
    slug: 'forza-horizon-5',
    name: 'Forza Horizon 5',
    largeImage: 'forza',
    iconUrl: 'https://cdn.cloudflare.steamstatic.com/steam/apps/1551360/header.jpg',
    largeText: 'Forza Horizon 5',
    defaultState: 'Racing in Mexico',
    defaultDetails: 'Online Adventure',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 1,
    defaultPartyMax: 12,
    defaultEndTotalMins: 30,
    tags: ['forza', 'horizon', 'racing', 'forza horizon 5'],
  },
  {
    slug: 'arknights',
    name: 'Arknights',
    largeImage: 'arknights',
    iconUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/arknights.png',
    largeText: 'Arknights',
    defaultState: 'Farming Annihilation',
    defaultDetails: 'Sanity: 135/135',
    defaultPlatform: 'android',
    defaultPartyCurrent: 1,
    defaultPartyMax: 1,
    defaultEndTotalMins: null,
    tags: ['arknights', 'tower defense', 'gacha'],
  },
  {
    slug: 'valorant',
    name: 'Valorant',
    largeImage: 'valorant',
    iconUrl: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/valorant.png',
    largeText: 'Valorant',
    defaultState: 'Competitive Match',
    defaultDetails: 'Rank: Diamond III',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 3,
    defaultPartyMax: 5,
    defaultEndTotalMins: 45,
    tags: ['valorant', 'fps', 'shooter', 'riot'],
  },
  {
    slug: 'gta-v',
    name: 'Grand Theft Auto V',
    largeImage: 'gtav',
    iconUrl: 'https://cdn.cloudflare.steamstatic.com/steam/apps/271590/header.jpg',
    largeText: 'GTA V',
    defaultState: 'Heisting in Los Santos',
    defaultDetails: 'Online',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 2,
    defaultPartyMax: 4,
    defaultEndTotalMins: 60,
    tags: ['gta', 'gta v', 'gta 5', 'grand theft auto'],
  },
  {
    slug: 'gtaiii',
    name: 'GTAIII',
    largeImage: 'gtaiii',
    iconUrl: 'https://cdn.cloudflare.steamstatic.com/steam/apps/12100/header.jpg',
    largeText: 'GTAIII',
    defaultState: 'In a Match',
    defaultDetails: 'Ranked Mode',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 1,
    defaultPartyMax: 5,
    defaultEndTotalMins: 30,
    tags: ['gta', 'gtaiii', 'gta 3', 'gta iii', 'grand theft auto iii'],
  },
  {
    slug: 'vrchat',
    name: 'VRChat',
    largeImage: 'vrchat',
    iconUrl: 'https://cdn.cloudflare.steamstatic.com/steam/apps/438100/header.jpg',
    largeText: 'VRChat',
    defaultState: 'Hanging out',
    defaultDetails: 'Public World',
    defaultPlatform: 'meta_quest',
    defaultPartyCurrent: 4,
    defaultPartyMax: 30,
    defaultEndTotalMins: null,
    tags: ['vrchat', 'vr', 'social', 'meta quest'],
  },
  {
    slug: 'cs2',
    name: 'Counter-Strike 2',
    largeImage: 'cs2',
    iconUrl: 'https://cdn.cloudflare.steamstatic.com/steam/apps/730/header.jpg',
    largeText: 'CS2',
    defaultState: 'Competitive',
    defaultDetails: 'Premier Mode',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 3,
    defaultPartyMax: 5,
    defaultEndTotalMins: 40,
    tags: ['cs', 'cs2', 'csgo', 'counter strike', 'fps', 'shooter'],
  },
  {
    slug: 'igtap',
    name: 'IGTAP: An Incremental Game That\'s Also a Platformer',
    largeImage: 'igtap',
    iconUrl: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2346660/header.jpg',
    largeText: 'IGTAP',
    defaultState: 'Grinding XP',
    defaultDetails: 'Level 247',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 1,
    defaultPartyMax: 1,
    defaultEndTotalMins: null,
    tags: ['igtap', 'incremental', 'platformer'],
  },
  {
    slug: 'ragtag-heroes',
    name: 'Ragtag Heroes: CO-OP Deckbuilder',
    largeImage: 'ragtag-heroes',
    iconUrl: 'https://cdn.cloudflare.steamstatic.com/steam/apps/2346660/header.jpg',
    largeText: 'Ragtag Heroes',
    defaultState: 'Building deck',
    defaultDetails: 'CO-OP Mode',
    defaultPlatform: 'desktop',
    defaultPartyCurrent: 2,
    defaultPartyMax: 4,
    defaultEndTotalMins: 25,
    tags: ['ragtag', 'heroes', 'deckbuilder', 'coop'],
  },
]

export function findGame(slug: string) {
  return GAME_PRESETS.find(g => g.slug === slug)
}

export function searchGames(query: string): GamePreset[] {
  const q = query.toLowerCase().trim()
  if (!q) return GAME_PRESETS
  return GAME_PRESETS.filter(g => {
    if (g.name.toLowerCase().includes(q)) return true
    return g.tags.some(t => t.includes(q))
  })
}

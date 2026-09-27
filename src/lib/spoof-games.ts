// 10X RPC — Game spoofing catalog
// Each game has a real Discord application_id + CDN icon URL.
// When Games RPC is enabled, the daemon sets activity.application_id to the
// game's app_id — Discord then displays the game's official icon and name.
//
// This is SEPARATE from Normal RPC (which uses CONFIG.discord.clientId).
// Games RPC has its own enable flag (session.gamesRpcEnabled), its own config
// table (GameRpcConfig), and its own API routes (/api/games-rpc/*).

export interface SpoofGame {
  slug: string
  app_id: string
  name: string
  img: string
  defaultState: string
  defaultDetails: string
  defaultPartyMax: number
  defaultPartyCurrent: number
}

export const SPOOF_GAMES: SpoofGame[] = [
  {
    slug: 'minecraft',
    app_id: '1402418491272986635',
    name: 'Minecraft',
    img: 'https://cdn.discordapp.com/app-icons/1402418491272986635/166fbad351ecdd02d11a3b464748f66b.png?size=240&keep_aspect_ratio=false',
    defaultState: 'Mining diamonds',
    defaultDetails: 'Survival Mode',
    defaultPartyMax: 8,
    defaultPartyCurrent: 1,
  },
  {
    slug: 'genshin',
    app_id: '762434991303950386',
    name: 'Genshin Impact',
    img: 'https://cdn.discordapp.com/app-icons/762434991303950386/eb0e25b739e4fa38c1671a3d1edcd1e0.png?size=240&keep_aspect_ratio=false',
    defaultState: 'Exploring Teyvat',
    defaultDetails: 'Adventure Rank 55',
    defaultPartyMax: 4,
    defaultPartyCurrent: 1,
  },
  {
    slug: 'wuthering_waves',
    app_id: '1247227126416146462',
    name: 'Wuthering Waves',
    img: '/game-icons/wuthering-waves.png',
    defaultState: 'Echo hunting',
    defaultDetails: 'Union Level 40',
    defaultPartyMax: 4,
    defaultPartyCurrent: 1,
  },
  {
    slug: 'forza_horizon_5',
    app_id: '905961880789590076',
    name: 'Forza Horizon 5',
    img: 'https://cdn.discordapp.com/app-icons/905961880789590076/229e83c3817d45ecabdaa2f343eadd34.png?size=240&keep_aspect_ratio=false',
    defaultState: 'Racing in Mexico',
    defaultDetails: 'Online Adventure',
    defaultPartyMax: 12,
    defaultPartyCurrent: 1,
  },
  {
    slug: 'arknights_endfield',
    app_id: '1461154307171811401',
    name: 'Arknights:Endfield',
    img: 'https://cdn.discordapp.com/app-icons/1461154307171811401/a1c43f46f274856e6fb9edc8afda149d.png?size=240&keep_aspect_ratio=false',
    defaultState: 'Farming Annihilation',
    defaultDetails: 'Sanity: 135/135',
    defaultPartyMax: 1,
    defaultPartyCurrent: 1,
  },
  {
    slug: 'valorant',
    app_id: '700136079562375258',
    name: 'Valorant',
    img: 'https://cdn.discordapp.com/app-icons/700136079562375258/e55fc8259df1548328f977d302779ab7.png?size=240&keep_aspect_ratio=false',
    defaultState: 'Competitive Match',
    defaultDetails: 'Rank: Diamond III',
    defaultPartyMax: 5,
    defaultPartyCurrent: 3,
  },
  {
    slug: 'gta5',
    app_id: '1402418714716143646',
    name: 'GTA5',
    img: 'https://cdn.discordapp.com/app-icons/1402418714716143646/b77111108195cd5e4dd2011dd39bf67d.png?size=240&keep_aspect_ratio=false',
    defaultState: 'Heisting in Los Santos',
    defaultDetails: 'Online',
    defaultPartyMax: 4,
    defaultPartyCurrent: 2,
  },
  {
    slug: 'vrchat',
    app_id: '398632010442211348',
    name: 'VRChat',
    img: 'https://cdn.discordapp.com/app-icons/398632010442211348/5881acfa9405ee69158591ec1a791c74.png?size=240&keep_aspect_ratio=false',
    defaultState: 'Hanging out',
    defaultDetails: 'Public World',
    defaultPartyMax: 30,
    defaultPartyCurrent: 4,
  },
  {
    slug: 'cs2',
    app_id: '1158877933042143272',
    name: 'Counter-Strike 2',
    img: 'https://cdn.discordapp.com/app-icons/1158877933042143272/558f5a26ecb3b17c3dea3d15c1df537a.png?size=80&keep_aspect_ratio=false',
    defaultState: 'Competitive',
    defaultDetails: 'Premier Mode',
    defaultPartyMax: 5,
    defaultPartyCurrent: 3,
  },
]

export function findSpoofGame(slug: string): SpoofGame | undefined {
  return SPOOF_GAMES.find(g => g.slug === slug)
}

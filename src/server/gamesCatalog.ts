import { GameCategory, SupportedGame, LaunchAuthorizationResponse } from '../types.js';
import { firestoreRepo } from './firestoreRepository.js';

export const INITIAL_GAMES_CATALOG: SupportedGame[] = [
  {
    id: 'game_free_fire',
    name: 'Free Fire',
    packageId: 'com.dts.freefireth',
    category: 'Battle Royale',
    iconUrl: '/images/freefire.jpg',
    bannerUrl: '/images/freefire.jpg',
    description: 'Fast-paced 50-player battle royale with 10-minute survivability matches.',
    launchMethod: 'android_intent',
    intentUri: 'intent://#Intent;package=com.dts.freefireth;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;end',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.dts.freefireth',
    installationStatus: 'unknown',
    verifiedLaunch: true,
  },
  {
    id: 'game_codm',
    name: 'Call of Duty: Mobile',
    packageId: 'com.activision.callofduty.shooter',
    category: 'Shooter',
    iconUrl: '/images/codm.jpg',
    bannerUrl: '/images/codm.jpg',
    description: 'Iconic multiplayer combat, maps, and high-intensity battle royale gameplay.',
    launchMethod: 'android_intent',
    intentUri: 'intent://#Intent;package=com.activision.callofduty.shooter;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;end',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.activision.callofduty.shooter',
    installationStatus: 'unknown',
    verifiedLaunch: true,
  },
  {
    id: 'game_pubg_mobile',
    name: 'PUBG MOBILE',
    packageId: 'com.tencent.ig',
    category: 'Battle Royale',
    iconUrl: '/images/pubg.jpg',
    bannerUrl: '/images/pubg.jpg',
    description: 'Original battle royale mobile game with dynamic weather, 8x8 km maps, and tactical vehicles.',
    launchMethod: 'android_intent',
    intentUri: 'intent://#Intent;package=com.tencent.ig;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;end',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.tencent.ig',
    installationStatus: 'unknown',
    verifiedLaunch: true,
  },
  {
    id: 'game_mobile_legends',
    name: 'Mobile Legends: Bang Bang',
    packageId: 'com.mobile.legends',
    category: 'MOBA',
    iconUrl: '/images/mobile_legends.jpg',
    bannerUrl: '/images/mobile_legends.jpg',
    description: 'Classic 5v5 MOBA showdowns with 10-second matchmaking and 10-minute battles.',
    launchMethod: 'android_intent',
    intentUri: 'intent://#Intent;package=com.mobile.legends;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;end',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.mobile.legends',
    installationStatus: 'unknown',
    verifiedLaunch: true,
  },
  {
    id: 'game_fifa_mobile',
    name: 'EA SPORTS FC Mobile',
    packageId: 'com.ea.gp.fifamobile',
    category: 'Sports & Racing',
    iconUrl: '/images/fifa.jpg',
    bannerUrl: '/images/fifa.jpg',
    description: 'Compete in head-to-head football with authentic licenses, teams, and tournament modes.',
    launchMethod: 'android_intent',
    intentUri: 'intent://#Intent;package=com.ea.gp.fifamobile;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;end',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.ea.gp.fifamobile',
    installationStatus: 'unknown',
    verifiedLaunch: true,
  },
  {
    id: 'game_asphalt_9',
    name: 'Asphalt 9: Legends',
    packageId: 'com.gameloft.android.ANMP.GloftA9HM',
    category: 'Sports & Racing',
    iconUrl: '/images/asphalt9.jpg',
    bannerUrl: '/images/asphalt9.jpg',
    description: 'Tear up the asphalt in hyper-cars through hyper-realistic international locations.',
    launchMethod: 'android_intent',
    intentUri: 'intent://#Intent;package=com.gameloft.android.ANMP.GloftA9HM;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;end',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.gameloft.android.ANMP.GloftA9HM',
    installationStatus: 'unknown',
    verifiedLaunch: true,
  },
  {
    id: 'game_brawl_stars',
    name: 'Brawl Stars',
    packageId: 'com.supercell.brawlstars',
    category: 'Shooter',
    iconUrl: '/images/brawl_stars.jpg',
    bannerUrl: '/images/brawl_stars.jpg',
    description: 'Fast 3v3 multiplayer and battle royale combat with unique character special abilities.',
    launchMethod: 'android_intent',
    intentUri: 'intent://#Intent;package=com.supercell.brawlstars;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;end',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.supercell.brawlstars',
    installationStatus: 'unknown',
    verifiedLaunch: true,
  },
  {
    id: 'game_genshin_impact',
    name: 'Genshin Impact',
    packageId: 'com.miHoYo.GenshinImpact',
    category: 'Action & RPG',
    iconUrl: '/images/genshin.jpg',
    bannerUrl: '/images/genshin.jpg',
    description: 'Vast open-world action RPG featuring elemental combat reactions and cooperative multiplayer.',
    launchMethod: 'android_intent',
    intentUri: 'intent://#Intent;package=com.miHoYo.GenshinImpact;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;end',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.miHoYo.GenshinImpact',
    installationStatus: 'unknown',
    verifiedLaunch: true,
  },
  {
    id: 'game_shadow_fight_4',
    name: 'Shadow Fight 4: Arena',
    packageId: 'com.nekki.shadowfightarena',
    category: 'Action & RPG',
    iconUrl: '/images/shadow_fight.jpg',
    bannerUrl: '/images/shadow_fight.jpg',
    description: 'Real-time 3D PvP fighting arena with legendary heroes, abilities, and combos.',
    launchMethod: 'android_intent',
    intentUri: 'intent://#Intent;package=com.nekki.shadowfightarena;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;end',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=com.nekki.shadowfightarena',
    installationStatus: 'unknown',
    verifiedLaunch: true,
  },
  {
    id: 'game_efootball',
    name: 'eFootball 2026',
    packageId: 'jp.konami.pesam',
    category: 'Sports & Racing',
    iconUrl: '/images/efootball.jpg',
    bannerUrl: '/images/efootball.jpg',
    description: 'Experience revolutionary football simulation with realistic ball physics and tactics.',
    launchMethod: 'android_intent',
    intentUri: 'intent://#Intent;package=jp.konami.pesam;action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;end',
    playStoreUrl: 'https://play.google.com/store/apps/details?id=jp.konami.pesam',
    installationStatus: 'unknown',
    verifiedLaunch: true,
  }
];

class GamesCatalogService {
  private games: Map<string, SupportedGame> = new Map();
  private userCustomGames: Map<string, SupportedGame[]> = new Map();
  private recentlyPlayed: Map<string, string[]> = new Map(); // userId -> gameIds[]

  constructor() {
    INITIAL_GAMES_CATALOG.forEach((g) => this.games.set(g.id, { ...g }));
  }

  // Get all games with optional search filter and category
  public getAllGames(userId?: string, query?: string, category?: string): SupportedGame[] {
    const list: SupportedGame[] = Array.from(this.games.values());

    // Merge in user custom games
    if (userId && this.userCustomGames.has(userId)) {
      const customs = this.userCustomGames.get(userId) || [];
      customs.forEach((cg) => {
        if (!list.some((existing) => existing.id === cg.id)) {
          list.push(cg);
        }
      });
    }

    return list.filter((game) => {
      // Category filter
      if (category && category !== 'All') {
        if (category === 'Custom' && !game.isCustom) return false;
        if (category !== 'Custom' && game.category !== category) return false;
      }

      // Query filter
      if (query && query.trim().length > 0) {
        const q = query.toLowerCase().trim();
        const matchesName = game.name.toLowerCase().includes(q);
        const matchesPkg = game.packageId.toLowerCase().includes(q);
        const matchesDesc = game.description.toLowerCase().includes(q);
        const matchesCat = game.category.toLowerCase().includes(q);
        return matchesName || matchesPkg || matchesDesc || matchesCat;
      }

      return true;
    });
  }

  public getGameById(id: string): SupportedGame | null {
    return this.games.get(id) || null;
  }

  // Add custom game entry
  public addCustomGame(userId: string, input: Partial<SupportedGame>): SupportedGame {
    if (!input.name || input.name.trim().length < 2) {
      throw new Error('Game name is required (min 2 characters)');
    }

    const packageId = (input.packageId || '').trim();
    if (!packageId || !/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(packageId)) {
      throw new Error('Valid Android package name is required (e.g. com.developer.gamename)');
    }

    const customId = `custom_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const newGame: SupportedGame = {
      id: customId,
      name: input.name.trim(),
      packageId,
      category: input.category || 'Custom',
      iconUrl: input.iconUrl || 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=150&auto=format&fit=crop&q=80',
      bannerUrl: input.bannerUrl || 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=800&auto=format&fit=crop&q=80',
      description: input.description || 'User-added custom mobile game entry.',
      launchMethod: 'android_intent',
      intentUri: `intent://#Intent;package=${packageId};action=android.intent.action.MAIN;category=android.intent.category.LAUNCHER;end`,
      playStoreUrl: `https://play.google.com/store/apps/details?id=${packageId}`,
      installationStatus: 'unknown',
      isCustom: true,
      addedBy: userId,
      verifiedLaunch: false,
    };

    this.games.set(newGame.id, newGame);

    const userList = this.userCustomGames.get(userId) || [];
    userList.push(newGame);
    this.userCustomGames.set(userId, userList);

    return newGame;
  }

  // Stage 3 Match Opportunity Authorization: Launch uses an existing available opportunity without secondary debit
  public async authorizeGameLaunch(
    userId: string,
    gameId: string,
    opportunityId?: string
  ): Promise<LaunchAuthorizationResponse> {
    const game = this.getGameById(gameId);
    if (!game) {
      return {
        authorized: false,
        error: `Game ID '${gameId}' was not found in the universal library.`,
      };
    }

    try {
      // Server-authoritative match opportunity check & transition
      const result = await firestoreRepo.launchOpportunity(userId, game.id, opportunityId);

      // Record as recently played
      this.recordRecentlyPlayed(userId, game.id);

      return {
        authorized: true,
        gameId: game.id,
        gameName: game.name,
        opportunityId: result.opportunity.id,
        opportunityStatus: result.opportunity.status,
        launchMethod: game.launchMethod,
        launchUri: game.intentUri,
        fallbackUrl: game.playStoreUrl,
        message: result.alreadyLaunched
          ? `Resuming launched match for ${game.name}. Opportunity ID: ${result.opportunity.id}.`
          : `Match opportunity authorized for ${game.name}! One normal match unlocked (Opportunity ID: ${result.opportunity.id}).`,
      };
    } catch (err: any) {
      return {
        authorized: false,
        gameId: game.id,
        gameName: game.name,
        error: err.message || `No available ₦100 match opportunity for ${game.name}. Please purchase an opportunity to play.`,
      };
    }
  }

  // Record recently played
  public recordRecentlyPlayed(userId: string, gameId: string) {
    const list = this.recentlyPlayed.get(userId) || [];
    const filtered = list.filter((id) => id !== gameId);
    filtered.unshift(gameId);
    this.recentlyPlayed.set(userId, filtered.slice(0, 5)); // Keep top 5
  }

  // Get recently played games for user
  public getRecentlyPlayed(userId: string): SupportedGame[] {
    const ids = this.recentlyPlayed.get(userId) || [];
    const games: SupportedGame[] = [];
    ids.forEach((id) => {
      const g = this.getGameById(id);
      if (g) games.push(g);
    });
    return games;
  }
}

export const gamesCatalogService = new GamesCatalogService();

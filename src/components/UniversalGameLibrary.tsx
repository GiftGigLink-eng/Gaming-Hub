import React, { useState, useEffect, useMemo } from 'react';
import {
  Search,
  Plus,
  Play,
  ExternalLink,
  ShieldCheck,
  CheckCircle2,
  HelpCircle,
  XCircle,
  Clock,
  Smartphone,
  Gamepad2,
  RotateCw,
  Sparkles,
  ChevronRight,
  Info,
  Flame,
} from 'lucide-react';
import { GameCategory, InstallationStatus, SupportedGame, GamingSession, MatchOpportunity } from '../types.js';
import { androidBridge } from '../lib/androidBridge.js';
import { authFetch } from '../lib/firebase.js';

interface UniversalGameLibraryProps {
  session?: GamingSession | null;
  opportunities?: MatchOpportunity[];
  walletBalance?: number;
  userId: string;
  onOpenSessionModal?: (gameTitle: string) => void;
  onPurchaseOpportunity: (gameId: string, gameTitle: string) => Promise<void>;
  onOpenAddCustomGame: () => void;
  onOpenAndroidGuide: () => void;
  onGameLaunched?: (gameName: string) => void;
}

export const UniversalGameLibrary: React.FC<UniversalGameLibraryProps> = ({
  session: _session,
  opportunities = [],
  walletBalance: _walletBalance = 0,
  userId,
  onOpenSessionModal,
  onPurchaseOpportunity,
  onOpenAddCustomGame,
  onOpenAndroidGuide,
  onGameLaunched,
}) => {
  const [games, setGames] = useState<SupportedGame[]>([]);
  const [recentlyPlayed, setRecentlyPlayed] = useState<SupportedGame[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<GameCategory | 'Installed'>('All');
  const [isLoading, setIsLoading] = useState(false);
  const [featuredIndex, setFeaturedIndex] = useState(0);

  const [purchasingGameId, setPurchasingGameId] = useState<string | null>(null);
  const [launchingGameId, setLaunchingGameId] = useState<string | null>(null);
  const [activeLaunchModal, setActiveLaunchModal] = useState<SupportedGame | null>(null);
  const [activeDetailsGame, setActiveDetailsGame] = useState<SupportedGame | null>(null);
  const [launchMessage, setLaunchMessage] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [imgErrors, setImgErrors] = useState<Record<string, boolean>>({});

  const categories: (GameCategory | 'Installed')[] = [
    'All',
    'Installed',
    'Battle Royale',
    'Shooter',
    'MOBA',
    'Sports & Racing',
    'Action & RPG',
    'Custom',
  ];

  // Fetch games from server
  const fetchGames = async () => {
    setIsLoading(true);
    try {
      const res = await authFetch('/api/games');
      const data = await res.json();
      if (data.success && data.games) {
        // Hydrate installation status from androidBridge client
        const hydrated = data.games.map((g: SupportedGame) => ({
          ...g,
          installationStatus: androidBridge.getInstallationStatus(g.packageId),
        }));
        setGames(hydrated);
      }
    } catch (err) {
      console.error('Failed to load games catalog:', err);
    } finally {
      setIsLoading(false);
    }
  };

  // Fetch recently played (requires auth)
  const fetchRecent = async () => {
    try {
      const res = await authFetch('/api/games/recent');
      if (res.status === 401) return;
      const data = await res.json();
      if (data.success && data.games) {
        setRecentlyPlayed(data.games);
      }
    } catch (err) {
      console.error('Failed to load recently played games:', err);
    }
  };

  useEffect(() => {
    fetchGames();
    fetchRecent();
  }, [userId]);

  // Filtered games
  const filteredGames = useMemo(() => {
    return games.filter((g) => {
      // Category filter
      if (selectedCategory === 'Installed') {
        if (g.installationStatus !== 'installed') return false;
      } else if (selectedCategory !== 'All') {
        if (selectedCategory === 'Custom' && !g.isCustom) return false;
        if (selectedCategory !== 'Custom' && g.category !== selectedCategory) return false;
      }

      // Query filter
      if (searchQuery.trim().length > 0) {
        const q = searchQuery.toLowerCase().trim();
        const matchesName = g.name.toLowerCase().includes(q);
        const matchesCat = g.category.toLowerCase().includes(q);
        const matchesPkg = g.packageId.toLowerCase().includes(q);
        return matchesName || matchesCat || matchesPkg;
      }

      return true;
    });
  }, [games, selectedCategory, searchQuery]);

  // Featured games list (top 3 games)
  const featuredGames = useMemo(() => {
    return games.slice(0, 3);
  }, [games]);

  const currentFeatured = featuredGames[featuredIndex] || games[0];

  // Find opportunity state for a game
  const getGameOpportunityState = (game: SupportedGame) => {
    const oppAvailable = opportunities.find(
      (o) => (o.gameId === game.id || o.gameTitle?.toLowerCase() === game.name.toLowerCase()) && o.status === 'available'
    );
    if (oppAvailable) return { status: 'available' as const, opp: oppAvailable };

    const oppLaunched = opportunities.find(
      (o) => (o.gameId === game.id || o.gameTitle?.toLowerCase() === game.name.toLowerCase()) && o.status === 'launched'
    );
    if (oppLaunched) return { status: 'launched' as const, opp: oppLaunched };

    return null;
  };

  // Handle Match Opportunity Purchase (₦100)
  const handlePurchase = async (game: SupportedGame) => {
    setLaunchError(null);
    setPurchasingGameId(game.id);
    try {
      if (onPurchaseOpportunity) {
        await onPurchaseOpportunity(game.id, game.name);
      } else if (onOpenSessionModal) {
        onOpenSessionModal(game.name);
      }
    } catch (err: any) {
      setLaunchError(err.message || 'Failed to purchase match opportunity');
    } finally {
      setPurchasingGameId(null);
    }
  };

  // Handle Game Launch (Uses available match opportunity on server)
  const handleLaunchGame = async (game: SupportedGame) => {
    setLaunchError(null);
    const oppState = getGameOpportunityState(game);

    if (!oppState) {
      await handlePurchase(game);
      return;
    }

    setLaunchingGameId(game.id);
    try {
      // 1. Authorize on server using match opportunity (protected by Bearer token)
      const res = await authFetch('/api/games/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gameId: game.id,
        }),
      });

      if (res.status === 401) {
        setLaunchError('Authentication required. Please sign in to launch games.');
        return;
      }

      const data = await res.json();
      if (!data.authorized) {
        setLaunchError(data.error || 'Launch authorization denied');
        return;
      }

      // 2. Dispatch launch via AndroidBridge client
      const launchResult = androidBridge.launchGame(game);
      setLaunchMessage(launchResult.message);
      setActiveLaunchModal(game);
      fetchRecent();
      if (onGameLaunched) onGameLaunched(game.name);
    } catch (err: any) {
      setLaunchError(`Launch error: ${err.message}`);
    } finally {
      setLaunchingGameId(null);
    }
  };

  // Toggle user's manual device installation status
  const handleToggleStatus = (game: SupportedGame) => {
    const nextStatus: Record<InstallationStatus, InstallationStatus> = {
      installed: 'not_installed',
      not_installed: 'unknown',
      unknown: 'installed',
      unsupported: 'unknown',
    };
    const updated = nextStatus[game.installationStatus] || 'installed';
    androidBridge.setInstallationStatus(game.packageId, updated);

    setGames((prev) =>
      prev.map((g) => (g.id === game.id ? { ...g, installationStatus: updated } : g))
    );
    if (activeDetailsGame && activeDetailsGame.id === game.id) {
      setActiveDetailsGame({ ...activeDetailsGame, installationStatus: updated });
    }
  };

  const handleImageError = (id: string) => {
    setImgErrors((prev) => ({ ...prev, [id]: true }));
  };

  return (
    <div className="space-y-6">
      {/* Launch Error Notice */}
      {launchError && (
        <div className="p-3.5 rounded-2xl bg-rose-950/80 border border-rose-800/80 text-rose-200 text-xs flex items-center justify-between shadow-lg">
          <span className="font-semibold">{launchError}</span>
          <button
            type="button"
            onClick={() => setLaunchError(null)}
            className="text-rose-400 font-bold hover:text-white px-2 py-0.5"
            aria-label="Dismiss error"
          >
            ✕
          </button>
        </div>
      )}

      {/* 1. CINEMATIC FEATURED GAME HERO BANNER */}
      {currentFeatured && !searchQuery && selectedCategory === 'All' && (
        <section aria-label="Featured Game" className="relative">
          <div className="relative rounded-3xl overflow-hidden border border-white/[0.08] shadow-2xl bg-[#0E121E] group">
            {/* Background Artwork with Cinematic Vignette Overlay */}
            <div className="relative h-64 sm:h-72 md:h-80 w-full overflow-hidden">
              {!imgErrors[`feat_${currentFeatured.id}`] && currentFeatured.bannerUrl ? (
                <img
                  src={currentFeatured.bannerUrl}
                  alt={currentFeatured.name}
                  onError={() => handleImageError(`feat_${currentFeatured.id}`)}
                  className="w-full h-full object-cover object-center group-hover:scale-105 transition-transform duration-700 ease-out brightness-90"
                />
              ) : (
                <div className="w-full h-full bg-gradient-to-br from-zinc-900 via-zinc-800 to-black flex items-center justify-center">
                  <Gamepad2 className="w-16 h-16 text-zinc-600" />
                </div>
              )}
              {/* Multi-stage dark gradient overlays for maximum legibility */}
              <div className="absolute inset-0 bg-gradient-to-t from-[#07090E] via-[#07090E]/60 to-transparent" />
              <div className="absolute inset-0 bg-gradient-to-r from-[#07090E]/90 via-[#07090E]/40 to-transparent" />
            </div>

            {/* Hero Content Overlay */}
            <div className="absolute inset-0 p-5 sm:p-7 flex flex-col justify-end">
              {/* Badges line */}
              <div className="flex items-center gap-2 mb-2">
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-black uppercase tracking-wider bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 backdrop-blur-md">
                  <Sparkles className="w-3 h-3 text-emerald-400" />
                  Featured Spotlight
                </span>
                <span className="text-[10px] font-bold text-zinc-300 bg-black/60 backdrop-blur-md px-2.5 py-1 rounded-full border border-white/10">
                  {currentFeatured.category}
                </span>
              </div>

              {/* Game Title */}
              <h2 className="text-2xl sm:text-3xl md:text-4xl font-black text-white tracking-tight drop-shadow-md">
                {currentFeatured.name}
              </h2>

              <p className="text-xs sm:text-sm text-zinc-300 line-clamp-1 max-w-lg mt-1 mb-4 drop-shadow">
                {currentFeatured.description || 'Compete in high-stakes mobile esports matches.'}
              </p>

              {/* Action Bar */}
              <div className="flex flex-wrap items-center gap-3">
                {(() => {
                  const featOppState = getGameOpportunityState(currentFeatured);
                  const isLaunching = launchingGameId === currentFeatured.id;
                  const isPurchasing = purchasingGameId === currentFeatured.id;

                  if (featOppState?.status === 'available') {
                    return (
                      <button
                        type="button"
                        onClick={() => handleLaunchGame(currentFeatured)}
                        disabled={isLaunching}
                        className="min-h-[44px] px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-black text-xs sm:text-sm flex items-center gap-2 transition-all shadow-lg shadow-emerald-500/20 active:scale-95 cursor-pointer"
                      >
                        {isLaunching ? (
                          <RotateCw className="w-4 h-4 animate-spin text-zinc-950" />
                        ) : (
                          <Play className="w-4 h-4 fill-zinc-950" />
                        )}
                        <span>Launch Match</span>
                      </button>
                    );
                  } else if (featOppState?.status === 'launched') {
                    return (
                      <button
                        type="button"
                        onClick={() => handleLaunchGame(currentFeatured)}
                        disabled={isLaunching}
                        className="min-h-[44px] px-6 py-2.5 rounded-xl bg-[#0E121E] border border-emerald-500/50 hover:bg-emerald-950/40 text-emerald-300 font-black text-xs sm:text-sm flex items-center gap-2 transition-all active:scale-95 cursor-pointer"
                      >
                        <Play className="w-4 h-4 fill-emerald-300" />
                        <span>Resume Match</span>
                      </button>
                    );
                  } else {
                    return (
                      <button
                        type="button"
                        onClick={() => handlePurchase(currentFeatured)}
                        disabled={isPurchasing}
                        className="min-h-[44px] px-6 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-black text-xs sm:text-sm flex items-center gap-2 transition-all shadow-lg shadow-emerald-500/20 active:scale-95 cursor-pointer disabled:opacity-50"
                      >
                        {isPurchasing ? (
                          <>
                            <RotateCw className="w-4 h-4 animate-spin text-zinc-950" />
                            <span>Securing Match...</span>
                          </>
                        ) : (
                          <>
                            <span>Get Match · ₦100</span>
                          </>
                        )}
                      </button>
                    );
                  }
                })()}

                {/* Secondary details trigger */}
                <button
                  type="button"
                  onClick={() => setActiveDetailsGame(currentFeatured)}
                  className="min-h-[44px] px-4 py-2.5 rounded-xl bg-white/[0.08] hover:bg-white/[0.12] text-zinc-200 font-bold text-xs flex items-center gap-1.5 backdrop-blur-md transition-colors cursor-pointer"
                >
                  <Info className="w-3.5 h-3.5" />
                  <span>Info</span>
                </button>
              </div>

              {/* Featured Carousel Dots */}
              {featuredGames.length > 1 && (
                <div className="flex items-center gap-1.5 mt-4">
                  {featuredGames.map((fg, idx) => (
                    <button
                      key={fg.id}
                      type="button"
                      onClick={() => setFeaturedIndex(idx)}
                      className={`h-1.5 rounded-full transition-all cursor-pointer ${
                        featuredIndex === idx
                          ? 'w-6 bg-emerald-400'
                          : 'w-2 bg-white/30 hover:bg-white/50'
                      }`}
                      aria-label={`Switch to featured game ${fg.name}`}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </section>
      )}

      {/* 2. RECENTLY PLAYED HORIZONTAL STRIP */}
      {recentlyPlayed.length > 0 && !searchQuery && selectedCategory === 'All' && (
        <section aria-label="Recently Played" className="space-y-3">
          <div className="flex items-center justify-between px-0">
            <h3 className="text-xs font-black uppercase tracking-wider text-zinc-400 flex items-center gap-1.5">
              <Clock className="w-3.5 h-3.5 text-emerald-400" />
              <span>Jump Back In</span>
            </h3>
          </div>
          <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-none">
            {recentlyPlayed.map((rg) => {
              const oppState = getGameOpportunityState(rg);
              return (
                <div
                  key={`recent_${rg.id}`}
                  onClick={() => handleLaunchGame(rg)}
                  className="w-36 shrink-0 rounded-2xl bg-[#0E121E] border border-white/[0.06] hover:border-emerald-500/40 p-2.5 cursor-pointer transition-all hover:scale-[1.02] group"
                >
                  <div className="aspect-video rounded-xl overflow-hidden mb-2 relative bg-zinc-900 border border-white/5">
                    {!imgErrors[`recent_${rg.id}`] && (rg.bannerUrl || rg.iconUrl) ? (
                      <img
                        src={rg.bannerUrl || rg.iconUrl}
                        alt={rg.name}
                        onError={() => handleImageError(`recent_${rg.id}`)}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center bg-zinc-900 text-zinc-500">
                        <Gamepad2 className="w-6 h-6" />
                      </div>
                    )}
                    <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                      <div className="w-8 h-8 rounded-full bg-emerald-500 flex items-center justify-center text-zinc-950 shadow-md">
                        <Play className="w-4 h-4 fill-zinc-950 ml-0.5" />
                      </div>
                    </div>
                  </div>
                  <div className="font-extrabold text-white text-xs truncate">{rg.name}</div>
                  <div className="text-[10px] text-zinc-400 font-medium truncate mt-0.5">
                    {oppState?.status === 'available'
                      ? 'Ready to Launch'
                      : oppState?.status === 'launched'
                      ? 'In Match'
                      : '₦100 / Match'}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* 3. DISCOVERY CONTROLS: SEARCH & CATEGORY FILTERS */}
      <section aria-label="Game Discovery" className="space-y-3.5">
        <div className="flex items-center justify-between gap-3 px-0">
          <div>
            <h2 className="text-lg font-black text-white tracking-tight">
              Game Discovery
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Choose your title · ₦100 per match opportunity
            </p>
          </div>

          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={onOpenAndroidGuide}
              className="p-2 rounded-xl bg-[#0E121E] border border-white/[0.08] hover:border-white/20 text-zinc-400 hover:text-white transition-colors cursor-pointer"
              title="Android Launch Architecture Guide"
              aria-label="Android Architecture Guide"
            >
              <Smartphone className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onOpenAddCustomGame}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#0E121E] border border-white/[0.08] hover:border-white/20 text-zinc-200 hover:text-white font-bold text-xs transition-colors cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Add Game</span>
            </button>
          </div>
        </div>

        {/* Search Input */}
        <div className="relative">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 pointer-events-none" />
          <input
            type="text"
            placeholder="Search games by title or genre..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-[#0E121E] border border-white/[0.08] rounded-2xl py-3 pl-10 pr-12 text-xs sm:text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500/60 transition-colors shadow-inner"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-3.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-white text-xs px-1 cursor-pointer"
            >
              Clear
            </button>
          )}
        </div>

        {/* Category Filter Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setSelectedCategory(cat)}
              className={`px-3.5 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all cursor-pointer ${
                selectedCategory === cat
                  ? 'bg-emerald-500 text-zinc-950 shadow-md shadow-emerald-500/20'
                  : 'bg-[#0E121E] text-zinc-400 hover:text-zinc-200 border border-white/[0.06] hover:border-white/10'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </section>

      {/* 4. CINEMATIC GAME LIBRARY GRID */}
      <section aria-label="Game Library" className="@container">
        {filteredGames.length === 0 ? (
          /* Empty State */
          <div className="p-10 rounded-3xl bg-[#0E121E] border border-white/[0.06] text-center space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-zinc-900 border border-white/10 flex items-center justify-center mx-auto text-zinc-500">
              <Search className="w-6 h-6" />
            </div>
            <div>
              <h3 className="font-extrabold text-white text-base">No Matching Games Found</h3>
              <p className="text-xs text-zinc-400 mt-1 max-w-sm mx-auto">
                {searchQuery
                  ? `No games matching "${searchQuery}". You can add it manually using its Android package ID.`
                  : 'No games found in this category yet.'}
              </p>
            </div>
            {searchQuery && (
              <button
                type="button"
                onClick={onOpenAddCustomGame}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs transition-colors shadow-md shadow-emerald-500/20 cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Add "{searchQuery}" Manually</span>
              </button>
            )}
          </div>
        ) : (
          /* Responsive Multi-column Grid based on actual available content container width */
          <div className="grid grid-cols-1 @[600px]:grid-cols-2 @[860px]:grid-cols-3 @[1100px]:grid-cols-4 gap-4 game-catalog-grid">
            {filteredGames.map((game) => {
              const oppState = getGameOpportunityState(game);
              const isInstalled = game.installationStatus === 'installed';
              const isPurchasing = purchasingGameId === game.id;
              const isLaunching = launchingGameId === game.id;

              return (
                <div
                  key={game.id}
                  className="group rounded-2xl overflow-hidden border border-white/[0.07] bg-[#0E121E] hover:border-white/20 transition-all duration-300 flex flex-col shadow-lg hover:shadow-2xl"
                >
                  {/* 16:9 Aspect Ratio Game Artwork Banner */}
                  <div className="relative aspect-video w-full overflow-hidden bg-zinc-950">
                    {!imgErrors[game.id] && (game.bannerUrl || game.iconUrl) ? (
                      <img
                        src={game.bannerUrl || game.iconUrl}
                        alt={game.name}
                        onError={() => handleImageError(game.id)}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500 ease-out brightness-90"
                      />
                    ) : (
                      <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-zinc-900 via-zinc-950 to-black text-zinc-400 p-4 text-center">
                        <div className="w-12 h-12 rounded-2xl bg-zinc-800/80 border border-white/10 flex items-center justify-center text-emerald-400 mb-2">
                          <Gamepad2 className="w-6 h-6" />
                        </div>
                        <span className="text-xs font-black text-zinc-200 tracking-wide uppercase line-clamp-1">
                          {game.name}
                        </span>
                        <span className="text-[10px] text-zinc-500 mt-0.5">
                          {game.category}
                        </span>
                      </div>
                    )}

                    {/* Gradient Overlay for bottom text protection */}
                    <div className="absolute inset-0 bg-gradient-to-t from-[#0E121E] via-transparent to-black/40 pointer-events-none" />

                    {/* Top Badges Overlay */}
                    <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between gap-1 pointer-events-none">
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-black/70 backdrop-blur-md text-zinc-200 border border-white/10">
                        {game.category}
                      </span>

                      <div className="flex items-center gap-1 pointer-events-auto">
                        {/* Play Store Link */}
                        {game.playStoreUrl && (
                          <a
                            href={game.playStoreUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="w-7 h-7 rounded-lg bg-black/70 backdrop-blur-md border border-white/10 flex items-center justify-center text-zinc-300 hover:text-white transition-colors"
                            title="Open Google Play Store page"
                            aria-label={`Open ${game.name} on Play Store`}
                          >
                            <ExternalLink className="w-3.5 h-3.5" />
                          </a>
                        )}

                        {/* Info & Install Verification trigger */}
                        <button
                          type="button"
                          onClick={() => setActiveDetailsGame(game)}
                          className="w-7 h-7 rounded-lg bg-black/70 backdrop-blur-md border border-white/10 flex items-center justify-center text-zinc-300 hover:text-emerald-400 transition-colors cursor-pointer"
                          title="View Game & Install Verification details"
                          aria-label="View Game Details"
                        >
                          <Info className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Bottom-left Over-Image Status Indicator: Only shown when device installation is verified */}
                    {isInstalled && (
                      <div className="absolute bottom-2 left-3 flex items-center gap-1.5">
                        <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-950/80 backdrop-blur-md border border-emerald-500/40 px-2 py-0.5 rounded-md">
                          <CheckCircle2 className="w-3 h-3" />
                          Installed
                        </span>
                      </div>
                    )}
                  </div>

                  {/* Card Content & Action Area */}
                  <div className="p-3.5 flex-1 flex flex-col justify-between gap-3">
                    <div>
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="font-extrabold text-white text-sm sm:text-base truncate group-hover:text-emerald-400 transition-colors">
                          {game.name}
                        </h3>
                        {game.verifiedLaunch && (
                          <span title="Verified Launch Support">
                            <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                          </span>
                        )}
                      </div>

                      {/* Clean Unboxed Metadata: Real game category and verified ₦100 price */}
                      <div className="flex items-center gap-2 text-[11px] text-zinc-400 mt-1">
                        <span className="text-zinc-300 font-medium">{game.category}</span>
                        <span>·</span>
                        <span className="font-mono text-emerald-400 font-bold">₦100 / Match</span>
                      </div>
                    </div>

                    {/* Dynamic Primary CTA Button (44px min height for ergonomic touch targets) */}
                    <div>
                      {oppState?.status === 'available' ? (
                        <button
                          type="button"
                          onClick={() => handleLaunchGame(game)}
                          disabled={isLaunching}
                          className="w-full min-h-[44px] py-2 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-black text-xs sm:text-sm flex items-center justify-center gap-2 transition-all shadow-md shadow-emerald-500/20 active:scale-98 cursor-pointer"
                        >
                          {isLaunching ? (
                            <>
                              <RotateCw className="w-4 h-4 animate-spin text-zinc-950" />
                              <span>Launching...</span>
                            </>
                          ) : (
                            <>
                              <Play className="w-4 h-4 fill-zinc-950" />
                              <span>Launch Match</span>
                            </>
                          )}
                        </button>
                      ) : oppState?.status === 'launched' ? (
                        <button
                          type="button"
                          onClick={() => handleLaunchGame(game)}
                          disabled={isLaunching}
                          className="w-full min-h-[44px] py-2 px-3 rounded-xl bg-[#131929] border border-cyan-500/50 hover:bg-cyan-950/40 text-cyan-300 font-black text-xs sm:text-sm flex items-center justify-center gap-2 transition-all active:scale-98 cursor-pointer"
                        >
                          <Play className="w-4 h-4 fill-cyan-300" />
                          <span>Resume Match</span>
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handlePurchase(game)}
                          disabled={isPurchasing}
                          className="w-full min-h-[44px] py-2 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-black text-xs sm:text-sm flex items-center justify-center gap-2 transition-all shadow-md shadow-emerald-500/20 active:scale-98 cursor-pointer disabled:opacity-50"
                        >
                          {isPurchasing ? (
                            <>
                              <RotateCw className="w-4 h-4 animate-spin text-zinc-950" />
                              <span>Securing Match...</span>
                            </>
                          ) : (
                            <>
                              <span>Get Match · ₦100</span>
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 5. GAME INFORMATION & INSTALLATION VERIFICATION SHEET MODAL */}
      {activeDetailsGame && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-md animate-in fade-in">
          <div className="relative w-full max-w-sm bg-[#0E121E] border border-white/10 rounded-3xl p-6 text-left shadow-2xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-black text-white">{activeDetailsGame.name}</h3>
              <button
                type="button"
                onClick={() => setActiveDetailsGame(null)}
                className="text-zinc-400 hover:text-white p-1"
                aria-label="Close details"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-zinc-300 leading-relaxed">
              {activeDetailsGame.description || 'Supported title on the Stage 3 Match Opportunity Engine.'}
            </p>

            {/* Installation Verification Status */}
            <div className="p-3.5 rounded-2xl bg-zinc-900/90 border border-white/[0.06] space-y-2">
              <div className="text-[10px] uppercase font-bold text-zinc-400 tracking-wider">
                Device Compatibility
              </div>
              <div className="flex items-center justify-between">
                <span className="text-xs text-zinc-200">
                  {activeDetailsGame.installationStatus === 'installed'
                    ? 'Installed on Device'
                    : 'Not Installed / Unverified'}
                </span>
                <button
                  type="button"
                  onClick={() => handleToggleStatus(activeDetailsGame)}
                  className="px-3 py-1 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-bold text-zinc-200 transition-colors cursor-pointer"
                >
                  Toggle Status
                </button>
              </div>
              <p className="text-[10px] text-zinc-400 leading-relaxed">
                Matches launch via standard Android app links. If the title is not on your phone yet, install it from the Google Play Store below.
              </p>
            </div>

            <div className="flex items-center gap-2 pt-2">
              {activeDetailsGame.playStoreUrl && (
                <a
                  href={activeDetailsGame.playStoreUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex-1 py-2.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-center text-xs font-bold text-white transition-colors"
                >
                  Google Play Store
                </a>
              )}
              <button
                type="button"
                onClick={() => setActiveDetailsGame(null)}
                className="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 text-center text-xs font-black transition-colors cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 6. LAUNCH CONFIRMATION MODAL */}
      {activeLaunchModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-in fade-in">
          <div className="relative w-full max-w-sm bg-[#0E121E] border border-emerald-500/40 rounded-3xl p-6 text-center shadow-2xl space-y-4">
            <div className="w-14 h-14 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mx-auto text-emerald-400">
              <Play className="w-7 h-7 fill-emerald-400 ml-0.5" />
            </div>

            <div>
              <h3 className="text-lg font-black text-white">Launching {activeLaunchModal.name}</h3>
              <p className="text-xs text-zinc-300 mt-1">
                Your match pass is active. Opening game...
              </p>
            </div>

            <div className="p-3.5 rounded-2xl bg-zinc-900 border border-white/[0.06] text-left text-xs space-y-1">
              <div className="text-[10px] text-zinc-400 uppercase font-bold tracking-wider">
                Launch Status
              </div>
              <div className="text-emerald-400 text-xs font-bold">
                {activeLaunchModal.name} · Match In Progress
              </div>
              <div className="text-[10px] text-zinc-400 pt-1 leading-relaxed">{launchMessage}</div>
            </div>

            <button
              type="button"
              onClick={() => setActiveLaunchModal(null)}
              className="w-full min-h-[44px] bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-black py-2.5 rounded-xl text-xs transition-colors cursor-pointer"
            >
              Return to Hub
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

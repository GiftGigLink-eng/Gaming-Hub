import React, { useState, useEffect, useCallback } from 'react';
import {
  Users,
  Plus,
  Search,
  LogIn,
  KeyRound,
  Gamepad2,
  Clock,
  Sparkles,
  RefreshCw,
  AlertCircle,
  Crown,
  Radio,
  ArrowRight,
  ShieldCheck,
  X,
  Eye,
  Tv,
  Copy,
  Check,
} from 'lucide-react';
import { MatchRoom, SupportedGame, UserProfile } from '../types.js';
import { authFetch } from '../lib/firebase.js';

interface LiveRoomsHubProps {
  currentUser: UserProfile | null;
  supportedGames?: SupportedGame[];
  onSelectRoom: (room: MatchRoom) => void;
  onOpenAuth: () => void;
}

export const LiveRoomsHub: React.FC<LiveRoomsHubProps> = ({
  currentUser,
  supportedGames = [],
  onSelectRoom,
  onOpenAuth,
}) => {
  const [games, setGames] = useState<SupportedGame[]>(supportedGames);
  const [rooms, setRooms] = useState<MatchRoom[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedGameFilter, setSelectedGameFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'streaming' | 'live' | 'waiting'>('all');

  // Load games from catalog if not passed
  useEffect(() => {
    if (supportedGames.length > 0) {
      setGames(supportedGames);
    } else {
      fetch('/api/games')
        .then((res) => res.json())
        .then((data) => {
          if (data.success && Array.isArray(data.games)) {
            setGames(data.games);
            if (data.games.length > 0 && !createGameId) {
              setCreateGameId(data.games[0].id);
            }
          }
        })
        .catch(() => {});
    }
  }, [supportedGames]);

  // Create Room Modal state
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [createGameId, setCreateGameId] = useState(supportedGames[0]?.id || 'freefire');
  const [createTitle, setCreateTitle] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Direct Join by Code state
  const [joinCode, setJoinCode] = useState('');
  const [isJoiningCode, setIsJoiningCode] = useState(false);
  const [joinError, setJoinError] = useState<string | null>(null);

  const fetchRooms = useCallback(async () => {
    try {
      setError(null);
      let url = '/api/rooms';
      const params = new URLSearchParams();
      if (selectedGameFilter !== 'all') params.append('gameId', selectedGameFilter);
      if (statusFilter === 'live' || statusFilter === 'waiting') {
        params.append('status', statusFilter);
      }
      if (params.toString()) url += `?${params.toString()}`;

      const res = await fetch(url);
      const data = await res.json();
      if (data.success && Array.isArray(data.rooms)) {
        setRooms(data.rooms);
      } else {
        setRooms([]);
      }
    } catch (err: any) {
      console.warn('[LiveRoomsHub] fetchRooms error:', err);
      setError('Unable to load rooms. Please check your network connection.');
    } finally {
      setIsLoading(false);
    }
  }, [selectedGameFilter, statusFilter]);

  useEffect(() => {
    fetchRooms();
    const interval = setInterval(fetchRooms, 8000);
    return () => clearInterval(interval);
  }, [fetchRooms]);

  const handleCreateRoom = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) {
      onOpenAuth();
      return;
    }

    const title = createTitle.trim();
    if (title.length < 3) {
      setCreateError('Room title must be at least 3 characters.');
      return;
    }
    if (title.length > 60) {
      setCreateError('Room title cannot exceed 60 characters.');
      return;
    }

    const selectedGame = games.find((g) => g.id === createGameId);
    const gameTitle = selectedGame?.name || createGameId;

    setIsSubmitting(true);
    setCreateError(null);

    try {
      const res = await authFetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gameId: createGameId,
          gameTitle,
          title,
        }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to create room.');
      }

      setIsCreateOpen(false);
      setCreateTitle('');
      fetchRooms();
      onSelectRoom(data.room);
    } catch (err: any) {
      setCreateError(err.message || 'Error creating room.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleJoinByCode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentUser) {
      onOpenAuth();
      return;
    }

    const raw = joinCode.trim();
    if (!raw) return;
    const formattedId = raw.startsWith('rm_') ? raw : `rm_${raw.toLowerCase()}`;

    setIsJoiningCode(true);
    setJoinError(null);

    try {
      const res = await authFetch(`/api/rooms/${formattedId}/join`, {
        method: 'POST',
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to join room.');
      }

      setJoinCode('');
      onSelectRoom(data.room);
    } catch (err: any) {
      setJoinError(err.message || 'Room not found or could not be joined.');
    } finally {
      setIsJoiningCode(false);
    }
  };

  const handleJoinRoom = async (room: MatchRoom) => {
    if (!currentUser) {
      onOpenAuth();
      return;
    }

    try {
      const res = await authFetch(`/api/rooms/${room.id}/join`, {
        method: 'POST',
      });
      const data = await res.json();
      if (data.success && data.room) {
        onSelectRoom(data.room);
      } else {
        // Fallback to viewing room even if already participant
        onSelectRoom(room);
      }
    } catch (err) {
      onSelectRoom(room);
    }
  };

  const [copiedRoomId, setCopiedRoomId] = useState<string | null>(null);

  const handleCopyCardCode = (roomId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    const code = roomId.replace('rm_', '').toUpperCase();
    navigator.clipboard.writeText(code);
    setCopiedRoomId(roomId);
    setTimeout(() => setCopiedRoomId(null), 2000);
  };

  // Filtered rooms
  const filteredRooms = rooms.filter((r) => {
    if (statusFilter === 'streaming' && !r.stream?.isLive) {
      return false;
    }
    if (selectedGameFilter !== 'all' && r.gameId !== selectedGameFilter) {
      return false;
    }
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      const matchTitle = r.title.toLowerCase().includes(query);
      const matchGame = r.gameTitle.toLowerCase().includes(query);
      const matchHost = r.hostName.toLowerCase().includes(query);
      const matchCode = r.id.toLowerCase().includes(query);
      if (!matchTitle && !matchGame && !matchHost && !matchCode) return false;
    }
    return true;
  });

  return (
    <div className="space-y-4">
      {/* Header Banner */}
      <div className="p-4 sm:p-5 rounded-3xl bg-gradient-to-br from-[#0E121E] via-[#0E1526] to-[#0A0D17] border border-white/[0.08] shadow-xl relative overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
              <span className="text-[10px] font-black uppercase tracking-wider text-emerald-400 font-mono">
                Live Multiplayer & Stream Hub
              </span>
            </div>
            <h2 className="text-xl sm:text-2xl font-black text-white tracking-tight">
              Live Rooms & Gameplay Streams
            </h2>
            <p className="text-xs text-zinc-400 max-w-md">
              Discover active matches, join live squad chats, watch gameplay streams, or broadcast your own room.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (!currentUser) {
                  onOpenAuth();
                } else {
                  setIsCreateOpen(true);
                }
              }}
              className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs transition-all active:scale-95 flex items-center gap-1.5 shadow-lg shadow-emerald-500/20 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              <span>Create Room</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setIsLoading(true);
                fetchRooms();
              }}
              className="p-2.5 rounded-xl bg-zinc-900 border border-white/10 hover:border-white/20 text-zinc-300 hover:text-white transition-colors cursor-pointer"
              title="Refresh rooms"
            >
              <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {/* Phase 4.2 Notice */}
        <div className="mt-3 pt-3 border-t border-white/[0.06] flex items-center justify-between text-[11px] text-zinc-400">
          <div className="flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            <span>Dedicated Stream Player • Zero-Fake Viewers • Verified Heartbeats</span>
          </div>
          <span className="text-[10px] font-mono text-emerald-400 bg-emerald-950/60 border border-emerald-800/40 px-2 py-0.5 rounded">
            Phase 4.2
          </span>
        </div>
      </div>

      {/* Quick Join by Room Code Bar */}
      <div className="p-3.5 rounded-2xl bg-[#0E121E] border border-white/[0.06] flex flex-col sm:flex-row items-center gap-3">
        <div className="flex items-center gap-2 text-xs font-bold text-zinc-300 shrink-0">
          <KeyRound className="w-4 h-4 text-emerald-400" />
          <span>Have a Room Code?</span>
        </div>
        <form onSubmit={handleJoinByCode} className="flex-1 flex items-center gap-2 w-full">
          <input
            type="text"
            placeholder="Enter code (e.g. 9f2a81 or rm_9f2a81)"
            value={joinCode}
            onChange={(e) => {
              setJoinCode(e.target.value);
              setJoinError(null);
            }}
            className="flex-1 bg-zinc-900 border border-white/[0.08] rounded-xl px-3 py-2 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500 font-mono uppercase"
          />
          <button
            type="submit"
            disabled={!joinCode.trim() || isJoiningCode}
            className="px-3.5 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 disabled:opacity-50 text-white font-bold text-xs transition-colors shrink-0 cursor-pointer"
          >
            {isJoiningCode ? 'Joining...' : 'Join'}
          </button>
        </form>
        {joinError && (
          <span className="text-[11px] text-rose-400 font-medium">{joinError}</span>
        )}
      </div>

      {/* Search & Filter Controls */}
      <div className="flex flex-col md:flex-row gap-2.5">
        <div className="relative flex-1">
          <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-3.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search by room title, game, or host..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-[#0E121E] border border-white/[0.08] rounded-xl py-2 pl-9 pr-3 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500"
          />
        </div>

        {/* Game Filter Selector */}
        <select
          value={selectedGameFilter}
          onChange={(e) => setSelectedGameFilter(e.target.value)}
          className="bg-[#0E121E] border border-white/[0.08] rounded-xl px-3 py-2 text-xs text-zinc-300 focus:outline-none focus:border-emerald-500 font-mono"
        >
          <option value="all">All Games</option>
          {games.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>

        {/* Status Filters */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0">
          {(
            [
              { key: 'all', label: 'All Rooms' },
              { key: 'streaming', label: 'Streaming Now' },
              { key: 'live', label: 'In Progress' },
              { key: 'waiting', label: 'Lobbies' },
            ] as const
          ).map((st) => (
            <button
              key={st.key}
              type="button"
              onClick={() => setStatusFilter(st.key)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-colors cursor-pointer shrink-0 flex items-center gap-1 ${
                statusFilter === st.key
                  ? 'bg-emerald-500 text-zinc-950 font-black'
                  : 'bg-zinc-900/80 text-zinc-400 hover:text-white border border-white/[0.06]'
              }`}
            >
              {st.key === 'streaming' && <Tv className="w-3 h-3 text-rose-500" />}
              <span>{st.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Error Alert */}
      {error && (
        <div className="p-3.5 rounded-2xl bg-rose-950/60 border border-rose-800/60 text-rose-300 text-xs flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={fetchRooms}
            className="text-[11px] font-bold text-rose-200 underline cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Rooms Grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {[1, 2, 3, 4].map((n) => (
            <div
              key={n}
              className="p-4 rounded-2xl bg-[#0E121E] border border-white/[0.06] animate-pulse space-y-3"
            >
              <div className="h-4 bg-zinc-800 rounded w-1/3" />
              <div className="h-5 bg-zinc-800 rounded w-3/4" />
              <div className="h-3 bg-zinc-800 rounded w-1/2" />
            </div>
          ))}
        </div>
      ) : filteredRooms.length === 0 ? (
        <div className="p-8 rounded-3xl bg-[#0E121E] border border-white/[0.06] text-center space-y-3">
          <div className="w-12 h-12 rounded-2xl bg-zinc-900 border border-white/10 flex items-center justify-center mx-auto text-zinc-400">
            <Users className="w-6 h-6" />
          </div>
          <div>
            <h4 className="font-bold text-sm text-white">No Match Rooms Active</h4>
            <p className="text-xs text-zinc-400 mt-1 max-w-sm mx-auto">
              {searchQuery || statusFilter !== 'all' || selectedGameFilter !== 'all'
                ? 'No rooms match your search query or filter.'
                : 'No one has created a room yet. Start the first squad room now!'}
            </p>
          </div>
          <button
            type="button"
            onClick={() => {
              if (!currentUser) onOpenAuth();
              else setIsCreateOpen(true);
            }}
            className="px-4 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs transition-colors cursor-pointer inline-flex items-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>Create First Room</span>
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filteredRooms.map((room) => {
            const isHost = currentUser?.id === room.hostId;
            const isMember = currentUser?.id ? Boolean(room.participants?.[currentUser.id]) : false;
            const isBroadcasting = Boolean(room.stream?.isLive && room.stream?.streamUrl);

            return (
              <div
                key={room.id}
                className="p-4 rounded-2xl bg-[#0E121E] border border-white/[0.06] hover:border-emerald-500/30 transition-all flex flex-col justify-between gap-3 group relative overflow-hidden"
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <span className="text-[10px] font-black uppercase tracking-wider text-emerald-400 font-mono px-2 py-0.5 rounded-md bg-emerald-950/70 border border-emerald-800/50 truncate">
                      {room.gameTitle}
                    </span>

                    <div className="flex items-center gap-1.5">
                      {isBroadcasting && (
                        <span className="text-[9px] font-black uppercase px-2 py-0.5 rounded-full bg-rose-600 text-white font-mono flex items-center gap-1 shadow-sm animate-pulse">
                          <Tv className="w-2.5 h-2.5" />
                          <span>LIVE STREAM</span>
                        </span>
                      )}

                      <span
                        className={`text-[10px] font-bold px-2 py-0.5 rounded-full flex items-center gap-1 ${
                          room.status === 'live'
                            ? 'bg-rose-950 text-rose-300 border border-rose-800/60'
                            : 'bg-zinc-900 text-zinc-400 border border-zinc-800'
                        }`}
                      >
                        {room.status === 'live' && !isBroadcasting && (
                          <span className="w-1.5 h-1.5 rounded-full bg-rose-400 animate-pulse" />
                        )}
                        <span>
                          {room.status === 'live' ? 'Match Live' : 'Open Lobby'}
                        </span>
                      </span>
                    </div>
                  </div>

                  <h3 className="font-bold text-sm text-white line-clamp-1 group-hover:text-emerald-300 transition-colors">
                    {room.title}
                  </h3>

                  <div className="flex items-center gap-3 mt-2 text-[11px] text-zinc-400">
                    <div className="flex items-center gap-1 truncate">
                      <Crown className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                      <span className="truncate">{room.hostName}</span>
                    </div>

                    <div className="flex items-center gap-1 shrink-0 font-mono">
                      <Users className="w-3.5 h-3.5 text-zinc-500" />
                      <span>{room.participantCount || 1} squad</span>
                    </div>

                    <div className="flex items-center gap-1 shrink-0 font-mono text-emerald-400">
                      <Eye className="w-3.5 h-3.5 text-emerald-400" />
                      <span>{room.viewerCount || 0} watching</span>
                    </div>
                  </div>
                </div>

                <div className="pt-2 border-t border-white/[0.04] flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={(e) => handleCopyCardCode(room.id, e)}
                    className="text-[10px] font-mono text-zinc-400 hover:text-white flex items-center gap-1 p-1 rounded hover:bg-zinc-800/60 transition-colors cursor-pointer"
                    title="Copy Room Code"
                  >
                    {copiedRoomId === room.id ? (
                      <Check className="w-3 h-3 text-emerald-400" />
                    ) : (
                      <Copy className="w-3 h-3 text-zinc-500" />
                    )}
                    <span>{room.id.replace('rm_', '').toUpperCase()}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleJoinRoom(room)}
                    className={`px-3.5 py-1.5 rounded-xl font-bold text-xs transition-colors flex items-center gap-1 cursor-pointer ${
                      isBroadcasting
                        ? 'bg-rose-600 hover:bg-rose-500 text-white shadow-lg shadow-rose-600/25'
                        : isMember
                        ? 'bg-zinc-800 hover:bg-zinc-700 text-white'
                        : 'bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black'
                    }`}
                  >
                    {isBroadcasting ? (
                      <>
                        <Tv className="w-3.5 h-3.5" />
                        <span>Watch Stream</span>
                      </>
                    ) : isMember ? (
                      <>
                        <span>Enter Room</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </>
                    ) : (
                      <>
                        <span>Join & Chat</span>
                        <ArrowRight className="w-3.5 h-3.5" />
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* CREATE ROOM MODAL */}
      {isCreateOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-in fade-in duration-200">
          <div className="relative w-full max-w-md bg-[#0E121E] border border-white/[0.08] rounded-3xl overflow-hidden shadow-2xl p-6 space-y-4">
            <div className="flex items-center justify-between border-b border-white/[0.06] pb-3">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-xl bg-zinc-900 border border-white/10 flex items-center justify-center text-emerald-400">
                  <Plus className="w-4 h-4" />
                </div>
                <div>
                  <h3 className="font-black text-base text-white">Create Match Room</h3>
                  <p className="text-[11px] text-zinc-400">Multiplayer text chat & coordination</p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsCreateOpen(false)}
                className="w-7 h-7 rounded-lg bg-zinc-900 text-zinc-400 hover:text-white flex items-center justify-center cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {createError && (
              <div className="p-3 rounded-xl bg-rose-950/70 border border-rose-800 text-rose-300 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                <span>{createError}</span>
              </div>
            )}

            <form onSubmit={handleCreateRoom} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-bold text-zinc-300">Target Game</label>
                <select
                  value={createGameId}
                  onChange={(e) => setCreateGameId(e.target.value)}
                  className="w-full bg-zinc-900 border border-white/[0.08] rounded-xl px-3 py-2.5 text-xs text-white focus:outline-none focus:border-emerald-500 cursor-pointer"
                >
                  {games.map((game) => (
                    <option key={game.id} value={game.id}>
                      {game.name} ({game.category})
                    </option>
                  ))}
                </select>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-bold text-zinc-300">Room Title</label>
                <input
                  type="text"
                  placeholder="e.g. Squad Ranked - Mic Optional (3-60 chars)"
                  value={createTitle}
                  onChange={(e) => {
                    setCreateTitle(e.target.value);
                    setCreateError(null);
                  }}
                  maxLength={60}
                  className="w-full bg-zinc-900 border border-white/[0.08] rounded-xl px-3 py-2.5 text-xs text-white placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500"
                />
                <div className="flex justify-between text-[10px] text-zinc-500">
                  <span>Describe your match objectives</span>
                  <span>{createTitle.trim().length}/60</span>
                </div>
              </div>

              <div className="p-3 rounded-xl bg-zinc-900/60 border border-white/[0.04] text-[11px] text-zinc-400 space-y-1">
                <div className="flex items-center gap-1.5 text-zinc-300 font-bold">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Host Authority</span>
                </div>
                <p>
                  As host, you can update room status to Live, close the room, and invite others via shareable room code.
                </p>
              </div>

              <div className="flex items-center gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsCreateOpen(false)}
                  className="flex-1 py-2.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 font-bold text-xs transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting || createTitle.trim().length < 3}
                  className="flex-1 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-50 text-zinc-950 font-black text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  {isSubmitting ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Creating...</span>
                    </>
                  ) : (
                    <span>Create Room</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};

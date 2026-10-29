import React, { useState, useEffect, useCallback } from 'react';
import { AndroidHeader } from './components/AndroidHeader.js';
import { MatchOpportunityManager } from './components/MatchOpportunityManager.js';
import { UniversalGameLibrary } from './components/UniversalGameLibrary.js';
import { AddCustomGameModal } from './components/AddCustomGameModal.js';
import { AndroidNativeGuideModal } from './components/AndroidNativeGuideModal.js';
import { WalletModal } from './components/WalletModal.js';
import { PhoneAuthModal } from './components/PhoneAuthModal.js';
import { BottomNav, TabType } from './components/BottomNav.js';
import { LiveRoomsHub } from './components/LiveRoomsHub.js';
import { RoomViewModal } from './components/RoomViewModal.js';
import { GamingSession, MatchOpportunity, SupportedGame, Transaction, UserProfile, Wallet, MatchRoom } from './types.js';
import { ShieldCheck, Zap, Bell, CheckCircle2, AlertCircle, Phone, Sparkles, ArrowLeft, ChevronRight, Smartphone, CreditCard, ArrowDownLeft, ArrowUpRight, Radio, Ticket } from 'lucide-react';
import { testConnection, authFetch, auth } from './lib/firebase.js';

export default function App() {
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [activeSession, setActiveSession] = useState<GamingSession | null>(null);
  const [opportunities, setOpportunities] = useState<MatchOpportunity[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [activeTab, setActiveTab] = useState<TabType>('hub');

  // Modals
  const [isWalletOpen, setIsWalletOpen] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);
  const [isAddCustomGameOpen, setIsAddCustomGameOpen] = useState(false);
  const [isAndroidGuideOpen, setIsAndroidGuideOpen] = useState(false);

  // Live Match Rooms & SubTab state
  const [matchesSubTab, setMatchesSubTab] = useState<'passes' | 'rooms'>('passes');
  const [selectedRoom, setSelectedRoom] = useState<MatchRoom | null>(null);

  // Parse room invite URL parameter (?room=rm_...)
  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      const roomCode = params.get('room');
      if (roomCode) {
        fetch(`/api/rooms/${roomCode}`)
          .then((res) => res.json())
          .then((data) => {
            if (data.success && data.room) {
              setSelectedRoom(data.room);
              setActiveTab('sessions');
              setMatchesSubTab('rooms');
            }
          })
          .catch(() => {});
      }
    } catch (e) {
      // ignore
    }
  }, []);

  // Loading & notification states
  const [isLoadingSession, setIsLoadingSession] = useState(false);
  const [isLoadingOpportunities, setIsLoadingOpportunities] = useState(false);
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ type, message });
    setTimeout(() => setToast(null), 4000);
  };

  // Test Firebase connection on boot safely
  useEffect(() => {
    testConnection().catch(() => {});
  }, []);

  // Fetch user profile and wallet
  const fetchUserData = useCallback(async () => {
    try {
      const res = await authFetch('/api/auth/user');
      if (res.status === 401) {
        // Not authenticated yet
        return;
      }
      const data = await res.json();
      if (data.success) {
        setCurrentUser(data.user);
        setWallet(data.wallet);
      }
    } catch (err) {
      console.error('Error fetching user data:', err);
    }
  }, []);

  // Fetch active session from server
  const fetchActiveSession = useCallback(async () => {
    try {
      const res = await authFetch('/api/sessions/active');
      if (res.status === 401) return;
      const data = await res.json();
      if (data.success) {
        setActiveSession(data.session);
      }
    } catch (err) {
      console.error('Error fetching active session:', err);
    }
  }, []);

  // Fetch match opportunities from server
  const fetchOpportunities = useCallback(async () => {
    try {
      const res = await authFetch('/api/opportunities');
      if (res.status === 401) return;
      const data = await res.json();
      if (data.success) {
        setOpportunities(data.opportunities || []);
      }
    } catch (err) {
      console.error('Error fetching match opportunities:', err);
    }
  }, []);

  // Fetch transactions ledger
  const fetchTransactions = useCallback(async () => {
    try {
      const res = await authFetch('/api/transactions');
      if (res.status === 401) return;
      const data = await res.json();
      if (data.success) {
        setTransactions(data.transactions);
      }
    } catch (err) {
      console.error('Error fetching transactions:', err);
    }
  }, []);

  // Initialize data and listen to auth changes
  useEffect(() => {
    const unsubscribe = auth.onAuthStateChanged((user) => {
      if (user) {
        fetchUserData();
        fetchActiveSession();
        fetchOpportunities();
        fetchTransactions();
      } else {
        // Unauthenticated state
        setCurrentUser(null);
        setWallet(null);
        setActiveSession(null);
        setOpportunities([]);
        setTransactions([]);
      }
    });

    // Sync active session and match opportunities every 15 seconds if authenticated
    const timer = setInterval(() => {
      if (auth.currentUser) {
        fetchActiveSession();
        fetchOpportunities();
      }
    }, 15000);

    return () => {
      unsubscribe();
      clearInterval(timer);
    };
  }, [fetchUserData, fetchActiveSession, fetchOpportunities, fetchTransactions]);

  // Stage 3: Purchase Match Opportunity (₦100)
  const handlePurchaseOpportunity = async (gameId: string, gameTitle: string) => {
    setIsLoadingOpportunities(true);
    try {
      const idempotencyKey = `opp_buy_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      const res = await authFetch('/api/opportunities/purchase', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId, gameTitle, idempotencyKey }),
      });

      if (res.status === 401) {
        setIsAuthOpen(true);
        throw new Error('Authentication required. Please sign in to purchase match opportunities.');
      }

      const data = await res.json();
      if (!data.success) {
        if (data.code === 'INSUFFICIENT_BALANCE') {
          setIsWalletOpen(true);
        }
        throw new Error(data.error || 'Failed to purchase match opportunity');
      }

      setWallet(data.wallet);
      await fetchOpportunities();
      await fetchTransactions();
      showToast(data.message || `₦100 deducted. One match opportunity purchased for ${gameTitle}!`, 'success');
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setIsLoadingOpportunities(false);
    }
  };

  // Stage 3: Launch Match Opportunity (Uses existing opportunity - zero second charge)
  const handleLaunchOpportunity = async (gameId: string, opportunityId?: string) => {
    try {
      const res = await authFetch('/api/opportunities/launch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ gameId, opportunityId }),
      });

      if (res.status === 401) {
        setIsAuthOpen(true);
        throw new Error('Authentication required. Please sign in to launch games.');
      }

      const data = await res.json();
      if (!data.authorized) {
        throw new Error(data.error || 'Launch authorization denied');
      }

      await fetchOpportunities();
      showToast(
        data.alreadyLaunched
          ? `Resuming match for ${data.game?.name || gameId}!`
          : `Dispatched launch for ${data.game?.name || gameId}! Opportunity is active in match.`,
        'success'
      );
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  // Stage 3: Cancel / Refund Opportunity before launch (Restores ₦100)
  const handleRefundOpportunity = async (opportunityId: string) => {
    try {
      const res = await authFetch('/api/opportunities/refund', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          opportunityId,
          reason: 'Player requested pre-launch cancellation',
        }),
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Cancellation failed');
      }

      setWallet(data.wallet);
      await fetchOpportunities();
      await fetchTransactions();
      showToast(data.message || 'Match opportunity cancelled before launch. ₦100 restored to wallet.', 'success');
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  // Stage 3: Conclude Match Opportunity
  const handleCompleteOpportunity = async (opportunityId: string) => {
    try {
      const res = await authFetch('/api/opportunities/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ opportunityId }),
      });

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to complete opportunity');
      }

      await fetchOpportunities();
      showToast(data.message || 'Match concluded. Opportunity completed.', 'success');
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  // Start ₦100 1-Hour Session (Legacy fallback)
  const handleStartSession = async (gameTitle: string) => {
    setIsLoadingSession(true);

    try {
      const res = await authFetch('/api/sessions/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gameTitle,
          cost: 100,
          durationMinutes: 60,
        }),
      });

      if (res.status === 401) {
        setIsAuthOpen(true);
        throw new Error('Authentication required. Please sign in to start a session.');
      }

      const data = await res.json();
      if (!data.success) {
        if (data.code === 'INSUFFICIENT_BALANCE') {
          setIsWalletOpen(true);
        }
        throw new Error(data.error || 'Failed to start session');
      }

      setActiveSession(data.session);
      setWallet(data.wallet);
      fetchTransactions();
      showToast(`₦100 deducted. Match opportunity for ${gameTitle} is now ACTIVE!`, 'success');
      setActiveTab('sessions');
    } catch (err: any) {
      showToast(err.message, 'error');
    } finally {
      setIsLoadingSession(false);
    }
  };

  // End Session Early
  const handleEndSession = async (sessionId: string) => {
    try {
      const res = await authFetch('/api/sessions/end', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      const data = await res.json();
      if (data.success) {
        setActiveSession(null);
        showToast('Gaming session ended.', 'success');
      }
    } catch (err: any) {
      showToast(err.message, 'error');
    }
  };

  const hasActiveSession = Boolean(
    opportunities.some((o) => o.status === 'available' || o.status === 'launched') ||
    (activeSession && activeSession.status === 'active' && (activeSession.remainingSeconds ?? 0) > 0)
  );

  return (
    <div className="min-h-screen bg-[#07090E] text-zinc-100 w-full flex justify-center">
      {/* Responsive Mobile-First Shell Frame with Desktop Scaling */}
      <div className="w-full max-w-none md:max-w-3xl lg:max-w-5xl xl:max-w-6xl min-h-screen flex flex-col bg-[#07090E] relative border-x-0 md:border-x border-white/[0.04] shadow-none md:shadow-2xl pb-24 box-border">
        
        {/* Android Header with Branding, Wallet Balance & Profile */}
        <AndroidHeader
          wallet={wallet}
          onOpenWallet={() => setIsWalletOpen(true)}
          hasActiveSession={hasActiveSession}
          currentUser={currentUser}
          onOpenProfile={() => setActiveTab('profile')}
        />

        {/* Global Floating Toast */}
        {toast && (
          <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 w-11/12 max-w-sm animate-in slide-in-from-top duration-200">
            <div
              className={`p-3 rounded-xl border shadow-lg flex items-center gap-2.5 text-xs font-semibold backdrop-blur-md ${
                toast.type === 'success'
                  ? 'bg-[#0E131F]/95 border-emerald-500/50 text-emerald-200'
                  : 'bg-[#0E131F]/95 border-rose-500/50 text-rose-200'
              }`}
            >
              {toast.type === 'success' ? (
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : (
                <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
              )}
              <span className="flex-1">{toast.message}</span>
            </div>
          </div>
        )}

        {/* Main Body View based on Active Tab */}
        <main className="flex-1 p-4 overflow-y-auto space-y-4">
          
          {/* TAB 1: HUB LOBBY */}
          {activeTab === 'hub' && (
            <div className="space-y-5 animate-in fade-in duration-200">
              {/* Sleek, Unobtrusive Player Status Bar */}
              <div className="flex items-center justify-between px-0 text-xs">
                <div className="flex items-center gap-2">
                  <span className="text-zinc-500 font-medium">Player:</span>
                  <span className="font-extrabold text-white">
                    {currentUser?.displayName || 'Guest Player'}
                  </span>
                  {!currentUser && (
                    <button
                      type="button"
                      onClick={() => setIsAuthOpen(true)}
                      className="text-[11px] font-bold text-emerald-400 hover:text-emerald-300 ml-1 underline cursor-pointer"
                    >
                      Sign In
                    </button>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => setIsWalletOpen(true)}
                    className="flex items-center gap-1.5 hover:text-emerald-400 transition-colors cursor-pointer"
                  >
                    <span className="text-zinc-500 font-medium">Wallet:</span>
                    <span className="font-mono font-black text-emerald-400">
                      ₦{(wallet?.balance ?? 0).toLocaleString()}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('sessions')}
                    className="flex items-center gap-1 hover:text-emerald-400 transition-colors cursor-pointer"
                  >
                    <span className="text-zinc-500 font-medium">Passes:</span>
                    <span className="font-mono font-black text-white">
                      {opportunities.filter((o) => o.status === 'available' || o.status === 'launched').length}
                    </span>
                    <span className="text-emerald-400 font-bold">→</span>
                  </button>
                </div>
              </div>

              {/* Universal Data-Driven Game Library (Single Discovery & Purchasing Station) */}
              <UniversalGameLibrary
                session={activeSession}
                opportunities={opportunities}
                walletBalance={wallet?.balance ?? 0}
                userId={currentUser?.id || ''}
                onOpenSessionModal={(game) =>
                  handlePurchaseOpportunity('game_' + game.toLowerCase().replace(/[^a-z0-9]/g, '_'), game)
                }
                onPurchaseOpportunity={handlePurchaseOpportunity}
                onOpenAddCustomGame={() => setIsAddCustomGameOpen(true)}
                onOpenAndroidGuide={() => setIsAndroidGuideOpen(true)}
                onGameLaunched={(game) => showToast(`Dispatched intent for ${game}!`, 'success')}
              />

              {/* Understated Policy Note */}
              <div className="p-4 rounded-2xl bg-[#0E121E]/60 border border-white/[0.04] text-xs flex items-start gap-2.5 text-zinc-400">
                <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                <p className="text-[11px] leading-relaxed">
                  ₦100 per match opportunity regardless of match duration. Hold passes for multiple games simultaneously with zero secondary debits on launch.
                </p>
              </div>
            </div>
          )}

          {/* TAB 2: WALLET */}
          {activeTab === 'wallet' && (
            <div className="space-y-5 animate-in fade-in duration-200">
              {/* Fintech Esports Digital Card */}
              <div className="relative overflow-hidden rounded-3xl bg-[#0E121E] border border-white/[0.08] p-6 shadow-2xl">
                <div className="absolute top-0 right-0 w-64 h-64 bg-emerald-500/5 rounded-full blur-3xl pointer-events-none" />
                <div className="relative z-10 space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] font-black uppercase tracking-wider text-zinc-400">
                      Gaming Hub Balance
                    </span>
                    <span className="text-[10px] font-bold text-emerald-400 bg-emerald-950/70 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                      Active Ledger Protected
                    </span>
                  </div>

                  <div>
                    <div className="text-4xl sm:text-5xl font-black text-white tabular-nums tracking-tight">
                      ₦{(wallet?.balance ?? 0).toLocaleString()}
                    </div>
                    <p className="text-xs text-zinc-400 mt-1">
                      Ready for ₦100 Match Passes · Multi-game holdings enabled
                    </p>
                  </div>

                  {/* Quick Deposit Preset Chips */}
                  <div className="pt-2 border-t border-white/[0.06] flex items-center gap-2">
                    {[500, 1000, 2000].map((amt) => (
                      <button
                        key={amt}
                        type="button"
                        onClick={() => setIsWalletOpen(true)}
                        className="flex-1 py-2 rounded-xl bg-zinc-900 border border-white/[0.06] hover:border-white/20 text-xs font-bold text-zinc-300 hover:text-white transition-all cursor-pointer"
                      >
                        +₦{amt.toLocaleString()}
                      </button>
                    ))}
                  </div>

                  {/* Primary Deposit Action Button */}
                  <button
                    type="button"
                    onClick={() => setIsWalletOpen(true)}
                    className="w-full min-h-[44px] py-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-black text-sm flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 active:scale-98 transition-all cursor-pointer"
                  >
                    <CreditCard className="w-4 h-4" />
                    <span>Deposit Funds with Paystack</span>
                  </button>
                </div>
              </div>

              {/* Transactions Ledger */}
              <div className="space-y-3">
                <div className="flex items-center justify-between px-0">
                  <h3 className="text-xs font-black text-zinc-400 uppercase tracking-wider">
                    Transaction History ({transactions.length})
                  </h3>
                </div>
                {transactions.length === 0 ? (
                  <div className="p-8 rounded-2xl bg-[#0E121E] border border-white/[0.06] text-center text-xs text-zinc-500">
                    No transactions recorded yet. Fund your wallet or grab a match pass.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {transactions.map((tx) => (
                      <div
                        key={tx.id}
                        className="p-3.5 rounded-2xl bg-[#0E121E] border border-white/[0.04] flex items-center justify-between text-xs"
                      >
                        <div className="flex items-center gap-3">
                          <div
                            className={`w-8 h-8 rounded-xl flex items-center justify-center ${
                              tx.type === 'credit'
                                ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/40'
                                : 'bg-zinc-900 text-zinc-400 border border-white/5'
                            }`}
                          >
                            {tx.type === 'credit' ? (
                              <ArrowDownLeft className="w-4 h-4" />
                            ) : (
                              <ArrowUpRight className="w-4 h-4" />
                            )}
                          </div>
                          <div>
                            <div className="font-bold text-white text-xs">{tx.description}</div>
                            <div className="text-[10px] text-zinc-500 font-mono">
                              Ref #{tx.reference.slice(-6).toUpperCase()}
                            </div>
                          </div>
                        </div>
                        <div className="text-right">
                          <div
                            className={`font-black text-xs tabular-nums ${
                              tx.type === 'credit' ? 'text-emerald-400' : 'text-zinc-300'
                            }`}
                          >
                            {tx.type === 'credit' ? '+' : '-'}₦{tx.amount.toLocaleString()}
                          </div>
                          <div className="text-[10px] text-zinc-500">
                            {new Date(tx.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TAB 2: MATCHES (Passes & Live Rooms) */}
          {activeTab === 'sessions' && (
            <div className="space-y-4 animate-in fade-in duration-200">
              {/* Match Hub Section Switcher */}
              <div className="flex items-center gap-2 p-1 bg-[#0E121E] border border-white/[0.06] rounded-2xl shadow-sm">
                <button
                  type="button"
                  onClick={() => setMatchesSubTab('passes')}
                  className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                    matchesSubTab === 'passes'
                      ? 'bg-emerald-500 text-zinc-950 font-black shadow-md shadow-emerald-500/20'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  <Ticket className="w-3.5 h-3.5" />
                  <span>Match Passes (₦100)</span>
                </button>
                <button
                  type="button"
                  onClick={() => setMatchesSubTab('rooms')}
                  className={`flex-1 py-2 px-3 rounded-xl text-xs font-bold transition-all flex items-center justify-center gap-1.5 cursor-pointer ${
                    matchesSubTab === 'rooms'
                      ? 'bg-emerald-500 text-zinc-950 font-black shadow-md shadow-emerald-500/20'
                      : 'text-zinc-400 hover:text-white'
                  }`}
                >
                  <Radio className="w-3.5 h-3.5" />
                  <span>Live Match Rooms</span>
                </button>
              </div>

              {matchesSubTab === 'passes' ? (
                <>
                  <MatchOpportunityManager
                    opportunities={opportunities}
                    walletBalance={wallet?.balance ?? 0}
                    onPurchaseOpportunity={handlePurchaseOpportunity}
                    onLaunchOpportunity={handleLaunchOpportunity}
                    onRefundOpportunity={handleRefundOpportunity}
                    onCompleteOpportunity={handleCompleteOpportunity}
                    onRefresh={fetchOpportunities}
                    isLoading={isLoadingOpportunities}
                    onBrowseGames={() => setActiveTab('hub')}
                  />

                  {/* Stage 3 Architecture Explanation */}
                  <div className="p-4 rounded-2xl bg-[#0E131F] border border-zinc-800/80 text-xs space-y-2">
                    <h3 className="font-extrabold text-zinc-100 flex items-center gap-2">
                      <ShieldCheck className="w-4 h-4 text-emerald-400" />
                      <span>Match Opportunity Architecture</span>
                    </h3>
                    <ul className="text-[11px] text-zinc-400 leading-relaxed space-y-1.5 list-disc list-inside">
                      <li>
                        <strong className="text-zinc-200">₦100 / Match:</strong> Purchasing an opportunity atomically deducts ₦100 from your server wallet and records an immutable ledger entry.
                      </li>
                      <li>
                        <strong className="text-zinc-200">No Duration Limit:</strong> Covers one normal match in the selected game, regardless of match duration. Not an hourly subscription or wager.
                      </li>
                      <li>
                        <strong className="text-zinc-200">Multi-Game Holdings:</strong> Hold match opportunities for different games simultaneously without a global single-active-session restriction.
                      </li>
                      <li>
                        <strong className="text-zinc-200">Zero Launch Charge:</strong> Launching a match uses an already purchased opportunity and never charges a second time.
                      </li>
                      <li>
                        <strong className="text-zinc-200">Cancellation Policy:</strong> An opportunity cancelled before launch restores ₦100 to your wallet. Once launched, matches are non-refundable upon disconnect or game closure.
                      </li>
                    </ul>
                  </div>
                </>
              ) : (
                <LiveRoomsHub
                  currentUser={currentUser}
                  onSelectRoom={(room) => setSelectedRoom(room)}
                  onOpenAuth={() => setIsAuthOpen(true)}
                />
              )}
            </div>
          )}

          {/* TAB 4: PROFILE */}
          {activeTab === 'profile' && (
            <div className="space-y-5 animate-in fade-in duration-200">
              {/* Gamer Profile Card */}
              <div className="p-6 rounded-3xl bg-[#0E121E] border border-white/[0.08] text-center shadow-xl relative overflow-hidden">
                <div className="w-20 h-20 rounded-2xl mx-auto mb-3 bg-gradient-to-br from-zinc-800 to-zinc-950 border-2 border-emerald-500/50 flex items-center justify-center font-black text-emerald-400 text-2xl shadow-lg shadow-emerald-500/10">
                  {currentUser?.displayName?.slice(0, 2).toUpperCase() || 'GH'}
                </div>
                <h3 className="font-black text-lg text-white">
                  {currentUser?.displayName || 'Guest Player'}
                </h3>
                <p className="text-xs text-zinc-400 font-mono mt-0.5">
                  {currentUser?.phoneNumber || (currentUser ? `Gamer ID #${currentUser.id.slice(-8).toUpperCase()}` : 'Unregistered Guest Session')}
                </p>
                <div className="mt-3 flex items-center justify-center gap-2">
                  <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[10px] font-bold border ${
                    currentUser
                      ? 'bg-emerald-950/80 text-emerald-300 border-emerald-500/40'
                      : 'bg-zinc-900 text-zinc-400 border-white/10'
                  }`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${currentUser ? 'bg-emerald-400' : 'bg-zinc-500'}`} />
                    {currentUser ? `Status: ${currentUser.role.toUpperCase()}` : 'Guest Session'}
                  </span>
                </div>
              </div>

              {/* Quick Account Shortcuts */}
              <div className="grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => setIsWalletOpen(true)}
                  className="p-4 rounded-2xl bg-[#0E121E] border border-white/[0.06] hover:border-white/20 text-left transition-all active:scale-[0.98] cursor-pointer"
                >
                  <div className="text-[10px] font-black uppercase tracking-wider text-zinc-400">Wallet Balance</div>
                  <div className="text-xl font-black text-white tabular-nums mt-0.5">
                    ₦{(wallet?.balance ?? 0).toLocaleString()}
                  </div>
                  <div className="text-[11px] text-emerald-400 font-bold mt-1">+ Deposit Funds</div>
                </button>
                <button
                  type="button"
                  onClick={() => setActiveTab('sessions')}
                  className="p-4 rounded-2xl bg-[#0E121E] border border-white/[0.06] hover:border-white/20 text-left transition-all active:scale-[0.98] cursor-pointer"
                >
                  <div className="text-[10px] font-black uppercase tracking-wider text-zinc-400">Match Deck</div>
                  <div className="text-xl font-black text-white tabular-nums mt-0.5">
                    {opportunities.filter((o) => o.status === 'available' || o.status === 'launched').length}
                  </div>
                  <div className="text-[11px] text-zinc-400 font-bold mt-1">View Deck →</div>
                </button>
              </div>

              {/* Authentication & Security Management */}
              <div className="p-4 rounded-2xl bg-[#0E121E] border border-white/[0.06] flex items-center justify-between gap-3">
                <div>
                  <div className="text-xs font-black text-white">
                    {currentUser ? 'Switch or Verify Account' : 'Sign In to Gaming Hub'}
                  </div>
                  <div className="text-[11px] text-zinc-400 mt-0.5">
                    {currentUser
                      ? 'Protected by Firebase Phone Authentication'
                      : 'Preserve wallet balance and match opportunities'}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setIsAuthOpen(true)}
                  className="min-h-[40px] px-4 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-white font-black text-xs transition-colors shrink-0 cursor-pointer"
                >
                  {currentUser ? 'Account' : 'Sign In'}
                </button>
              </div>

              {/* Platform & Account Settings */}
              <div className="space-y-2 pt-2 border-t border-zinc-800/80">
                <div className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 px-1">
                  Gaming Hub Platform
                </div>

                {/* Android Discovery Architecture Guide */}
                <button
                  type="button"
                  onClick={() => setIsAndroidGuideOpen(true)}
                  className="w-full p-3.5 rounded-xl bg-[#0E131F] border border-zinc-800 hover:border-zinc-700 text-left transition-all flex items-center justify-between group active:scale-[0.99]"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-300">
                      <Smartphone className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-bold text-zinc-100">Android Discovery Architecture</div>
                      <p className="text-[11px] text-zinc-400">
                        Package visibility &lt;queries&gt;, Intent URIs & runtime bridge
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-zinc-400 group-hover:text-zinc-200 transition-colors" />
                </button>

                {/* Player Authentication & Account Security */}
                <button
                  type="button"
                  onClick={() => setIsAuthOpen(true)}
                  className="w-full p-3.5 rounded-xl bg-[#0E131F] border border-zinc-800 hover:border-zinc-700 text-left transition-all flex items-center justify-between group active:scale-[0.99] cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-9 h-9 rounded-lg bg-zinc-900 border border-zinc-800 flex items-center justify-center text-emerald-400">
                      <ShieldCheck className="w-4 h-4" />
                    </div>
                    <div>
                      <div className="text-xs font-bold text-zinc-100">Player Authentication & Security</div>
                      <p className="text-[11px] text-zinc-400">
                        Manage Google sign-in and verified player credentials
                      </p>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-zinc-400 group-hover:text-zinc-200 transition-colors" />
                </button>
              </div>
            </div>
          )}

        </main>

        {/* Bottom Navigation */}
        <BottomNav
          activeTab={activeTab}
          onChangeTab={setActiveTab}
          hasActiveSession={hasActiveSession}
        />

        {/* Paystack Wallet Modal */}
        <WalletModal
          isOpen={isWalletOpen}
          onClose={() => setIsWalletOpen(false)}
          wallet={wallet}
          transactions={transactions}
          userId={currentUser?.id || ''}
          onPaymentSuccess={() => {
            fetchUserData();
            fetchTransactions();
            fetchOpportunities();
            showToast('Wallet balance updated!', 'success');
          }}
          onOpenAuth={() => {
            setIsWalletOpen(false);
            setIsAuthOpen(true);
          }}
        />

        {/* Phone Authentication Modal */}
        <PhoneAuthModal
          isOpen={isAuthOpen}
          onClose={() => setIsAuthOpen(false)}
          currentUser={currentUser}
          onLoginSuccess={(user) => {
            setCurrentUser(user);
            fetchUserData();
            fetchActiveSession();
            fetchOpportunities();
            fetchTransactions();
            showToast(`Welcome ${user.displayName}!`, 'success');
          }}
        />

        {/* Add Custom Game Modal */}
        <AddCustomGameModal
          isOpen={isAddCustomGameOpen}
          onClose={() => setIsAddCustomGameOpen(false)}
          userId={currentUser?.id || ''}
          onGameAdded={(newGame) => {
            showToast(`${newGame.name} added to universal library!`, 'success');
          }}
        />

        {/* Android Native Discovery Technical Guide Modal */}
        <AndroidNativeGuideModal
          isOpen={isAndroidGuideOpen}
          onClose={() => setIsAndroidGuideOpen(false)}
        />

        {/* Live Match Room & Chat Modal */}
        {selectedRoom && (
          <RoomViewModal
            room={selectedRoom}
            currentUser={currentUser}
            onClose={() => setSelectedRoom(null)}
            onRoomUpdated={(updated) => setSelectedRoom(updated)}
          />
        )}

      </div>
    </div>
  );
}

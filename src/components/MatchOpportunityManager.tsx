import React, { useState } from 'react';
import {
  Gamepad2,
  Play,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  ShieldCheck,
  RotateCw,
  Flame,
  ArrowRight,
  Ticket,
} from 'lucide-react';
import { MatchOpportunity, OpportunityStatus } from '../types.js';

interface MatchOpportunityManagerProps {
  opportunities: MatchOpportunity[];
  walletBalance: number;
  onPurchaseOpportunity?: (gameId: string, gameTitle: string) => Promise<void>;
  onLaunchOpportunity: (gameId: string, opportunityId?: string) => Promise<void>;
  onRefundOpportunity: (opportunityId: string) => Promise<void>;
  onCompleteOpportunity: (opportunityId: string) => Promise<void>;
  onRefresh: () => void;
  isLoading: boolean;
  onBrowseGames?: () => void;
}

export const MatchOpportunityManager: React.FC<MatchOpportunityManagerProps> = ({
  opportunities,
  walletBalance: _walletBalance,
  onLaunchOpportunity,
  onRefundOpportunity,
  onCompleteOpportunity,
  onRefresh,
  isLoading,
  onBrowseGames,
}) => {
  const [filterStatus, setFilterStatus] = useState<OpportunityStatus | 'all'>('all');
  const [actionInProgress, setActionInProgress] = useState<string | null>(null);
  const [confirmingRefundId, setConfirmingRefundId] = useState<string | null>(null);

  const availableCount = opportunities.filter((o) => o.status === 'available').length;
  const launchedCount = opportunities.filter((o) => o.status === 'launched').length;
  const completedCount = opportunities.filter((o) => o.status === 'completed').length;
  const refundedCount = opportunities.filter((o) => o.status === 'refunded').length;

  const filteredOpportunities = opportunities.filter((o) => {
    if (filterStatus === 'all') return true;
    return o.status === filterStatus;
  });

  const handleLaunch = async (gameId: string, oppId: string) => {
    try {
      setActionInProgress(`launch_${oppId}`);
      await onLaunchOpportunity(gameId, oppId);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleRefund = async (oppId: string) => {
    try {
      setActionInProgress(`refund_${oppId}`);
      await onRefundOpportunity(oppId);
      setConfirmingRefundId(null);
    } finally {
      setActionInProgress(null);
    }
  };

  const handleComplete = async (oppId: string) => {
    try {
      setActionInProgress(`complete_${oppId}`);
      await onCompleteOpportunity(oppId);
    } finally {
      setActionInProgress(null);
    }
  };

  return (
    <div className="w-full space-y-5">
      {/* Matches Header & Status Summary */}
      <div className="p-5 rounded-3xl bg-[#0E121E] border border-white/[0.06] shadow-xl space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-black text-white tracking-tight flex items-center gap-2">
              <Ticket className="w-5 h-5 text-emerald-400" />
              <span>Match Pass Deck</span>
            </h2>
            <p className="text-xs text-zinc-400 mt-0.5">
              Your purchased match passes ready to play or in progress
            </p>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            className="p-2.5 rounded-xl bg-zinc-900 border border-white/[0.08] hover:border-white/20 text-zinc-300 hover:text-white transition-colors cursor-pointer"
            title="Refresh match passes"
            aria-label="Refresh match passes"
          >
            <RotateCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
          </button>
        </div>

        {/* Status Counters Strip */}
        <div className="grid grid-cols-3 gap-2 p-2.5 rounded-2xl bg-zinc-950/70 border border-white/[0.04] text-center">
          <div className="p-2">
            <div className="text-[10px] font-bold text-emerald-400 uppercase tracking-wider">
              Ready
            </div>
            <div className="text-xl font-black text-white tabular-nums mt-0.5">
              {availableCount}
            </div>
          </div>
          <div className="p-2 border-x border-white/[0.06]">
            <div className="text-[10px] font-bold text-cyan-400 uppercase tracking-wider">
              In Match
            </div>
            <div className="text-xl font-black text-white tabular-nums mt-0.5">
              {launchedCount}
            </div>
          </div>
          <div className="p-2">
            <div className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
              Concluded
            </div>
            <div className="text-xl font-black text-white tabular-nums mt-0.5">
              {completedCount}
            </div>
          </div>
        </div>
      </div>

      {/* Filter Tabs */}
      <div className="flex items-center justify-between gap-2 px-1">
        <div className="text-xs font-black text-zinc-400 uppercase tracking-wider">
          Passes ({opportunities.length})
        </div>
        <div className="flex gap-1.5 overflow-x-auto scrollbar-none py-0.5">
          {[
            { id: 'all' as const, label: 'All' },
            { id: 'available' as const, label: `Ready (${availableCount})` },
            { id: 'launched' as const, label: `In Match (${launchedCount})` },
            { id: 'completed' as const, label: `Done (${completedCount})` },
            ...(refundedCount > 0 ? [{ id: 'refunded' as const, label: `Refunded (${refundedCount})` }] : []),
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilterStatus(tab.id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-bold whitespace-nowrap transition-all cursor-pointer ${
                filterStatus === tab.id
                  ? 'bg-emerald-500 text-zinc-950 shadow-md shadow-emerald-500/20'
                  : 'bg-[#0E121E] text-zinc-400 hover:text-zinc-200 border border-white/[0.06]'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Match Passes List */}
      {filteredOpportunities.length === 0 ? (
        <div className="p-10 rounded-3xl bg-[#0E121E] border border-white/[0.06] text-center space-y-4">
          <div className="w-16 h-16 rounded-2xl bg-zinc-900 border border-white/10 flex items-center justify-center mx-auto text-zinc-500">
            <Gamepad2 className="w-8 h-8" />
          </div>
          <div>
            <h3 className="font-extrabold text-white text-base">Your Match Deck is Empty</h3>
            <p className="text-xs text-zinc-400 mt-1 max-w-sm mx-auto">
              No active matches yet. Choose a game below to get started — ₦100 per match.
            </p>
          </div>
          {onBrowseGames && (
            <button
              type="button"
              onClick={onBrowseGames}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs transition-colors shadow-md shadow-emerald-500/20 active:scale-95 cursor-pointer"
            >
              <span>Browse Games in Hub</span>
              <ArrowRight className="w-4 h-4" />
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5">
          {filteredOpportunities.map((opp) => {
            const isAvailable = opp.status === 'available';
            const isLaunched = opp.status === 'launched';
            const isCompleted = opp.status === 'completed';
            const isRefunded = opp.status === 'refunded';

            return (
              <div
                key={opp.id}
                className={`p-4 rounded-2xl border transition-all flex flex-col justify-between gap-3 shadow-md ${
                  isLaunched
                    ? 'bg-[#0E121E] border-cyan-500/40 shadow-cyan-950/20'
                    : isAvailable
                    ? 'bg-[#0E121E] border-emerald-500/30'
                    : 'bg-[#0E121E]/60 border-white/[0.06] opacity-80'
                }`}
              >
                {/* Header: Title + Status Badge */}
                <div>
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h4 className="text-base font-black text-white truncate">
                        {opp.gameTitle || opp.gameId}
                      </h4>
                      <div className="flex items-center gap-2 text-[11px] text-zinc-400 mt-0.5">
                        <span className="font-bold text-emerald-400">₦100 Match Pass</span>
                        <span>·</span>
                        <span>
                          {new Date(opp.createdAt).toLocaleDateString([], {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })}
                        </span>
                      </div>
                    </div>

                    {/* Status Badge */}
                    <span
                      className={`inline-flex items-center gap-1.5 text-[10px] font-black px-2.5 py-1 rounded-full border shrink-0 ${
                        isAvailable
                          ? 'bg-emerald-950/80 text-emerald-300 border-emerald-500/40'
                          : isLaunched
                          ? 'bg-cyan-950/80 text-cyan-300 border-cyan-500/40'
                          : isCompleted
                          ? 'bg-zinc-800 text-zinc-300 border-zinc-700'
                          : 'bg-amber-950/80 text-amber-300 border-amber-500/40'
                      }`}
                    >
                      {isAvailable && <Play className="w-2.5 h-2.5 fill-emerald-400 text-emerald-400" />}
                      {isLaunched && <Flame className="w-2.5 h-2.5 text-cyan-400 animate-pulse" />}
                      {isCompleted && <CheckCircle2 className="w-2.5 h-2.5 text-zinc-400" />}
                      {isRefunded && <RotateCcw className="w-2.5 h-2.5 text-amber-400" />}
                      <span>
                        {isAvailable
                          ? 'Ready to Launch'
                          : isLaunched
                          ? 'In Match'
                          : isCompleted
                          ? 'Concluded'
                          : 'Refunded'}
                      </span>
                    </span>
                  </div>

                  {/* Active Match Notice */}
                  {isLaunched && (
                    <div className="mt-2.5 p-2.5 rounded-xl bg-cyan-950/40 border border-cyan-800/40 text-[11px] text-cyan-200 flex items-center gap-2">
                      <Flame className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                      <span>Match in progress on device. Disconnect does not automatically refund.</span>
                    </div>
                  )}
                </div>

                {/* Actions Bar */}
                <div className="pt-2.5 border-t border-white/[0.06] flex items-center justify-between gap-2">
                  <div className="text-[10px] text-zinc-400 font-mono">
                    Pass #{opp.id.slice(-6).toUpperCase()}
                  </div>

                  <div className="flex items-center gap-2">
                    {isAvailable && (
                      <>
                        {confirmingRefundId === opp.id ? (
                          <div className="flex items-center gap-1.5 bg-rose-950/80 border border-rose-800/60 px-2 py-1 rounded-xl">
                            <span className="text-[10px] text-rose-300 font-bold">Restore ₦100?</span>
                            <button
                              type="button"
                              onClick={() => handleRefund(opp.id)}
                              disabled={Boolean(actionInProgress)}
                              className="text-[10px] font-black bg-rose-600 hover:bg-rose-500 text-white px-2 py-0.5 rounded shadow cursor-pointer"
                            >
                              {actionInProgress === `refund_${opp.id}` ? '...' : 'Confirm'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmingRefundId(null)}
                              className="text-[10px] text-zinc-300 hover:text-white px-1 cursor-pointer"
                            >
                              Keep
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmingRefundId(opp.id)}
                            disabled={Boolean(actionInProgress)}
                            className="min-h-[40px] px-3 py-1.5 rounded-xl hover:bg-rose-950/30 text-rose-400 hover:text-rose-300 font-bold text-xs transition-colors cursor-pointer"
                          >
                            Cancel & Refund
                          </button>
                        )}

                        <button
                          type="button"
                          onClick={() => handleLaunch(opp.gameId, opp.id)}
                          disabled={Boolean(actionInProgress)}
                          className="min-h-[40px] px-4 py-1.5 rounded-xl bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-black text-xs flex items-center gap-1.5 transition-all shadow-md shadow-emerald-500/20 active:scale-95 cursor-pointer"
                        >
                          <Play className="w-3.5 h-3.5 fill-zinc-950" />
                          <span>
                            {actionInProgress === `launch_${opp.id}` ? 'Launching...' : 'Launch Match'}
                          </span>
                        </button>
                      </>
                    )}

                    {isLaunched && (
                      <>
                        <button
                          type="button"
                          onClick={() => handleLaunch(opp.gameId, opp.id)}
                          disabled={Boolean(actionInProgress)}
                          className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-[#131929] border border-cyan-500/50 hover:bg-cyan-950/40 text-cyan-300 font-black text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
                        >
                          <Play className="w-3.5 h-3.5 fill-cyan-300" />
                          <span>Resume Match</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleComplete(opp.id)}
                          disabled={Boolean(actionInProgress)}
                          className="min-h-[40px] px-3.5 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-zinc-200 font-bold text-xs flex items-center gap-1.5 border border-white/10 transition-colors cursor-pointer"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                          <span>Conclude</span>
                        </button>
                      </>
                    )}

                    {(isCompleted || isRefunded) && (
                      <span className="text-xs text-zinc-400 font-medium">
                        {isCompleted ? 'Match completed' : '₦100 restored'}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Understated Protection Note */}
      <div className="p-4 rounded-2xl bg-[#0E121E]/60 border border-white/[0.04] text-xs flex items-start gap-2.5 text-zinc-400">
        <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
        <p className="text-[11px] leading-relaxed">
          ₦100 per match opportunity regardless of match duration. Hold passes for multiple games simultaneously. Pre-launch cancellation restores ₦100 to your wallet immediately.
        </p>
      </div>
    </div>
  );
};

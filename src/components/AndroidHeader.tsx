import React from 'react';
import { Gamepad2, Plus, User } from 'lucide-react';
import { UserProfile, Wallet } from '../types.js';

interface AndroidHeaderProps {
  wallet: Wallet | null;
  onOpenWallet: () => void;
  hasActiveSession: boolean;
  currentUser?: UserProfile | null;
  onOpenProfile?: () => void;
}

export const AndroidHeader: React.FC<AndroidHeaderProps> = ({
  wallet,
  onOpenWallet,
  hasActiveSession,
  currentUser,
  onOpenProfile,
}) => {
  const balance = wallet?.balance ?? 0;
  const userInitials = currentUser?.displayName
    ? currentUser.displayName.slice(0, 2).toUpperCase()
    : 'GH';

  return (
    <header className="sticky top-0 z-40 bg-[#07090E]/90 backdrop-blur-xl border-b border-white/[0.06] text-zinc-100 select-none transition-colors">
      <div className="flex items-center justify-between gap-3 px-4 py-2.5 max-w-full">
        {/* Brand Mark */}
        <div className="flex items-center gap-2.5 min-w-0 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-zinc-800 to-zinc-950 border border-white/10 flex items-center justify-center shrink-0 shadow-inner">
            <Gamepad2 className="w-5 h-5 text-emerald-400" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-black text-sm tracking-wider text-white">
                GAMING HUB
              </span>
              {hasActiveSession && (
                <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-950/80 border border-emerald-500/30 px-2 py-0.5 rounded-full">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Live Match
                </span>
              )}
            </div>
            <p className="text-[10px] text-zinc-400 font-medium tracking-tight">
              ₦100 / Match Opportunity
            </p>
          </div>
        </div>

        {/* Wallet & Profile Controls */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Wallet Balance Pill */}
          <div className="flex items-center bg-[#0E121E] border border-white/[0.08] rounded-xl p-1 gap-1 shadow-sm">
            <button
              type="button"
              onClick={onOpenWallet}
              aria-label={`Wallet balance: ₦${balance.toLocaleString()}. Tap to view wallet.`}
              className="px-2.5 py-1 text-left hover:bg-white/[0.04] rounded-lg transition-colors cursor-pointer"
            >
              <div className="text-[9px] uppercase tracking-wider text-zinc-400 font-bold leading-tight">
                Wallet
              </div>
              <div className="text-xs font-black text-white tabular-nums leading-tight">
                ₦{balance.toLocaleString()}
              </div>
            </button>
            <button
              type="button"
              onClick={onOpenWallet}
              aria-label="Fund wallet with Paystack"
              className="min-w-[40px] min-h-[36px] px-2.5 py-1 rounded-lg bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-black text-xs flex items-center justify-center gap-1 transition-all shadow-sm active:scale-95 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 stroke-[3]" />
              <span className="hidden sm:inline text-[11px]">Fund</span>
            </button>
          </div>

          {/* Profile / Avatar Button */}
          <button
            type="button"
            onClick={onOpenProfile}
            aria-label="Open gamer profile"
            className="w-10 h-10 rounded-xl bg-[#0E121E] border border-white/[0.08] hover:border-white/20 active:scale-95 flex items-center justify-center text-xs font-bold text-zinc-200 transition-all shrink-0 relative cursor-pointer"
          >
            {currentUser ? (
              <>
                <span className="text-emerald-400 font-black">{userInitials}</span>
                <span className="absolute bottom-1 right-1 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-[#07090E]" />
              </>
            ) : (
              <User className="w-4 h-4 text-zinc-400" />
            )}
          </button>
        </div>
      </div>
    </header>
  );
};

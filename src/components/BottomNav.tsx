import React from 'react';
import { Gamepad2, Swords, Wallet as WalletIcon, User } from 'lucide-react';

export type TabType = 'hub' | 'wallet' | 'sessions' | 'profile';

interface BottomNavProps {
  activeTab: TabType;
  onChangeTab: (tab: TabType) => void;
  hasActiveSession: boolean;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  activeTab,
  onChangeTab,
  hasActiveSession,
}) => {
  const tabs = [
    {
      id: 'hub' as TabType,
      label: 'Hub',
      icon: Gamepad2,
      badge: false,
    },
    {
      id: 'sessions' as TabType,
      label: 'Matches',
      icon: Swords,
      badge: hasActiveSession,
    },
    {
      id: 'wallet' as TabType,
      label: 'Wallet',
      icon: WalletIcon,
      badge: false,
    },
    {
      id: 'profile' as TabType,
      label: 'Profile',
      icon: User,
      badge: false,
    },
  ];

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-40 bg-[#07090E]/95 backdrop-blur-xl border-t border-white/[0.06] w-full"
      style={{ paddingBottom: 'max(0.4rem, env(safe-area-inset-bottom, 8px))' }}
      aria-label="Main Player Navigation"
    >
      <div className="w-full max-w-none md:max-w-3xl lg:max-w-5xl xl:max-w-6xl mx-auto grid grid-cols-4 px-4 py-1">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;

          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => onChangeTab(tab.id)}
              className={`flex flex-col items-center justify-center min-h-[48px] py-1 px-1 rounded-xl transition-all relative select-none cursor-pointer ${
                isActive ? 'text-emerald-400' : 'text-zinc-400 hover:text-zinc-200 active:scale-95'
              }`}
              aria-selected={isActive}
              aria-label={tab.label}
            >
              <div className="relative flex items-center justify-center w-6 h-6">
                <Icon
                  className={`w-5 h-5 transition-transform duration-200 ${
                    isActive ? 'scale-110 stroke-[2.25] text-emerald-400' : 'stroke-[1.75]'
                  }`}
                />
                {tab.badge && (
                  <span
                    className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-emerald-400 ring-2 ring-[#07090E]"
                    title="Active match ready"
                  />
                )}
              </div>
              <span
                className={`text-[10px] mt-1 tracking-tight ${
                  isActive ? 'font-black text-emerald-400' : 'font-medium text-zinc-400'
                }`}
              >
                {tab.label}
              </span>
              {isActive && (
                <span className="w-1.5 h-1 rounded-full bg-emerald-400 mt-0.5" />
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
};

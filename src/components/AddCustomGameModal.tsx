import React, { useState } from 'react';
import { X, Plus, AlertCircle, Gamepad2, Package } from 'lucide-react';
import { GameCategory, SupportedGame } from '../types.js';
import { authFetch } from '../lib/firebase.js';

interface AddCustomGameModalProps {
  isOpen: boolean;
  onClose: () => void;
  userId: string;
  onGameAdded: (game: SupportedGame) => void;
}

export const AddCustomGameModal: React.FC<AddCustomGameModalProps> = ({
  isOpen,
  onClose,
  userId,
  onGameAdded,
}) => {
  const [name, setName] = useState('');
  const [packageId, setPackageId] = useState('');
  const [category, setCategory] = useState<GameCategory>('Shooter');
  const [description, setDescription] = useState('');
  const [iconUrl, setIconUrl] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const categories: GameCategory[] = [
    'Battle Royale',
    'Shooter',
    'MOBA',
    'Sports & Racing',
    'Action & RPG',
    'Custom',
  ];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // Validate package ID format
    const trimmedPkg = packageId.trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(trimmedPkg)) {
      setError('Invalid Android package name format (e.g. com.developer.gamename)');
      return;
    }

    setIsLoading(true);
    try {
      const res = await authFetch('/api/games/custom', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          packageId: trimmedPkg,
          category,
          description: description.trim() || `Custom mobile game ${name}.`,
          iconUrl: iconUrl.trim() || undefined,
        }),
      });

      if (res.status === 401) {
        throw new Error('Authentication required. Please sign in to add games.');
      }

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to add custom game');
      }

      onGameAdded(data.game);
      onClose();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
      <div className="relative w-full max-w-sm bg-[#0a0e1a] border border-cyan-500/30 rounded-3xl overflow-hidden shadow-2xl p-5">
        <div className="flex justify-between items-center mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-cyan-500/20 border border-cyan-400 flex items-center justify-center">
              <Gamepad2 className="w-4 h-4 text-cyan-400" />
            </div>
            <div>
              <h3 className="font-black text-sm text-white">Add Custom Mobile Game</h3>
              <p className="text-[10px] text-slate-400">Universal Android Library</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-xl bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="mb-3 p-2.5 rounded-xl bg-rose-950/60 border border-rose-500/40 text-rose-300 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="text-[11px] font-bold text-slate-300 uppercase block mb-1">
              Game Title *
            </label>
            <input
              type="text"
              placeholder="e.g. Blood Strike, Stumble Guys"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full bg-slate-900 border border-slate-800 rounded-xl py-2 px-3 text-white text-xs placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
            />
          </div>

          <div>
            <label className="text-[11px] font-bold text-slate-300 uppercase block mb-1">
              Android Package ID *
            </label>
            <div className="relative">
              <Package className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
              <input
                type="text"
                placeholder="e.g. com.netease.projectblood"
                value={packageId}
                onChange={(e) => setPackageId(e.target.value)}
                required
                className="w-full bg-slate-900 border border-slate-800 rounded-xl py-2 pl-9 pr-3 text-white text-xs font-mono placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
              />
            </div>
            <p className="text-[9px] text-slate-500 mt-0.5">Found in Google Play Store URL (?id=...)</p>
          </div>

          <div>
            <label className="text-[11px] font-bold text-slate-300 uppercase block mb-1">
              Category
            </label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as GameCategory)}
              className="w-full bg-slate-900 border border-slate-800 rounded-xl py-2 px-3 text-white text-xs focus:outline-none focus:border-cyan-400"
            >
              {categories.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-bold text-slate-300 uppercase block mb-1">
              Description (Optional)
            </label>
            <input
              type="text"
              placeholder="Short game overview"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full bg-slate-900 border border-slate-800 rounded-xl py-2 px-3 text-white text-xs placeholder:text-slate-500 focus:outline-none focus:border-cyan-400"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full mt-2 bg-gradient-to-r from-cyan-500 to-indigo-600 text-white font-extrabold text-xs py-3 rounded-xl shadow-md transition-all active:scale-95 disabled:opacity-50 flex items-center justify-center gap-1.5"
          >
            <Plus className="w-4 h-4" />
            <span>{isLoading ? 'Adding Game...' : 'Add Game to Hub'}</span>
          </button>
        </form>
      </div>
    </div>
  );
};

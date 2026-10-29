import React from 'react';
import { X, ShieldAlert, Cpu, CheckCircle2, Code2, ExternalLink } from 'lucide-react';

interface AndroidNativeGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export const AndroidNativeGuideModal: React.FC<AndroidNativeGuideModalProps> = ({
  isOpen,
  onClose,
}) => {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-in fade-in">
      <div className="relative w-full max-w-md bg-[#0a0e1a] border border-cyan-500/40 rounded-3xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800 bg-slate-900/60">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-cyan-500/20 border border-cyan-400 flex items-center justify-center">
              <Cpu className="w-4 h-4 text-cyan-400" />
            </div>
            <div>
              <h3 className="font-black text-sm text-white">Android Discovery Architecture</h3>
              <p className="text-[10px] text-slate-400">Technical Runtime & Platform Constraints</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-xl bg-slate-800 text-slate-400 hover:text-white flex items-center justify-center"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto space-y-4 text-xs text-slate-300 leading-relaxed">
          {/* Current Runtime status */}
          <div className="p-3.5 rounded-2xl bg-cyan-950/40 border border-cyan-500/30 space-y-1">
            <div className="flex items-center justify-between">
              <span className="font-bold text-white text-xs">Current Project Architecture</span>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-900/80 text-cyan-300 font-bold">
                Web App / PWA
              </span>
            </div>
            <p className="text-[11px] text-slate-300">
              The project is running on React 19 + TypeScript + Vite + Express.
            </p>
          </div>

          {/* Browser Sandbox Limitation */}
          <div className="p-3.5 rounded-2xl bg-amber-950/30 border border-amber-500/30 space-y-1.5">
            <div className="flex items-center gap-1.5 text-amber-400 font-bold text-xs">
              <ShieldAlert className="w-4 h-4" />
              <span>Web Sandbox Security Restriction</span>
            </div>
            <p className="text-[11px] text-slate-300 leading-relaxed">
              In standard mobile browsers (Chrome, Firefox, etc.), JavaScript is sandboxed and <strong>cannot enumerate installed applications or access the device’s PackageManager</strong>. This is an intentional Android security policy to prevent user tracking.
            </p>
          </div>

          {/* Native Solution */}
          <div className="space-y-2">
            <h4 className="font-bold text-white flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-400" />
              Native Android Bridge & Package Visibility Solution
            </h4>
            <p className="text-[11px] text-slate-300">
              To discover installed games automatically, this applet includes ready-to-build native reference files:
            </p>

            <div className="space-y-1.5 text-[11px] font-mono">
              <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
                <span className="text-cyan-400 font-bold block mb-0.5">1. android/AndroidManifest.xml</span>
                <span className="text-slate-400">
                  Declares targeted <code className="text-emerald-400">&lt;queries&gt;</code> for supported game package IDs (respecting Android 11+ policy).
                </span>
              </div>

              <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800">
                <span className="text-cyan-400 font-bold block mb-0.5">2. android/AndroidBridge.kt</span>
                <span className="text-slate-400">
                  Implements <code className="text-indigo-400">@JavascriptInterface</code> with <code className="text-white">isPackageInstalled()</code> and <code className="text-white">launchPackage()</code>.
                </span>
              </div>
            </div>
          </div>

          {/* How Universal Launching Works Now */}
          <div className="p-3 rounded-2xl bg-slate-900/60 border border-slate-800 space-y-1">
            <span className="font-bold text-white block">Universal Launching in Web Mode</span>
            <p className="text-[11px] text-slate-400">
              In the browser, games are launched via standard <strong>Android Intent URIs</strong> (<code className="text-cyan-400">intent://#Intent;package=...;end</code>). If an app is not installed, it gracefully opens the Google Play Store. Users can also manually toggle installation verification.
            </p>
          </div>

          <button
            onClick={onClose}
            className="w-full bg-gradient-to-r from-cyan-500 to-indigo-600 text-white font-bold py-2.5 rounded-xl text-xs"
          >
            Got it, Return to Game Hub
          </button>
        </div>
      </div>
    </div>
  );
};

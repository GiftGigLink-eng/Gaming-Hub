import React, { useState, useEffect, useRef } from 'react';
import { X, ShieldCheck, AlertCircle, CheckCircle2, RefreshCw, UserCheck, LogOut, Sparkles } from 'lucide-react';
import { UserProfile } from '../types.js';
import { auth } from '../lib/firebase.js';
import {
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCredential,
  signOut,
} from 'firebase/auth';

interface PhoneAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserProfile | null;
  onLoginSuccess: (user: UserProfile) => void;
}

export const PhoneAuthModal: React.FC<PhoneAuthModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  onLoginSuccess,
}) => {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Track active native sign-in request to prevent leaks & duplicates
  const pendingNativeRequestRef = useRef<string | null>(null);

  // Set up native auth listener for responses dispatched from MainActivity
  useEffect(() => {
    const handleNativeAuthResponse = async (event: Event) => {
      const customEvent = event as CustomEvent<{
        type: 'success' | 'cancelled' | 'error';
        requestId: string;
        idToken?: string;
        error?: string;
      }>;

      const detail = customEvent.detail;
      if (!detail) return;

      // Ignore events not matching the active pending request
      if (pendingNativeRequestRef.current && detail.requestId !== pendingNativeRequestRef.current) {
        return;
      }

      pendingNativeRequestRef.current = null;

      if (detail.type === 'cancelled') {
        setIsLoading(false);
        setError('Sign-in cancelled. Tap below whenever you are ready to continue.');
        return;
      }

      if (detail.type === 'error') {
        setIsLoading(false);
        const codeSuffix = detail.errorCode ? ` [Code: ${detail.errorCode}]` : '';
        setError((detail.error || 'Native Google Sign-In failed.') + codeSuffix);
        return;
      }

      if (detail.type === 'success' && detail.idToken) {
        try {
          // Exchange Google ID Token with Firebase Web SDK
          const credential = GoogleAuthProvider.credential(detail.idToken);
          const userCredential = await signInWithCredential(auth, credential);
          const firebaseUser = userCredential.user;
          const token = await firebaseUser.getIdToken();

          // Initialize or fetch user profile & wallet on server
          const res = await fetch('/api/auth/user', {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          });

          const data = await res.json();
          if (!res.ok || !data.success) {
            throw new Error(data.error || 'Failed to initialize player session.');
          }

          setSuccessMsg(`Welcome, ${data.user.displayName || firebaseUser.displayName || 'Player'}!`);
          onLoginSuccess(data.user);
          setTimeout(() => {
            onClose();
          }, 700);
        } catch (err: any) {
          setError(err.message || 'Failed to complete authentication with Gaming Hub.');
        } finally {
          setIsLoading(false);
        }
      }
    };

    window.addEventListener('gaminghub:native_auth_response', handleNativeAuthResponse);
    return () => {
      window.removeEventListener('gaminghub:native_auth_response', handleNativeAuthResponse);
    };
  }, [onClose, onLoginSuccess]);

  if (!isOpen) return null;

  const handleGoogleSignIn = async () => {
    if (isLoading) return; // Prevent duplicate requests
    setIsLoading(true);
    setError(null);
    setSuccessMsg(null);

    // Detect if running inside the Native Android APK wrapper
    const isNativeAndroid = typeof window !== 'undefined' && Boolean(window.AndroidBridge?.triggerGoogleSignIn);

    if (isNativeAndroid) {
      // Use Android Native Credential Manager Flow
      const requestId = `auth_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
      pendingNativeRequestRef.current = requestId;

      try {
        window.AndroidBridge!.triggerGoogleSignIn!(requestId);
      } catch (nativeErr: any) {
        pendingNativeRequestRef.current = null;
        setIsLoading(false);
        setError('Could not invoke native Android Credential Manager: ' + (nativeErr?.message || 'unknown error'));
      }
      return;
    }

    // Standard Browser / PWA Flow (Desktop, mobile Chrome/Safari, etc.)
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const userCredential = await signInWithPopup(auth, provider);
      const firebaseUser = userCredential.user;
      const token = await firebaseUser.getIdToken();

      // Authenticate with server to create/retrieve Firestore profile & wallet
      const res = await fetch('/api/auth/user', {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error || 'Failed to initialize player session.');
      }

      setSuccessMsg(`Welcome, ${data.user.displayName || firebaseUser.displayName || 'Player'}!`);
      onLoginSuccess(data.user);
      setTimeout(() => {
        onClose();
      }, 700);
    } catch (err: any) {
      if (err.code === 'auth/popup-closed-by-user') {
        setError('Sign-in pop-up was closed before completing. Tap below whenever you are ready.');
      } else if (err.code === 'auth/popup-blocked') {
        setError('Pop-up was blocked by your browser. Please allow pop-ups for Gaming Hub and try again.');
      } else if (err.code === 'auth/unauthorized-domain') {
        setError(
          'This web domain is not yet on the Firebase Authorized Domains list. Please add this domain in Firebase Console under Authentication > Settings > Authorized Domains.'
        );
      } else if (err.code === 'auth/cancelled-popup-request') {
        setError(null);
      } else {
        setError(err.message || 'Failed to sign in with Google. Please try again.');
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignOut = async () => {
    setIsLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      await signOut(auth);
      setSuccessMsg('Signed out successfully.');
      setTimeout(() => {
        onClose();
      }, 500);
    } catch (err: any) {
      setError(err.message || 'Failed to sign out.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-md bg-[#0E121E] border border-white/[0.08] rounded-3xl overflow-hidden shadow-2xl p-6 max-h-[90vh] overflow-y-auto space-y-4">
        {/* Modal Header */}
        <div className="flex justify-between items-center pb-3 border-b border-white/[0.06]">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-zinc-900 border border-white/10 flex items-center justify-center text-emerald-400">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-black text-base text-white">Player Authentication</h3>
              <p className="text-[11px] text-zinc-400">Zero-Trust Identity Foundation</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-xl bg-zinc-900 text-zinc-400 hover:text-white flex items-center justify-center cursor-pointer transition-colors"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Error Notification */}
        {error && (
          <div className="p-3.5 rounded-2xl bg-rose-950/80 border border-rose-800/80 text-rose-300 text-xs flex items-start gap-2.5 animate-in fade-in">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="flex-1 text-[11px] leading-relaxed">{error}</div>
          </div>
        )}

        {/* Success Notification */}
        {successMsg && (
          <div className="p-3.5 rounded-2xl bg-emerald-950/80 border border-emerald-800/80 text-emerald-300 text-xs flex items-start gap-2.5 animate-in fade-in">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
            <div className="flex-1 text-[11px] leading-relaxed">{successMsg}</div>
          </div>
        )}

        {/* Authenticated Player Profile State */}
        {currentUser ? (
          <div className="space-y-4">
            <div className="p-4 rounded-2xl bg-zinc-900/90 border border-white/[0.06] space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-black uppercase tracking-wider text-zinc-400">
                  Active Player Profile
                </span>
                <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-950/80 text-emerald-400 border border-emerald-800/60">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Authenticated
                </span>
              </div>

              <div className="flex items-center gap-3 pt-1">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-zinc-800 to-zinc-950 border border-emerald-500/40 flex items-center justify-center text-emerald-400 font-black text-base shadow-inner shrink-0">
                  {currentUser.displayName ? currentUser.displayName.slice(0, 2).toUpperCase() : 'GH'}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-black text-white truncate flex items-center gap-1.5">
                    <UserCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                    <span>{currentUser.displayName}</span>
                  </div>
                  <div className="text-[11px] text-zinc-400 font-mono truncate mt-0.5">
                    ID: {currentUser.id}
                  </div>
                  {auth.currentUser?.email && (
                    <div className="text-[10px] text-zinc-400 truncate">
                      {auth.currentUser.email}
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="p-3.5 rounded-2xl bg-emerald-950/30 border border-emerald-900/40 flex items-center gap-2.5 text-xs text-emerald-300">
              <Sparkles className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="text-[11px] leading-relaxed">
                Wallet balance and ₦100 match passes are securely synchronized with Firestore.
              </span>
            </div>

            <button
              type="button"
              onClick={handleSignOut}
              disabled={isLoading}
              className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 hover:border-rose-900/50 text-rose-300 hover:text-rose-200 text-xs font-bold transition-all flex items-center justify-center gap-2 cursor-pointer active:scale-[0.98] disabled:opacity-50"
            >
              {isLoading ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-rose-300" />
                  <span>Signing Out...</span>
                </>
              ) : (
                <>
                  <LogOut className="w-3.5 h-3.5" />
                  <span>Sign Out of Gaming Hub</span>
                </>
              )}
            </button>
          </div>
        ) : (
          /* Unauthenticated / Sign In State */
          <div className="space-y-4">
            <div className="p-4 rounded-2xl bg-zinc-900/80 border border-white/[0.06] space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[10px] font-black uppercase tracking-wider text-zinc-400">
                  Guest Session
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-full font-bold bg-zinc-800 text-zinc-400 border border-white/10">
                  UNREGISTERED
                </span>
              </div>
              <p className="text-xs text-zinc-300 leading-relaxed pt-1">
                Sign in with your Google account to access your esports wallet, fund match passes with Paystack, and track multi-game tournament opportunities.
              </p>
            </div>

            {/* Google Sign-In Action Button */}
            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={isLoading}
              className="w-full min-h-[48px] py-3 px-4 rounded-2xl bg-white hover:bg-zinc-100 active:bg-zinc-200 text-zinc-900 font-extrabold text-sm shadow-xl transition-all active:scale-[0.98] disabled:opacity-60 flex items-center justify-center gap-3 cursor-pointer select-none"
            >
              {isLoading ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin text-zinc-900" />
                  <span>Connecting to Google...</span>
                </>
              ) : (
                <>
                  {/* Google "G" Colored SVG Icon */}
                  <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
                    <path
                      fill="#4285F4"
                      d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                    />
                    <path
                      fill="#34A853"
                      d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                    />
                    <path
                      fill="#FBBC05"
                      d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                    />
                    <path
                      fill="#EA4335"
                      d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                    />
                  </svg>
                  <span>Sign in with Google</span>
                </>
              )}
            </button>

            <p className="text-[10px] text-zinc-500 text-center leading-normal">
              Zero-trust authenticated · Passwords are never stored on Gaming Hub
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

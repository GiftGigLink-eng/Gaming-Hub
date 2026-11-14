import React, { useState, useEffect, useRef } from 'react';
import {
  X,
  ShieldCheck,
  AlertCircle,
  CheckCircle2,
  RefreshCw,
  UserCheck,
  LogOut,
  Sparkles,
  Mail,
  Lock,
  ArrowRight,
  KeyRound,
  UserPlus,
  LogIn,
  Link2,
} from 'lucide-react';
import { UserProfile } from '../types.js';
import { auth } from '../lib/firebase.js';
import { authManager } from '../lib/authManager.js';
import {
  signOut,
  sendPasswordResetEmail,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCredential,
  signInWithEmailAndPassword,
} from 'firebase/auth';
import { validateEmail, validatePassword, getAuthErrorMessage } from '../lib/authValidation.js';

interface PhoneAuthModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentUser: UserProfile | null;
  onLoginSuccess: (user: UserProfile) => void;
}

type AuthMode = 'signin' | 'register' | 'forgot_password' | 'link_account';

export const PhoneAuthModal: React.FC<PhoneAuthModalProps> = ({
  isOpen,
  onClose,
  currentUser,
  onLoginSuccess,
}) => {
  const [authMode, setAuthMode] = useState<AuthMode>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  // Account-linking state: holds temporary Firebase ID token when linking is required
  const [firebaseIdTokenForLinking, setFirebaseIdTokenForLinking] = useState<string | null>(null);
  const [firebasePasswordForVerify, setFirebasePasswordForVerify] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  // Track active native Google sign-in request to prevent leaks & duplicates
  const pendingNativeRequestRef = useRef<string | null>(null);

  // Set up native auth listener for responses dispatched from MainActivity
  useEffect(() => {
    const handleNativeAuthResponse = async (event: Event) => {
      const customEvent = event as CustomEvent<{
        type: 'success' | 'cancelled' | 'error';
        requestId: string;
        idToken?: string;
        errorCode?: string;
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
        setError('Google sign-in was cancelled by player.');
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
          setError(getAuthErrorMessage(err));
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

  // Reset transient fields when modal opens or closes
  const resetForm = () => {
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setDisplayName('');
    setFirebaseIdTokenForLinking(null);
    setFirebasePasswordForVerify('');
    setError(null);
    setSuccessMsg(null);
  };

  const handleModeChange = (newMode: AuthMode) => {
    setAuthMode(newMode);
    setError(null);
    setSuccessMsg(null);
  };

  // Primary: Gaming Hub Independent Registration (Stage 3.3)
  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;

    setError(null);
    setSuccessMsg(null);

    const emailCheck = validateEmail(email);
    if (!emailCheck.valid) {
      setError(emailCheck.error!);
      return;
    }

    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      setError(passwordCheck.error!);
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match. Please re-enter.');
      return;
    }

    setIsLoading(true);

    try {
      const regResult = await authManager.register({
        email: email.trim(),
        password,
        displayName: displayName.trim() || undefined,
      });

      if (!regResult.success) {
        if (regResult.code === 'FIREBASE_ACCOUNT_EXISTS_LINKING_REQUIRED') {
          // Existing Firebase account detected: prompt linking flow with ownership verification
          setAuthMode('link_account');
          setError(
            'An existing Gaming Hub player account was found with this email. Please verify your existing password to link independent credentials without losing your identity or wallet balance.'
          );
          return;
        }
        throw new Error(regResult.error || 'Registration failed.');
      }

      // Fetch user profile and wallet to synchronize state
      const res = await authManager.fetch('/api/auth/user');
      const data = await res.json();
      const finalUser: UserProfile = data.user || {
        id: regResult.user!.id,
        displayName: regResult.user!.displayName || displayName || 'Player',
        phoneNumber: '',
        role: regResult.user!.role || 'user',
        createdAt: regResult.user!.createdAt || new Date().toISOString(),
      };

      setSuccessMsg(`Account created! Welcome, ${finalUser.displayName}!`);
      onLoginSuccess(finalUser);
      setTimeout(() => {
        onClose();
        resetForm();
      }, 700);
    } catch (err: any) {
      setError(getAuthErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  // Primary: Gaming Hub Independent Sign-In (Stage 3.3)
  const handleEmailSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;

    setError(null);
    setSuccessMsg(null);

    const emailCheck = validateEmail(email);
    if (!emailCheck.valid) {
      setError(emailCheck.error!);
      return;
    }

    if (!password) {
      setError('Password is required.');
      return;
    }

    setIsLoading(true);

    try {
      // 1. Attempt login with Gaming Hub independent credentials
      const loginResult = await authManager.login({
        email: email.trim(),
        password,
      });

      if (loginResult.success) {
        // Fetch synchronized profile & wallet via authManager
        const res = await authManager.fetch('/api/auth/user');
        const data = await res.json();
        const profile: UserProfile = data.user || {
          id: loginResult.user!.id,
          displayName: loginResult.user!.displayName || 'Player',
          phoneNumber: '',
          role: loginResult.user!.role || 'user',
          createdAt: loginResult.user!.createdAt || new Date().toISOString(),
        };

        setSuccessMsg(`Welcome back, ${profile.displayName}!`);
        onLoginSuccess(profile);
        setTimeout(() => {
          onClose();
          resetForm();
        }, 700);
        return;
      }

      // 2. If independent login failed with INVALID_CREDENTIALS, check if this is an unmigrated Firebase account
      if (loginResult.code === 'INVALID_CREDENTIALS') {
        try {
          // Attempt Firebase login to detect if existing member hasn't set up independent credentials yet
          const fbCred = await signInWithEmailAndPassword(auth, email.trim(), password);
          const fbToken = await fbCred.user.getIdToken();

          if (fbToken) {
            // Unmigrated Firebase user authenticated! Automatically link credentials to preserve UID & wallet
            const linkResult = await authManager.linkCredentials({
              firebaseIdToken: fbToken,
              password,
              email: email.trim(),
              displayName: fbCred.user.displayName || displayName || undefined,
            });

            if (linkResult.success) {
              const res = await authManager.fetch('/api/auth/user');
              const data = await res.json();
              const profile: UserProfile = data.user || {
                id: fbCred.user.uid,
                displayName: fbCred.user.displayName || 'Player',
                phoneNumber: '',
                role: 'user',
                createdAt: new Date().toISOString(),
              };

              setSuccessMsg(`Welcome back, ${profile.displayName}! Account upgraded to Gaming Hub credentials.`);
              onLoginSuccess(profile);
              setTimeout(() => {
                onClose();
                resetForm();
              }, 700);
              return;
            }
          }
        } catch (fbErr: any) {
          // Firebase login also failed: show standard invalid credentials error
        }
      }

      throw new Error(loginResult.error || 'Incorrect email or password.');
    } catch (err: any) {
      setError(getAuthErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  // Account Linking: Link existing Firebase account to independent credentials (Stage 3.3)
  const handleLinkExistingAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;

    setError(null);
    setSuccessMsg(null);

    const emailCheck = validateEmail(email);
    if (!emailCheck.valid) {
      setError(emailCheck.error!);
      return;
    }

    if (!firebasePasswordForVerify) {
      setError('Please enter your existing password to verify account ownership.');
      return;
    }

    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      setError(passwordCheck.error!);
      return;
    }

    if (password !== confirmPassword) {
      setError('New passwords do not match. Please re-enter.');
      return;
    }

    setIsLoading(true);

    try {
      // 1. Verify ownership by authenticating with Firebase
      const fbCred = await signInWithEmailAndPassword(auth, email.trim(), firebasePasswordForVerify);
      const fbToken = await fbCred.user.getIdToken();

      if (!fbToken) {
        throw new Error('Could not retrieve verified token from Firebase account.');
      }

      // 2. Link independent credentials with cryptographic proof of ownership
      const linkResult = await authManager.linkCredentials({
        firebaseIdToken: fbToken,
        password,
        email: email.trim(),
        displayName: fbCred.user.displayName || displayName || undefined,
      });

      if (!linkResult.success) {
        throw new Error(linkResult.error || 'Account linking failed.');
      }

      // 3. Fetch synchronized profile & wallet
      const res = await authManager.fetch('/api/auth/user');
      const data = await res.json();
      const profile: UserProfile = data.user || {
        id: fbCred.user.uid,
        displayName: fbCred.user.displayName || 'Player',
        phoneNumber: '',
        role: 'user',
        createdAt: new Date().toISOString(),
      };

      setSuccessMsg(`Credentials linked! Welcome, ${profile.displayName}! Your wallet and identity are preserved.`);
      onLoginSuccess(profile);
      setTimeout(() => {
        onClose();
        resetForm();
      }, 700);
    } catch (err: any) {
      setError(getAuthErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  // Primary: Password Reset
  const handlePasswordReset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isLoading) return;

    setError(null);
    setSuccessMsg(null);

    const emailCheck = validateEmail(email);
    if (!emailCheck.valid) {
      setError(emailCheck.error!);
      return;
    }

    setIsLoading(true);

    try {
      await sendPasswordResetEmail(auth, email.trim());
      setSuccessMsg(`Password reset email sent to ${email.trim()}! Please check your inbox and spam folder.`);
    } catch (err: any) {
      setError(getAuthErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  // Secondary Optional: Google Sign-In (Unblocked, available for users with working Google Play Services)
  const handleGoogleSignIn = async () => {
    if (isLoading) return;
    setIsLoading(true);
    setError(null);
    setSuccessMsg(null);

    // Detect if running inside the Native Android APK wrapper
    const isNativeAndroid = typeof window !== 'undefined' && Boolean(window.AndroidBridge?.triggerGoogleSignIn);

    if (isNativeAndroid) {
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

    // Web Browser fallback
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });
      const userCredential = await signInWithPopup(auth, provider);
      const firebaseUser = userCredential.user;
      const token = await firebaseUser.getIdToken();

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
        resetForm();
      }, 700);
    } catch (err: any) {
      setError(getAuthErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSignOut = async () => {
    setIsLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      // 1. Independent session logout
      await authManager.logout();
      // 2. Clear Firebase Auth session if active
      await signOut(auth).catch(() => {});

      setSuccessMsg('Signed out successfully.');
      setTimeout(() => {
        onClose();
        resetForm();
      }, 500);
    } catch (err: any) {
      setError(getAuthErrorMessage(err));
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-md bg-[#0E121E] border border-white/[0.08] rounded-3xl overflow-hidden shadow-2xl p-6 max-h-[92vh] overflow-y-auto space-y-4">
        {/* Modal Header */}
        <div className="flex justify-between items-center pb-3 border-b border-white/[0.06]">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-zinc-900 border border-white/10 flex items-center justify-center text-emerald-400">
              <ShieldCheck className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-black text-base text-white">Player Authentication</h3>
              <p className="text-[11px] text-zinc-400">Firebase Zero-Trust Identity</p>
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
                    <div className="text-[10px] text-emerald-300/80 truncate">
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
          /* Unauthenticated Auth State (Email/Password Primary) */
          <div className="space-y-4">
            {/* Mode Switcher Tabs */}
            <div className="flex p-1 rounded-2xl bg-zinc-900/90 border border-white/[0.06]">
              <button
                type="button"
                onClick={() => handleModeChange('signin')}
                className={`flex-1 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
                  authMode === 'signin'
                    ? 'bg-emerald-500 text-zinc-950 shadow-md font-extrabold'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                Sign In
              </button>
              <button
                type="button"
                onClick={() => handleModeChange('register')}
                className={`flex-1 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
                  authMode === 'register'
                    ? 'bg-emerald-500 text-zinc-950 shadow-md font-extrabold'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                Register
              </button>
              {authMode === 'link_account' && (
                <button
                  type="button"
                  onClick={() => handleModeChange('link_account')}
                  className="flex-1 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer bg-emerald-500 text-zinc-950 shadow-md font-extrabold"
                >
                  Link
                </button>
              )}
              <button
                type="button"
                onClick={() => handleModeChange('forgot_password')}
                className={`flex-1 py-2 text-xs font-bold rounded-xl transition-all cursor-pointer ${
                  authMode === 'forgot_password'
                    ? 'bg-emerald-500 text-zinc-950 shadow-md font-extrabold'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                Reset
              </button>
            </div>

            {/* Email/Password Sign-In Form */}
            {authMode === 'signin' && (
              <form onSubmit={handleEmailSignIn} className="space-y-3.5">
                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Email Address</span>
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="player@gaminghub.ng"
                    required
                    autoComplete="email"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-white/10 text-white placeholder-zinc-500 text-xs focus:outline-none focus:border-emerald-400 transition-colors"
                  />
                </div>

                <div className="space-y-1">
                  <div className="flex justify-between items-center">
                    <label className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                      <Lock className="w-3.5 h-3.5 text-emerald-400" />
                      <span>Password</span>
                    </label>
                    <button
                      type="button"
                      onClick={() => handleModeChange('forgot_password')}
                      className="text-[10px] text-emerald-400 hover:text-emerald-300 font-semibold cursor-pointer"
                    >
                      Forgot?
                    </button>
                  </div>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Enter your password"
                    required
                    autoComplete="current-password"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-white/10 text-white placeholder-zinc-500 text-xs focus:outline-none focus:border-emerald-400 transition-colors"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full min-h-[46px] py-2.5 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs shadow-lg shadow-emerald-500/20 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer mt-2"
                >
                  {isLoading ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Authenticating...</span>
                    </>
                  ) : (
                    <>
                      <LogIn className="w-4 h-4" />
                      <span>Sign In to Gaming Hub</span>
                    </>
                  )}
                </button>
              </form>
            )}

            {/* Email/Password Register Form */}
            {authMode === 'register' && (
              <form onSubmit={handleRegister} className="space-y-3">
                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                    <UserCheck className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Player Gamer Tag (Optional)</span>
                  </label>
                  <input
                    type="text"
                    value={displayName}
                    onChange={(e) => setDisplayName(e.target.value)}
                    placeholder="e.g. ApexTitan"
                    maxLength={30}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-white/10 text-white placeholder-zinc-500 text-xs focus:outline-none focus:border-emerald-400 transition-colors"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Email Address</span>
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="player@gaminghub.ng"
                    required
                    autoComplete="email"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-white/10 text-white placeholder-zinc-500 text-xs focus:outline-none focus:border-emerald-400 transition-colors"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Password (min. 6 chars)</span>
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Choose a strong password"
                    required
                    minLength={6}
                    autoComplete="new-password"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-white/10 text-white placeholder-zinc-500 text-xs focus:outline-none focus:border-emerald-400 transition-colors"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Confirm Password</span>
                  </label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm your password"
                    required
                    minLength={6}
                    autoComplete="new-password"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-white/10 text-white placeholder-zinc-500 text-xs focus:outline-none focus:border-emerald-400 transition-colors"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full min-h-[46px] py-2.5 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs shadow-lg shadow-emerald-500/20 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer mt-2"
                >
                  {isLoading ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Creating Account...</span>
                    </>
                  ) : (
                    <>
                      <UserPlus className="w-4 h-4" />
                      <span>Create Player Account</span>
                    </>
                  )}
                </button>
              </form>
            )}

            {/* Forgot Password Reset Form */}
            {authMode === 'forgot_password' && (
              <form onSubmit={handlePasswordReset} className="space-y-3.5">
                <div className="p-3 rounded-2xl bg-zinc-900/80 border border-white/[0.06] text-xs text-zinc-300 leading-relaxed">
                  Enter your registered email address and we will send a secure password reset link directly to your inbox.
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Registered Email Address</span>
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="player@gaminghub.ng"
                    required
                    autoComplete="email"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-white/10 text-white placeholder-zinc-500 text-xs focus:outline-none focus:border-emerald-400 transition-colors"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full min-h-[46px] py-2.5 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs shadow-lg shadow-emerald-500/20 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
                >
                  {isLoading ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Sending Reset Email...</span>
                    </>
                  ) : (
                    <>
                      <KeyRound className="w-4 h-4" />
                      <span>Send Password Reset Link</span>
                    </>
                  )}
                </button>

                <div className="text-center pt-1">
                  <button
                    type="button"
                    onClick={() => handleModeChange('signin')}
                    className="text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer"
                  >
                    Back to Sign In
                  </button>
                </div>
              </form>
            )}

            {/* Account Linking Form (Stage 3.3 Existing Firebase Account Migration) */}
            {authMode === 'link_account' && (
              <form onSubmit={handleLinkExistingAccount} className="space-y-3">
                <div className="p-3.5 rounded-2xl bg-amber-950/40 border border-amber-800/60 text-xs text-amber-300 leading-relaxed space-y-1">
                  <div className="font-bold flex items-center gap-1.5 text-amber-200">
                    <Link2 className="w-4 h-4 text-amber-400" />
                    <span>Existing Account Upgrade</span>
                  </div>
                  <p className="text-[11px] text-amber-300/90 leading-normal">
                    An existing Gaming Hub player profile exists for this email. Verify your current password to link independent credentials. Your gamer ID, wallet balance, and match passes will remain completely intact.
                  </p>
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                    <Mail className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Account Email</span>
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="player@gaminghub.ng"
                    required
                    autoComplete="email"
                    className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-white/10 text-white placeholder-zinc-500 text-xs focus:outline-none focus:border-emerald-400 transition-colors"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-amber-400" />
                    <span>Existing Password (Ownership Verification)</span>
                  </label>
                  <input
                    type="password"
                    value={firebasePasswordForVerify}
                    onChange={(e) => setFirebasePasswordForVerify(e.target.value)}
                    placeholder="Enter existing password to verify ownership"
                    required
                    className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-amber-500/30 text-white placeholder-zinc-500 text-xs focus:outline-none focus:border-amber-400 transition-colors"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-emerald-400" />
                    <span>New Independent Password (min. 6 chars)</span>
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Choose your new Gaming Hub password"
                    required
                    minLength={6}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-white/10 text-white placeholder-zinc-500 text-xs focus:outline-none focus:border-emerald-400 transition-colors"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] font-bold text-zinc-300 flex items-center gap-1.5">
                    <Lock className="w-3.5 h-3.5 text-emerald-400" />
                    <span>Confirm New Password</span>
                  </label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="Confirm your new password"
                    required
                    minLength={6}
                    className="w-full px-3.5 py-2.5 rounded-xl bg-zinc-900 border border-white/10 text-white placeholder-zinc-500 text-xs focus:outline-none focus:border-emerald-400 transition-colors"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading}
                  className="w-full min-h-[46px] py-2.5 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs shadow-lg shadow-emerald-500/20 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer mt-2"
                >
                  {isLoading ? (
                    <>
                      <RefreshCw className="w-4 h-4 animate-spin" />
                      <span>Verifying & Linking Credentials...</span>
                    </>
                  ) : (
                    <>
                      <Link2 className="w-4 h-4" />
                      <span>Link & Upgrade Account</span>
                    </>
                  )}
                </button>

                <div className="text-center pt-1">
                  <button
                    type="button"
                    onClick={() => handleModeChange('signin')}
                    className="text-xs text-zinc-400 hover:text-white transition-colors cursor-pointer"
                  >
                    Cancel and Back to Sign In
                  </button>
                </div>
              </form>
            )}

            {/* Divider */}
            <div className="relative py-2">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-white/[0.08]" />
              </div>
              <div className="relative flex justify-center text-[10px] uppercase tracking-wider">
                <span className="bg-[#0E121E] px-2 text-zinc-500">Or continue with</span>
              </div>
            </div>

            {/* Secondary Optional Google Sign-In Action */}
            <button
              type="button"
              onClick={handleGoogleSignIn}
              disabled={isLoading}
              className="w-full min-h-[44px] py-2.5 px-4 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-white/10 text-zinc-200 font-bold text-xs transition-all active:scale-[0.98] disabled:opacity-60 flex items-center justify-center gap-2.5 cursor-pointer"
            >
              {isLoading ? (
                <>
                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-zinc-300" />
                  <span>Connecting to Google...</span>
                </>
              ) : (
                <>
                  {/* Google "G" Colored SVG Icon */}
                  <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24">
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
                  <span>Sign in with Google (Alternative)</span>
                </>
              )}
            </button>

            <p className="text-[10px] text-zinc-500 text-center leading-normal">
              Direct Firebase Authentication · Zero-Trust Protected
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

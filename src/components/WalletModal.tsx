import React, { useState, useEffect } from 'react';
import {
  X,
  CreditCard,
  ShieldCheck,
  ArrowDownLeft,
  ArrowUpRight,
  CheckCircle2,
  AlertCircle,
  RefreshCw,
  Lock,
  ExternalLink,
  LogIn,
  AlertTriangle,
  Clock,
  Sparkles,
} from 'lucide-react';
import { Transaction, Wallet } from '../types.js';
import { authFetch } from '../lib/firebase.js';

interface WalletModalProps {
  isOpen: boolean;
  onClose: () => void;
  wallet: Wallet | null;
  transactions: Transaction[];
  userId: string;
  onPaymentSuccess: () => void;
  onOpenAuth?: () => void;
}

export const WalletModal: React.FC<WalletModalProps> = ({
  isOpen,
  onClose,
  wallet,
  transactions,
  userId,
  onPaymentSuccess,
  onOpenAuth,
}) => {
  const [amount, setAmount] = useState<number>(500);
  const [customAmount, setCustomAmount] = useState<string>('');
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [duplicateNotice, setDuplicateNotice] = useState<string | null>(null);
  const [cancellationNotice, setCancellationNotice] = useState<string | null>(null);
  const [successData, setSuccessData] = useState<{
    amount: number;
    reference: string;
    newBalance: number;
  } | null>(null);
  const [activeReference, setActiveReference] = useState<string | null>(null);
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [paymentStep, setPaymentStep] = useState<
    'select' | 'initializing' | 'checkout_ready' | 'verifying' | 'cancelled' | 'success'
  >('select');
  const [isPaystackConfigured, setIsPaystackConfigured] = useState<boolean | null>(null);

  // Check Paystack public configuration status on modal open
  useEffect(() => {
    if (isOpen) {
      setError(null);
      setSuccessData(null);
      setDuplicateNotice(null);
      setCancellationNotice(null);
      setPaymentStep('select');
      setActiveReference(null);
      setAuthUrl(null);

      // Check if Paystack test credentials are configured on server
      fetch('/api/paystack/config')
        .then((res) => res.json())
        .then((data) => {
          setIsPaystackConfigured(Boolean(data.configured));
        })
        .catch(() => {
          setIsPaystackConfigured(false);
        });

      // Preload Paystack Inline script if not already present
      if (typeof window !== 'undefined' && !(window as any).PaystackPop) {
        const existingScript = document.getElementById('paystack-inline-js');
        if (!existingScript) {
          const script = document.createElement('script');
          script.id = 'paystack-inline-js';
          script.src = 'https://js.paystack.co/v1/inline.js';
          script.async = true;
          document.head.appendChild(script);
        }
      }
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const presetAmounts = [100, 500, 1000, 2000, 5000];

  const handleSelectPreset = (val: number) => {
    setAmount(val);
    setCustomAmount('');
    setError(null);
    setDuplicateNotice(null);
    setCancellationNotice(null);
  };

  const handleCustomChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setCustomAmount(val);
    const parsed = parseInt(val, 10);
    if (!isNaN(parsed) && parsed > 0) {
      setAmount(parsed);
    }
    setError(null);
    setDuplicateNotice(null);
    setCancellationNotice(null);
  };

  // 1. Independent Server Payment Verification
  const verifyPaymentWithServer = async (reference: string) => {
    setIsLoading(true);
    setPaymentStep('verifying');
    setError(null);
    setDuplicateNotice(null);
    setCancellationNotice(null);

    try {
      const verifyRes = await authFetch('/api/paystack/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reference }),
      });

      const verifyData = await verifyRes.json();

      if (verifyRes.status === 409 || verifyData.code === 'DUPLICATE_PAYMENT') {
        setDuplicateNotice(
          `Payment reference #${reference.slice(-8).toUpperCase()} was already verified and credited to your wallet. Duplicate balance crediting was prevented.`
        );
        setPaymentStep('select');
        return;
      }

      if (!verifyRes.ok || !verifyData.success) {
        throw new Error(
          verifyData.error || 'Payment was not verified by Paystack gateway. Wallet balance was not credited.'
        );
      }

      // Server confirmed payment and credited wallet!
      setSuccessData({
        amount: verifyData.amount || amount,
        reference,
        newBalance: verifyData.newBalance ?? (wallet?.balance ?? 0) + (verifyData.amount || amount),
      });
      setPaymentStep('success');

      // Authoritative balance & transaction ledger refresh after confirmation
      onPaymentSuccess();
    } catch (err: any) {
      setError(err.message || 'Payment verification failed at server.');
      setPaymentStep('select');
    } finally {
      setIsLoading(false);
    }
  };

  // 2. Paystack Initialization & Genuine Checkout Sequence
  const handleInitiatePaystack = async () => {
    if (!userId) {
      setError('Please sign in to fund your wallet.');
      return;
    }

    if (amount < 100) {
      setError('Minimum funding amount is ₦100.');
      return;
    }

    setError(null);
    setDuplicateNotice(null);
    setCancellationNotice(null);
    setSuccessData(null);
    setIsLoading(true);
    setPaymentStep('initializing');

    try {
      // Step A: Request server initialization
      const initRes = await authFetch('/api/paystack/initialize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount,
        }),
      });

      if (initRes.status === 401) {
        throw new Error('Authentication required. Please sign in to fund your wallet.');
      }

      const initData = await initRes.json();

      // Check if test configuration is missing
      if (initData.code === 'PAYSTACK_TEST_CONFIG_REQUIRED' || !initData.success) {
        setError(
          initData.error ||
            'Paystack test credentials are not configured on the server. Please configure PAYSTACK_SECRET_KEY and PAYSTACK_PUBLIC_KEY in the environment.'
        );
        setIsPaystackConfigured(false);
        setIsLoading(false);
        setPaymentStep('select');
        return;
      }

      setActiveReference(initData.reference);
      setAuthUrl(initData.authorizationUrl || null);

      // Step B: Launch genuine Paystack checkout
      const paystackPop = (window as any).PaystackPop;

      if (paystackPop && (initData.publicKey || initData.accessCode)) {
        try {
          const handler = paystackPop.setup({
            key: initData.publicKey,
            access_code: initData.accessCode,
            onClose: () => {
              setIsLoading(false);
              setPaymentStep('cancelled');
              setCancellationNotice(
                'Checkout was cancelled before completion. No funds were debited, and your wallet balance remains unchanged.'
              );
            },
            callback: async (response: { reference?: string }) => {
              const verifiedRef = response?.reference || initData.reference;
              // Step C: Call server verification only after checkout reports success
              await verifyPaymentWithServer(verifiedRef);
            },
          });
          handler.openIframe();
          return;
        } catch (popupErr: any) {
          console.warn('[PaystackPop] Inline setup notice:', popupErr);
        }
      }

      // Step B Fallback: Show Checkout Ready card with direct gateway link
      setPaymentStep('checkout_ready');
      setIsLoading(false);
    } catch (err: any) {
      setError(err.message || 'Payment initialization failed.');
      setPaymentStep('select');
      setIsLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-in fade-in duration-200">
      <div className="relative w-full max-w-md bg-[#0E121E] border border-white/[0.08] rounded-3xl overflow-hidden shadow-2xl flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06] bg-[#07090E]/60">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-zinc-900 border border-white/10 flex items-center justify-center text-emerald-400">
              <CreditCard className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-black text-base text-white">Deposit Funds</h3>
              <p className="text-[11px] text-zinc-400">Paystack Test Mode Checkout</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-white flex items-center justify-center transition-colors cursor-pointer"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="p-6 overflow-y-auto space-y-5">
          {/* Balance Display Card */}
          <div className="p-4 rounded-2xl bg-zinc-900/90 border border-white/[0.06] shadow-sm">
            <div className="text-[10px] text-zinc-400 uppercase font-black tracking-wider">
              Current Available Balance
            </div>
            <div className="text-3xl font-black text-white tabular-nums mt-1">
              ₦{(wallet?.balance ?? 0).toLocaleString()}
            </div>
            <div className="flex items-center gap-1.5 mt-2 text-[11px] text-emerald-400 font-medium">
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>Server-Authoritative Ledger Guarded</span>
            </div>
          </div>

          {/* Unauthenticated Guest State */}
          {!userId && (
            <div className="p-4 rounded-2xl bg-zinc-900 border border-white/10 space-y-2.5">
              <div className="flex items-center gap-2 text-xs font-black text-white">
                <LogIn className="w-4 h-4 text-emerald-400" />
                <span>Player Sign-In Required</span>
              </div>
              <p className="text-[11px] text-zinc-400 leading-relaxed">
                You are currently playing as a guest. Sign in with Google to protect your wallet balance and match passes across devices.
              </p>
              {onOpenAuth && (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenAuth();
                  }}
                  className="w-full py-2.5 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs transition-colors flex items-center justify-center gap-1.5 cursor-pointer"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  <span>Sign in with Google</span>
                </button>
              )}
            </div>
          )}

          {/* Paystack Test Configuration Notice */}
          {isPaystackConfigured === false && (
            <div className="p-3.5 rounded-2xl bg-amber-950/40 border border-amber-800/60 text-amber-200 text-xs space-y-1.5">
              <div className="flex items-center gap-2 font-bold text-amber-300">
                <AlertTriangle className="w-4 h-4 shrink-0" />
                <span>Paystack Test Credentials Required</span>
              </div>
              <p className="text-[11px] text-zinc-300 leading-relaxed">
                Wallet deposits require Paystack test keys. Configure{' '}
                <code className="text-amber-300 font-mono">PAYSTACK_SECRET_KEY</code> (sk_test_...) and{' '}
                <code className="text-amber-300 font-mono">PAYSTACK_PUBLIC_KEY</code> (pk_test_...) in the server environment. Simulated or fake payments are strictly disabled.
              </p>
            </div>
          )}

          {/* 1. Cancellation Alert (Reassuring message) */}
          {cancellationNotice && (
            <div className="p-3.5 rounded-2xl bg-zinc-900 border border-zinc-700/60 text-zinc-300 text-xs flex items-start gap-2.5 animate-in fade-in">
              <Clock className="w-4 h-4 text-zinc-400 shrink-0 mt-0.5" />
              <div className="flex-1 text-[11px] leading-relaxed">{cancellationNotice}</div>
            </div>
          )}

          {/* 2. Duplicate Payment Notice */}
          {duplicateNotice && (
            <div className="p-3.5 rounded-2xl bg-amber-950/60 border border-amber-800/70 text-amber-200 text-xs flex items-start gap-2.5 animate-in fade-in">
              <ShieldCheck className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="flex-1 text-[11px] leading-relaxed">{duplicateNotice}</div>
            </div>
          )}

          {/* 3. Error Alert */}
          {error && (
            <div className="p-3.5 rounded-2xl bg-rose-950/80 border border-rose-800/80 text-rose-300 text-xs flex items-start gap-2.5 animate-in fade-in">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <div className="flex-1 text-[11px] leading-relaxed">{error}</div>
            </div>
          )}

          {/* 4. Success Card (Celebration & authoritative confirmation) */}
          {paymentStep === 'success' && successData && (
            <div className="p-5 rounded-2xl bg-emerald-950/70 border border-emerald-600/60 text-emerald-100 space-y-3 animate-in zoom-in-95 duration-200">
              <div className="flex items-center gap-2 text-emerald-400 font-black text-sm">
                <CheckCircle2 className="w-5 h-5 shrink-0" />
                <span>₦{successData.amount.toLocaleString()} Successfully Funded!</span>
              </div>
              <p className="text-xs text-zinc-300 leading-relaxed">
                Your payment has been independently verified by Paystack and atomically credited to your Firestore wallet.
              </p>
              <div className="p-3 rounded-xl bg-black/40 border border-white/5 space-y-1 font-mono text-[11px]">
                <div className="flex justify-between text-zinc-400">
                  <span>Reference:</span>
                  <span className="text-emerald-400 font-bold">{successData.reference}</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>New Balance:</span>
                  <span className="text-white font-bold">₦{successData.newBalance.toLocaleString()}</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setPaymentStep('select');
                  setSuccessData(null);
                }}
                className="w-full py-2.5 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs transition-colors cursor-pointer"
              >
                Done / Make Another Deposit
              </button>
            </div>
          )}

          {/* 5. Pending / Verifying State */}
          {paymentStep === 'verifying' && (
            <div className="p-6 rounded-2xl bg-zinc-900 border border-emerald-500/30 text-center space-y-3 animate-in fade-in">
              <div className="relative w-12 h-12 mx-auto">
                <RefreshCw className="w-12 h-12 animate-spin text-emerald-400" />
                <Sparkles className="w-4 h-4 text-emerald-300 absolute inset-0 m-auto animate-pulse" />
              </div>
              <div className="text-sm font-black text-white">Verifying Payment with Server</div>
              <p className="text-xs text-zinc-400 leading-relaxed max-w-xs mx-auto">
                Awaiting final confirmation from Paystack gateway. Your wallet balance will update as soon as the server verifies the transaction.
              </p>
            </div>
          )}

          {/* 6. Checkout Ready Fallback Card */}
          {paymentStep === 'checkout_ready' && activeReference && (
            <div className="p-4 rounded-2xl bg-zinc-900 border border-emerald-500/30 space-y-3 animate-in fade-in">
              <div className="flex items-center justify-between">
                <span className="text-xs font-black text-white flex items-center gap-1.5">
                  <CreditCard className="w-4 h-4 text-emerald-400" />
                  <span>Paystack Checkout Ready</span>
                </span>
                <span className="text-[10px] font-mono text-emerald-400 font-bold bg-emerald-950 px-2 py-0.5 rounded-full border border-emerald-800">
                  ₦{amount.toLocaleString()}
                </span>
              </div>
              <p className="text-[11px] text-zinc-300 leading-relaxed">
                Transaction initialized. Reference: <code className="text-emerald-400 font-mono">{activeReference}</code>. Complete payment on Paystack, then tap verify.
              </p>

              {authUrl && (
                <a
                  href={authUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="w-full py-2.5 px-3 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-zinc-950 font-black text-xs flex items-center justify-center gap-2 transition-all active:scale-[0.98]"
                >
                  <span>Open Paystack Checkout</span>
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              )}

              <button
                type="button"
                onClick={() => verifyPaymentWithServer(activeReference)}
                disabled={isLoading}
                className="w-full py-2.5 px-3 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-white font-black text-xs flex items-center justify-center gap-2 transition-colors cursor-pointer"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="w-3.5 h-3.5 animate-spin text-emerald-400" />
                    <span>Verifying with Paystack...</span>
                  </>
                ) : (
                  <span>I Have Completed Payment — Verify</span>
                )}
              </button>

              <button
                type="button"
                onClick={() => {
                  setPaymentStep('select');
                  setActiveReference(null);
                  setCancellationNotice('Checkout was cancelled by player. Your wallet was not charged.');
                }}
                className="w-full text-center text-xs text-zinc-500 hover:text-zinc-300 transition-colors py-1 cursor-pointer"
              >
                Cancel Checkout
              </button>
            </div>
          )}

          {/* Amount Selection & Checkout Initiation */}
          {(paymentStep === 'select' || paymentStep === 'cancelled') && (
            <>
              <div className="space-y-2.5">
                <label className="text-xs font-black text-zinc-300 uppercase tracking-wider block">
                  Select Top-Up Amount (₦)
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {presetAmounts.map((val) => (
                    <button
                      key={val}
                      type="button"
                      onClick={() => handleSelectPreset(val)}
                      className={`py-2.5 px-3 rounded-xl border text-xs font-bold transition-all cursor-pointer ${
                        amount === val && !customAmount
                          ? 'bg-emerald-500 text-zinc-950 border-emerald-400 shadow-md shadow-emerald-500/20 font-black'
                          : 'bg-zinc-900/80 border-white/[0.06] text-zinc-300 hover:border-white/20'
                      }`}
                    >
                      ₦{val.toLocaleString()}
                    </button>
                  ))}
                </div>

                {/* Custom Amount */}
                <div className="relative">
                  <span className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-500 font-bold text-sm">
                    ₦
                  </span>
                  <input
                    type="number"
                    placeholder="Custom amount (min ₦100)"
                    value={customAmount}
                    onChange={handleCustomChange}
                    min="100"
                    step="50"
                    className="w-full bg-zinc-900 border border-white/[0.08] rounded-xl py-2.5 pl-8 pr-3 text-white text-xs placeholder:text-zinc-500 focus:outline-none focus:border-emerald-500 transition-colors"
                  />
                </div>
              </div>

              {/* Paystack Channel Info */}
              <div className="p-3 rounded-xl bg-zinc-900/60 border border-white/[0.06] flex items-center justify-between text-xs text-zinc-400">
                <div className="flex items-center gap-2">
                  <Lock className="w-4 h-4 text-emerald-400" />
                  <span>Paystack Test Mode (Cards, Bank Transfer, USSD)</span>
                </div>
                <span className="text-[10px] text-emerald-400 font-bold">256-bit SSL</span>
              </div>

              {/* Primary Action Button */}
              <button
                type="button"
                onClick={handleInitiatePaystack}
                disabled={isLoading || amount < 100 || !userId}
                className="w-full min-h-[44px] bg-emerald-500 hover:bg-emerald-400 active:bg-emerald-600 text-zinc-950 font-black text-sm py-3 px-4 rounded-xl shadow-lg shadow-emerald-500/20 transition-all active:scale-[0.98] disabled:opacity-50 flex items-center justify-center gap-2 cursor-pointer"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="w-4 h-4 animate-spin text-zinc-950" />
                    <span>Connecting to Paystack...</span>
                  </>
                ) : (
                  <>
                    <CreditCard className="w-4 h-4" />
                    <span>Pay ₦{amount.toLocaleString()} with Paystack</span>
                  </>
                )}
              </button>
            </>
          )}

          {/* Recent Transactions Ledger */}
          <div className="pt-2">
            <h4 className="text-xs font-black text-zinc-400 uppercase tracking-wider mb-2">
              Recent Transactions Ledger
            </h4>
            {transactions.length === 0 ? (
              <p className="text-xs text-zinc-500 italic py-2 text-center">
                No transactions recorded yet.
              </p>
            ) : (
              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {transactions.slice(0, 10).map((tx) => (
                  <div
                    key={tx.id}
                    className="p-2.5 rounded-xl bg-zinc-900/60 border border-white/[0.04] flex items-center justify-between text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div
                        className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${
                          tx.type === 'credit'
                            ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800/40'
                            : 'bg-rose-950/80 text-rose-400 border border-rose-800/40'
                        }`}
                      >
                        {tx.type === 'credit' ? (
                          <ArrowDownLeft className="w-4 h-4" />
                        ) : (
                          <ArrowUpRight className="w-4 h-4" />
                        )}
                      </div>
                      <div className="min-w-0">
                        <div className="font-bold text-white text-xs truncate">
                          {tx.description}
                        </div>
                        <div className="text-[10px] text-zinc-500 font-mono truncate">
                          Ref #{tx.reference.slice(-6).toUpperCase()}
                        </div>
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div
                        className={`font-black text-xs tabular-nums ${
                          tx.type === 'credit' ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {tx.type === 'credit' ? '+' : '-'}₦{tx.amount.toLocaleString()}
                      </div>
                      <div className="text-[10px] text-zinc-500">
                        {new Date(tx.createdAt).toLocaleTimeString([], {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

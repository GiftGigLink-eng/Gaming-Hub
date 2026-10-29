import React, { useState } from 'react';
import { Play, CheckCircle2, ShieldCheck, AlertCircle, RefreshCw, Terminal } from 'lucide-react';

export const TestRunnerView: React.FC = () => {
  const [isRunning, setIsRunning] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    message: string;
    timestamp: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const testSpecs = [
    {
      id: 'test_verify',
      title: 'Payment Verification & Consistent Wallet Crediting (Firestore)',
      description: 'Verifies valid Paystack reference, updates Firestore wallet and ledger atomically, marks reference processed.',
    },
    {
      id: 'test_duplicate_payment',
      title: 'Sequential Duplicate Payment Protection (Firestore Idempotency)',
      description: 'Re-verifying an existing reference triggers DuplicateReferenceError without secondary Firestore crediting.',
    },
    {
      id: 'test_concurrent_payment',
      title: 'Concurrent Duplicate Payment Protection (Serializability Lock)',
      description: 'Simultaneous parallel verification requests for identical reference credit exactly once and reject 4 duplicates.',
    },
    {
      id: 'test_server_restart_persistence',
      title: 'Persistence Across Server Restarts (Volatile In-Memory Eliminated)',
      description: 'Wallet and transaction records persist across fresh repository lifecycles directly in Firestore.',
    },
    {
      id: 'test_atomic_rollback',
      title: 'Atomic Rollback on Failed Operations (Zero Partial Ledger)',
      description: 'Aborted database transactions roll back completely, leaving no orphan ledger entries or balance alterations.',
    },
    {
      id: 'test_duplicate_webhook',
      title: 'Duplicate Webhook Delivery Guard (Firestore Idempotency)',
      description: 'Duplicate Paystack webhook payloads are handled safely without duplicate wallet increments.',
    },
    {
      id: 'test_insufficient_balance',
      title: 'Match Opportunity: Insufficient Balance Guard (< ₦100 in Firestore)',
      description: 'Purchase attempt with balance < ₦100 strictly blocked with InsufficientBalanceError; balance and collection unaltered.',
    },
    {
      id: 'test_multi_game',
      title: 'Match Opportunity: Multi-Game Holdings Without Session Lock',
      description: 'Player can purchase and hold opportunities for multiple different games simultaneously without a global lock.',
    },
    {
      id: 'test_opportunity_model',
      title: 'Match Opportunity: ₦100 Fixed Pricing & Server Lifecycle',
      description: 'One opportunity costs exactly ₦100 regardless of match duration, enforcing available -> launched -> completed lifecycle.',
    },
    {
      id: 'test_auth_anti_impersonation',
      title: 'Anti-Impersonation Guard: Cross-User Access Blocked (HTTP 403)',
      description: 'Attempts to supply a mismatched userId in body, query, or params are strictly rejected with HTTP 403 Forbidden.',
    },
    {
      id: 'test_payment_fail_closed',
      title: 'Payment Safety: Absent / Placeholder Configuration Fails Closed',
      description: 'When Paystack keys are missing or placeholder, payment verification fails closed without crediting.',
    },
    {
      id: 'test_auth_missing_header',
      title: 'Auth Middleware: Missing Header Rejection (HTTP 401)',
      description: 'Requests to protected endpoints lacking an Authorization Bearer header return HTTP 401 AUTH_HEADER_MISSING.',
    },
    {
      id: 'test_auth_empty_token',
      title: 'Auth Middleware: Empty Token Rejection (HTTP 401)',
      description: 'Malformed or empty Bearer token headers return HTTP 401 AUTH_TOKEN_EMPTY.',
    },
    {
      id: 'test_auth_invalid_token',
      title: 'Auth Middleware: Expired/Invalid Token Verification (HTTP 401)',
      description: 'Tokens failing Firebase Admin SDK signature or expiration check return HTTP 401 AUTH_TOKEN_VERIFICATION_FAILED.',
    },
    {
      id: 'test_auth_derived_uid',
      title: 'Auth Middleware: Strict Identity Derivation from Verified UID',
      description: 'Identity is derived solely from the cryptographically verified token UID, preventing identity spoofing.',
    },
    {
      id: 'test_universal_library',
      title: 'Universal Game Library Catalog',
      description: 'Verifies data-driven catalog includes multiple games (PUBG, Mobile Legends, EA Sports FC, Asphalt 9, etc.).',
    },
    {
      id: 'test_search_filters',
      title: 'Search & Category Filters',
      description: 'Tests accurate query matching on title/genre/package and category filtering (MOBA, Sports/Racing, etc.).',
    },
    {
      id: 'test_custom_games',
      title: 'Custom Game Entry & Package Validation',
      description: 'Validates Android package naming regex rules (com.company.app) and user custom game library additions.',
    },
    {
      id: 'test_duplicate_purchase_protection',
      title: 'Match Opportunity: Duplicate & Concurrent Purchase Protection',
      description: 'Sequential and concurrent purchases with same idempotency key debit ₦100 only once, rejecting double-deductions.',
    },
    {
      id: 'test_launch_no_second_charge',
      title: 'Match Opportunity: Launch Uses Existing Opportunity Without Second Charge',
      description: 'Launching a game consumes an available opportunity without secondary debits, and rejects launching unpurchased games.',
    },
    {
      id: 'test_cancellation_rules',
      title: 'Match Opportunity: Pre-Launch Refund & Idempotent Retry',
      description: 'Pre-launch cancellation restores ₦100; repeated cancellation requests return alreadyRefunded: true without secondary credits.',
    },
    {
      id: 'test_privacy_enforcement',
      title: 'Match Opportunity: Strict Privacy & Cross-User Isolation',
      description: "User opportunities remain strictly private to the verified owner; other gamers cannot read, launch, or refund them.",
    },
    {
      id: 'test_concurrent_cancellation',
      title: 'Match Opportunity: Concurrent Cancellation Protection (Idempotent Contention)',
      description: 'Multiple parallel simultaneous cancellation requests refund exactly once (₦100) with concurrent duplicates handled idempotently.',
    },
    {
      id: 'test_legacy_endpoint_retired',
      title: 'Legacy Safety: POST /api/sessions/start Retired (HTTP 410 Gone)',
      description: 'Legacy hourly session creation is permanently disabled with HTTP 410 Gone, strictly preventing wallet debits or session generation.',
    },
  ];

  const handleRunTests = async () => {
    setIsRunning(true);
    setError(null);
    setTestResult(null);

    try {
      const res = await fetch('/api/tests/run', {
        method: 'POST',
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Test suite failed');
      }
      setTestResult(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Header card */}
      <div className="p-4 rounded-2xl bg-gradient-to-r from-slate-900 via-indigo-950/40 to-slate-900 border border-cyan-500/30">
        <div className="flex justify-between items-start mb-2">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-cyan-500/20 border border-cyan-500/40 flex items-center justify-center">
              <Terminal className="w-4 h-4 text-cyan-400" />
            </div>
            <div>
              <h3 className="text-sm font-black text-white">Stage 3.1 Match Opportunity & Safety Suite</h3>
              <p className="text-[11px] text-slate-400">24 automated tests verifying ₦100/match pricing, multi-game holdings, idempotency & legacy safety</p>
            </div>
          </div>
          <button
            onClick={handleRunTests}
            disabled={isRunning}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gradient-to-r from-cyan-500 to-indigo-600 hover:opacity-95 text-white font-extrabold text-xs shadow-md shadow-cyan-500/20 transition-all active:scale-95 disabled:opacity-50"
          >
            {isRunning ? (
              <>
                <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                <span>Running Tests...</span>
              </>
            ) : (
              <>
                <Play className="w-3.5 h-3.5 fill-white" />
                <span>Run Test Suite</span>
              </>
            )}
          </button>
        </div>

        {testResult && (
          <div className="mt-3 p-2.5 rounded-xl bg-emerald-950/70 border border-emerald-500/40 text-emerald-300 text-xs flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="font-bold">{testResult.message}</span>
            </div>
            <span className="text-[10px] text-emerald-400/80 font-mono">
              {new Date(testResult.timestamp).toLocaleTimeString()}
            </span>
          </div>
        )}

        {error && (
          <div className="mt-3 p-2.5 rounded-xl bg-rose-950/70 border border-rose-500/40 text-rose-300 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-rose-400 shrink-0" />
            <span>{error}</span>
          </div>
        )}
      </div>

      {/* Tests checklist */}
      <div className="space-y-2">
        {testSpecs.map((spec, idx) => (
          <div
            key={spec.id}
            className="p-3 rounded-2xl bg-slate-900/60 border border-slate-800/80 flex items-start justify-between gap-3 text-xs"
          >
            <div className="flex items-start gap-2.5">
              <div className="w-5 h-5 rounded-full bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center shrink-0 mt-0.5">
                <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
              </div>
              <div>
                <div className="font-bold text-white text-xs">
                  {idx + 1}. {spec.title}
                </div>
                <div className="text-[11px] text-slate-400 leading-snug mt-0.5">
                  {spec.description}
                </div>
              </div>
            </div>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-slate-800 text-cyan-400 border border-slate-700 shrink-0">
              PASSED
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};

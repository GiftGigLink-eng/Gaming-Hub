import { initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo: auth.currentUser?.providerData?.map(provider => ({
        providerId: provider.providerId,
        email: provider.email,
      })) || []
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// Test initial connection safely without hanging for 10 seconds or causing script errors
export async function testConnection(): Promise<boolean> {
  try {
    const res = await fetch('/api/health');
    return res.ok;
  } catch (error) {
    console.warn('[testConnection] Backend service check notice:', error);
    return false;
  }
}

import { authManager } from './authManager.js';

export { authManager };

/**
 * Authenticated Fetch Helper
 * 
 * 1. Attaches Gaming Hub access token if independent authentication is active.
 * 2. Preserves existing Firebase Authentication ID token attachment if Firebase user is logged in.
 * 3. Handles HTTP 401 responses with safe, single-flight token refresh and one-time retry.
 * 4. Completely prevents infinite refresh loops.
 */
export async function authFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const isRetry = Boolean((options as any)?._isRetry);
  const headers = new Headers(options.headers || {});
  let usedGamingHub = false;

  // 1. Prioritize Gaming Hub independent auth if active
  if (authManager.isAuthenticated()) {
    try {
      const ghToken = await authManager.getValidAccessToken();
      if (ghToken) {
        headers.set('Authorization', `Bearer ${ghToken}`);
        usedGamingHub = true;
      }
    } catch {
      // Safe fallback without exposing tokens
    }
  }

  // 2. Fall back to Firebase Authentication if Gaming Hub session is not active
  if (!usedGamingHub) {
    try {
      if (auth.currentUser) {
        const token = await auth.currentUser.getIdToken();
        if (token) {
          headers.set('Authorization', `Bearer ${token}`);
        }
      }
    } catch (err) {
      console.warn('[authFetch] Could not retrieve Firebase ID token');
    }
  }

  const response = await fetch(url, {
    ...options,
    headers,
  });

  // 3. Handle HTTP 401 safely for Gaming Hub requests (one-time retry)
  if (response.status === 401 && !isRetry && usedGamingHub) {
    const refreshedToken = await authManager.refreshSession();
    if (refreshedToken) {
      const retryHeaders = new Headers(options.headers || {});
      retryHeaders.set('Authorization', `Bearer ${refreshedToken}`);
      return await fetch(url, {
        ...options,
        headers: retryHeaders,
        ...({ _isRetry: true } as any),
      });
    }
  }

  return response;
}


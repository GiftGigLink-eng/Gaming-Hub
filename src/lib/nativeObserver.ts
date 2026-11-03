/**
 * Gaming Hub — Native AI Match Observer Bridge
 * 
 * Manages communication between the React web app and the native Android
 * AIMatchObserverService. Handles low-resource, user-authorised, local on-device
 * screen observation (~1 FPS) without uploading gameplay footage.
 */

export interface NativeObserverOptions {
  opportunityId: string;
  gameId: string;
  gameTitle: string;
  packageId?: string;
  targetFps?: number; // 1 to 5, default 1
}

export interface NativeObserverDiagnostics {
  isObserving: boolean;
  opportunityId: string;
  gameTitle: string;
  packageId: string;
  framesReceived: number;
  framesProcessed: number;
  lastProcessingTimeMs: number;
  width: number;
  height: number;
  sessionDurationSeconds: number;
  effectiveFps: string;
}

export interface NativeObserverResult {
  success: boolean;
  message?: string;
  error?: string;
  alreadyObserving?: boolean;
  diagnostics?: NativeObserverDiagnostics;
}

declare global {
  interface Window {
    GamingHubAndroidBridge?: {
      isSupported: () => boolean;
      startBroadcast: (optionsJson: string) => string;
      stopBroadcast: () => string;
      getBroadcastStatus: () => string;
      startObservation?: (optionsJson: string) => string;
      stopObservation?: () => string;
      getObservationStatus?: () => string;
    };
  }
}

class NativeObserverClient {
  private currentDiagnostics: NativeObserverDiagnostics = {
    isObserving: false,
    opportunityId: '',
    gameTitle: '',
    packageId: '',
    framesReceived: 0,
    framesProcessed: 0,
    lastProcessingTimeMs: 0,
    width: 640,
    height: 360,
    sessionDurationSeconds: 0,
    effectiveFps: '0.0',
  };

  private listeners: Set<(diag: NativeObserverDiagnostics) => void> = new Set();
  private hasRegisteredListeners = false;

  constructor() {
    this.setupWindowListeners();
  }

  private setupWindowListeners() {
    if (typeof window === 'undefined' || this.hasRegisteredListeners) return;
    this.hasRegisteredListeners = true;

    window.addEventListener('gaminghub:native_observer_started', (e: any) => {
      const detail = e?.detail || {};
      this.updateState({
        isObserving: true,
        opportunityId: detail.opportunityId || this.currentDiagnostics.opportunityId,
        gameTitle: detail.gameTitle || this.currentDiagnostics.gameTitle,
      });
    });

    window.addEventListener('gaminghub:native_observer_stopped', (e: any) => {
      const detail = e?.detail || {};
      this.updateState({
        isObserving: false,
        framesReceived: detail.framesReceived ?? this.currentDiagnostics.framesReceived,
        framesProcessed: detail.framesProcessed ?? this.currentDiagnostics.framesProcessed,
        effectiveFps: detail.effectiveFps ?? '0.0',
      });
    });

    window.addEventListener('gaminghub:native_observer_frame_processed', (e: any) => {
      const detail = e?.detail || {};
      this.updateState({
        ...detail,
        isObserving: true,
      });
    });

    window.addEventListener('gaminghub:native_observer_revoked', (_e: any) => {
      this.updateState({ isObserving: false });
    });
  }

  public isNativeAndroid(): boolean {
    if (typeof window === 'undefined') return false;
    return Boolean(
      window.GamingHubAndroidBridge &&
      typeof window.GamingHubAndroidBridge.isSupported === 'function' &&
      window.GamingHubAndroidBridge.isSupported() &&
      typeof window.GamingHubAndroidBridge.startObservation === 'function'
    );
  }

  public async getObservationStatus(): Promise<NativeObserverDiagnostics> {
    if (this.isNativeAndroid() && window.GamingHubAndroidBridge?.getObservationStatus) {
      try {
        const raw = window.GamingHubAndroidBridge.getObservationStatus();
        const parsed = JSON.parse(raw);
        if (parsed.success && parsed.status) {
          this.updateState(parsed.status);
        }
      } catch (err) {
        console.warn('[NativeObserver] Error reading observation status:', err);
      }
    }
    return { ...this.currentDiagnostics };
  }

  public async startObservation(options: NativeObserverOptions): Promise<NativeObserverResult> {
    if (!options.opportunityId || !options.gameTitle) {
      return {
        success: false,
        error: 'Missing required observation parameters (opportunityId, gameTitle).',
      };
    }

    if (!this.isNativeAndroid() || !window.GamingHubAndroidBridge?.startObservation) {
      return {
        success: false,
        error: 'NATIVE_WRAPPER_REQUIRED: AI Match Observation requires the Gaming Hub Android companion app. Web browsers are restricted from observing background screens.',
      };
    }

    try {
      const payload = JSON.stringify({
        opportunityId: options.opportunityId,
        gameId: options.gameId,
        gameTitle: options.gameTitle,
        packageId: options.packageId || '',
        targetFps: options.targetFps || 1,
      });

      const raw = window.GamingHubAndroidBridge.startObservation(payload);
      const res = JSON.parse(raw);

      if (!res.success) {
        return { success: false, error: res.error || 'Failed to initiate observation permission' };
      }

      if (res.alreadyObserving) {
        return {
          success: true,
          alreadyObserving: true,
          message: 'Observation already active',
          diagnostics: this.currentDiagnostics,
        };
      }

      // Await user consent dialog result from MainActivity
      return new Promise<NativeObserverResult>((resolve) => {
        let handled = false;

        const onStarted = (e: any) => {
          if (handled) return;
          handled = true;
          cleanup();
          const detail = e?.detail || {};
          this.updateState({
            isObserving: true,
            opportunityId: detail.opportunityId || options.opportunityId,
            gameTitle: detail.gameTitle || options.gameTitle,
          });
          resolve({
            success: true,
            message: 'Observation started with user consent',
            diagnostics: this.currentDiagnostics,
          });
        };

        const onDenied = (e: any) => {
          if (handled) return;
          handled = true;
          cleanup();
          const errMsg = e?.detail?.error || 'MediaProjection observation permission was denied by user';
          resolve({ success: false, error: errMsg });
        };

        const cleanup = () => {
          if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('gaminghub:native_observer_started', onStarted);
            window.removeEventListener('gaminghub:native_observer_denied', onDenied);
          }
        };

        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
          window.addEventListener('gaminghub:native_observer_started', onStarted);
          window.addEventListener('gaminghub:native_observer_denied', onDenied);
        }

        // 60-second fallback timeout for user prompt
        setTimeout(() => {
          if (handled) return;
          handled = true;
          cleanup();
          resolve({ success: false, error: 'User consent prompt timed out' });
        }, 60000);
      });
    } catch (err: any) {
      return { success: false, error: err.message || 'Error communicating with Android observer service' };
    }
  }

  public async stopObservation(): Promise<NativeObserverResult> {
    if (this.isNativeAndroid() && window.GamingHubAndroidBridge?.stopObservation) {
      try {
        const raw = window.GamingHubAndroidBridge.stopObservation();
        const res = JSON.parse(raw);
        this.updateState({ isObserving: false });
        return {
          success: res.success ?? true,
          message: res.message || 'Observation stopped',
          diagnostics: this.currentDiagnostics,
        };
      } catch (err: any) {
        return { success: false, error: err.message || 'Error stopping observation' };
      }
    }

    this.updateState({ isObserving: false });
    return { success: true, message: 'Observation stopped' };
  }

  public addListener(cb: (diag: NativeObserverDiagnostics) => void): () => void {
    this.listeners.add(cb);
    cb({ ...this.currentDiagnostics });
    return () => this.listeners.delete(cb);
  }

  private updateState(partial: Partial<NativeObserverDiagnostics>) {
    this.currentDiagnostics = { ...this.currentDiagnostics, ...partial };
    this.listeners.forEach((cb) => cb({ ...this.currentDiagnostics }));
  }
}

export const nativeObserver = new NativeObserverClient();

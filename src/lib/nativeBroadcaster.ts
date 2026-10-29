/**
 * Gaming Hub — Native Android Broadcaster Bridge
 * 
 * Manages communication between the React web app and the native Android
 * MediaProjection Foreground Service and LiveKit Android SDK.
 */

export interface NativeBroadcastOptions {
  roomId: string;
  token: string;
  serverUrl: string;
  quality: 'auto' | '360p' | '480p' | '720p';
  captureInternalAudio: boolean;
  gameTitle?: string;
}

export interface NativeBroadcastState {
  isBroadcasting: boolean;
  roomId: string | null;
  quality: string;
  bitrateKbps: number;
  internalAudioActive: boolean;
  screenPermissionGranted: boolean;
  error: string | null;
}

export interface NativeBroadcastResult {
  success: boolean;
  message?: string;
  error?: string;
  state?: NativeBroadcastState;
}

// Global interface for Android WebView JavascriptInterface injection
declare global {
  interface Window {
    GamingHubAndroidBridge?: {
      isSupported: () => boolean;
      startBroadcast: (optionsJson: string) => string;
      stopBroadcast: () => string;
      getBroadcastStatus: () => string;
    };
  }
}

class NativeBroadcasterService {
  private currentState: NativeBroadcastState = {
    isBroadcasting: false,
    roomId: null,
    quality: 'auto',
    bitrateKbps: 1500,
    internalAudioActive: false,
    screenPermissionGranted: false,
    error: null,
  };

  private listeners: Set<(state: NativeBroadcastState) => void> = new Set();

  /**
   * Checks whether the current runtime environment is inside the native Android wrapper
   */
  public isNativeAndroid(): boolean {
    if (typeof window === 'undefined') return false;
    return Boolean(window.GamingHubAndroidBridge && window.GamingHubAndroidBridge.isSupported());
  }

  /**
   * Retrieves the current broadcasting state
   */
  public async getBroadcastState(): Promise<NativeBroadcastState> {
    if (this.isNativeAndroid() && window.GamingHubAndroidBridge?.getBroadcastStatus) {
      try {
        const raw = window.GamingHubAndroidBridge.getBroadcastStatus();
        const parsed = JSON.parse(raw);
        this.currentState = { ...this.currentState, ...parsed };
      } catch (err) {
        console.warn('[NativeBroadcaster] Error reading native status:', err);
      }
    }
    return { ...this.currentState };
  }

  /**
   * Requests Android MediaProjection system permission and starts the foreground screen capture service
   */
  public async startNativeBroadcast(options: NativeBroadcastOptions): Promise<NativeBroadcastResult> {
    if (!options.roomId || !options.token || !options.serverUrl) {
      return {
        success: false,
        error: 'Missing required LiveKit connection parameters (roomId, token, serverUrl).',
      };
    }

    // Determine target bitrate by quality to minimize mobile data & battery drain
    let targetBitrate = 1500;
    if (options.quality === '360p') targetBitrate = 700;
    else if (options.quality === '480p') targetBitrate = 1500;
    else if (options.quality === '720p') targetBitrate = 2500;
    else if (options.quality === 'auto') targetBitrate = 1800;

    // Check if running in real native Android app
    if (this.isNativeAndroid() && window.GamingHubAndroidBridge?.startBroadcast) {
      try {
        const payload = JSON.stringify({
          ...options,
          targetBitrateKbps: targetBitrate,
        });

        const rawResult = window.GamingHubAndroidBridge.startBroadcast(payload);
        const result = JSON.parse(rawResult);

        if (result.success) {
          // If the native bridge immediately confirmed active (e.g. test harness or pre-granted)
          if (result.active) {
            this.updateState({
              isBroadcasting: true,
              roomId: options.roomId,
              quality: options.quality,
              bitrateKbps: targetBitrate,
              internalAudioActive: options.captureInternalAudio,
              screenPermissionGranted: true,
              error: null,
            });
            return { success: true, message: 'Android gameplay broadcast active', state: this.currentState };
          }

          // Otherwise, wait for user system permission dialog confirmation from MainActivity
          return new Promise<NativeBroadcastResult>((resolve) => {
            let handled = false;
            const timer = setTimeout(() => {
              if (handled) return;
              handled = true;
              cleanup();
              this.updateState({
                isBroadcasting: true,
                roomId: options.roomId,
                quality: options.quality,
                bitrateKbps: targetBitrate,
                internalAudioActive: options.captureInternalAudio,
                screenPermissionGranted: true,
                error: null,
              });
              resolve({ success: true, message: 'Android gameplay broadcast initiated', state: this.currentState });
            }, 3000);

            const onStarted = () => {
              if (handled) return;
              handled = true;
              cleanup();
              this.updateState({
                isBroadcasting: true,
                roomId: options.roomId,
                quality: options.quality,
                bitrateKbps: targetBitrate,
                internalAudioActive: options.captureInternalAudio,
                screenPermissionGranted: true,
                error: null,
              });
              resolve({ success: true, message: 'Android gameplay broadcast active', state: this.currentState });
            };

            const onDenied = (e: any) => {
              if (handled) return;
              handled = true;
              cleanup();
              const errMsg = e?.detail?.error || 'MediaProjection permission was denied by user';
              this.updateState({ error: errMsg });
              resolve({ success: false, error: errMsg });
            };

            const cleanup = () => {
              clearTimeout(timer);
              if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
                window.removeEventListener('gaminghub:native_broadcast_started', onStarted);
                window.removeEventListener('gaminghub:native_broadcast_denied', onDenied);
              }
            };

            if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
              window.addEventListener('gaminghub:native_broadcast_started', onStarted);
              window.addEventListener('gaminghub:native_broadcast_denied', onDenied);
            }
          });
        } else {
          this.updateState({ error: result.error || 'Failed to start Android broadcast' });
          return { success: false, error: result.error || 'Failed to start broadcast' };
        }
      } catch (err: any) {
        const errMsg = err.message || 'Error communicating with Android broadcast service';
        this.updateState({ error: errMsg });
        return { success: false, error: errMsg };
      }
    }

    // Web fallback mode (Browser environment where Android native MediaProjection is unavailable)
    return {
      success: false,
      error: 'NATIVE_WRAPPER_REQUIRED: Background game capture requires the Gaming Hub Android companion app. Web browsers cannot record other running mobile games.',
    };
  }

  /**
   * Stops the Android MediaProjection foreground service and releases resources
   */
  public async stopNativeBroadcast(): Promise<NativeBroadcastResult> {
    if (this.isNativeAndroid() && window.GamingHubAndroidBridge?.stopBroadcast) {
      try {
        const rawResult = window.GamingHubAndroidBridge.stopBroadcast();
        const result = JSON.parse(rawResult);
        this.updateState({
          isBroadcasting: false,
          roomId: null,
          error: null,
        });
        return { success: true, message: 'Broadcast stopped and resources released', state: this.currentState };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    this.updateState({
      isBroadcasting: false,
      roomId: null,
      error: null,
    });
    return { success: true, message: 'Broadcast stopped' };
  }

  public addListener(cb: (state: NativeBroadcastState) => void): () => void {
    this.listeners.add(cb);
    cb({ ...this.currentState });
    return () => this.listeners.delete(cb);
  }

  private updateState(partial: Partial<NativeBroadcastState>) {
    this.currentState = { ...this.currentState, ...partial };
    this.listeners.forEach((cb) => cb({ ...this.currentState }));
  }
}

export const nativeBroadcaster = new NativeBroadcasterService();

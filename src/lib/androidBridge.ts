import { InstallationStatus, SupportedGame } from '../types.js';

// Declaration for optional Native Android WebView JavascriptInterface
declare global {
  interface Window {
    AndroidBridge?: {
      isPackageInstalled: (packageId: string) => boolean;
      launchPackage: (packageId: string) => boolean;
      getInstalledGamesList?: () => string; // JSON array of installed package names
      getDeviceModel?: () => string;
      getAndroidVersion?: () => number;
    };
    GamingHubNative?: {
      isInstalled: (packageId: string) => boolean;
      launchApp: (packageId: string) => boolean;
    };
  }
}

export class AndroidBridgeClient {
  private userInstalledMap: Map<string, InstallationStatus> = new Map();

  constructor() {
    this.loadUserStatusCache();
  }

  private loadUserStatusCache() {
    try {
      const cached = localStorage.getItem('gh_package_status');
      if (cached) {
        const obj = JSON.parse(cached);
        Object.entries(obj).forEach(([pkg, status]) => {
          this.userInstalledMap.set(pkg, status as InstallationStatus);
        });
      }
    } catch {
      // Ignore in non-browser env
    }
  }

  private saveUserStatusCache() {
    try {
      const obj: Record<string, string> = {};
      this.userInstalledMap.forEach((val, key) => {
        obj[key] = val;
      });
      localStorage.setItem('gh_package_status', JSON.stringify(obj));
    } catch {
      // Ignore
    }
  }

  // Detect whether running in a native Android WebView wrapper
  public isNativeWrapper(): boolean {
    if (typeof window === 'undefined') return false;
    return Boolean(window.AndroidBridge || window.GamingHubNative);
  }

  // Get current runtime environment info
  public getRuntimeEnvironment() {
    const isNative = this.isNativeWrapper();
    const isAndroidDevice = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent);

    return {
      isNative,
      isAndroidDevice,
      runtimeType: isNative ? 'Native Android Container' : 'Web Browser (React/PWA)',
      packageNameDiscoveryMethod: isNative
        ? 'Native PackageManager API (via JavascriptInterface)'
        : 'Web Sandbox Limited (User-Declared & Android Intent URIs)',
      restrictionsNotice: isNative
        ? 'Native Android container active. Uses AndroidManifest.xml <queries> declarations to discover installed games.'
        : 'Standard Web browsers are sandboxed by Android security and cannot enumerate installed apps directly. Intent URIs and user confirmation are used.',
    };
  }

  // Query installation status of a package
  public getInstallationStatus(packageId: string): InstallationStatus {
    // 1. If running inside native Android WebView with injected bridge:
    if (window.AndroidBridge?.isPackageInstalled) {
      try {
        const installed = window.AndroidBridge.isPackageInstalled(packageId);
        return installed ? 'installed' : 'not_installed';
      } catch (err) {
        console.warn('Native bridge isPackageInstalled check failed:', err);
      }
    }

    // 2. Check user's manual device verification cache
    if (this.userInstalledMap.has(packageId)) {
      return this.userInstalledMap.get(packageId)!;
    }

    // 3. Default to 'unknown' in standard browser mode
    return 'unknown';
  }

  // Set user's verified status for a package in browser mode
  public setInstallationStatus(packageId: string, status: InstallationStatus) {
    this.userInstalledMap.set(packageId, status);
    this.saveUserStatusCache();
  }

  // Launch a game
  public launchGame(game: SupportedGame): { success: boolean; method: string; message: string } {
    // 1. If native Android Bridge is available
    if (window.AndroidBridge?.launchPackage) {
      try {
        const launched = window.AndroidBridge.launchPackage(game.packageId);
        if (launched) {
          return {
            success: true,
            method: 'Native PackageManager Intent',
            message: `Launched ${game.name} via native Android Intent.`,
          };
        }
      } catch (err) {
        console.warn('Native bridge launch failed:', err);
      }
    }

    // 2. Android Web Intent URI approach
    // In Android Chrome/Firefox, intent:// URIs launch the installed app directly
    try {
      if (typeof window !== 'undefined') {
        const isAndroid = /android/i.test(navigator.userAgent);

        if (isAndroid) {
          // Open intent URI
          window.location.href = game.intentUri;
          return {
            success: true,
            method: 'Android Intent URI',
            message: `Dispatched Android Intent for ${game.name}. Opening app...`,
          };
        } else {
          // Desktop / Non-Android Preview mode: Open Google Play or app page
          return {
            success: true,
            method: 'Simulated Intent / Play Store Link',
            message: `Desktop preview: In a real Android device, this dispatches package intent '${game.packageId}'.`,
          };
        }
      }
    } catch (err) {
      return {
        success: false,
        method: 'Intent Failed',
        message: `Failed to launch intent: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      success: true,
      method: 'Web Intent',
      message: `Intent dispatched for ${game.name}.`,
    };
  }
}

export const androidBridge = new AndroidBridgeClient();

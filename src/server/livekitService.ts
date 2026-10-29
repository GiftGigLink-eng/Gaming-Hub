import { AccessToken, TokenVerifier } from 'livekit-server-sdk';
import { MatchRoom } from '../types.js';

export class LiveKitCredentialsMissingError extends Error {
  constructor(message = 'LiveKit server credentials are not configured on the server.') {
    super(message);
    this.name = 'LiveKitCredentialsMissingError';
  }
}

export class UnauthorizedStreamHostError extends Error {
  constructor(message = 'Unauthorized: Only the verified room host can request broadcasting permissions.') {
    super(message);
    this.name = 'UnauthorizedStreamHostError';
  }
}

export interface LiveKitTokenResponse {
  token: string;
  serverUrl: string;
  roomName: string;
  participant: {
    identity: string;
    name: string;
    isHost: boolean;
  };
  permissions: {
    canPublish: boolean;
    canSubscribe: boolean;
    canPublishData: boolean;
  };
}

// Test / non-production config override hook
let testConfigOverride: { apiKey?: string; apiSecret?: string; serverUrl?: string } | null = null;

export function setLiveKitTestConfig(config: { apiKey?: string; apiSecret?: string; serverUrl?: string } | null) {
  if (process.env.NODE_ENV === 'production' && config !== null) {
    throw new Error('LiveKit test configuration overrides are strictly forbidden in production.');
  }
  testConfigOverride = config;
}

export class LiveKitService {
  /**
   * Retrieves server-side LiveKit credentials from environment variables.
   * Fails closed if credentials are not configured.
   */
  private getCredentials(): { apiKey: string; apiSecret: string; serverUrl: string } {
    const apiKey = testConfigOverride?.apiKey || process.env.LIVEKIT_API_KEY;
    const apiSecret = testConfigOverride?.apiSecret || process.env.LIVEKIT_API_SECRET;
    const serverUrl = testConfigOverride?.serverUrl || process.env.LIVEKIT_URL || process.env.LIVEKIT_WS_URL || 'wss://livekit.gaminghub.ng';

    if (!apiKey || !apiSecret) {
      throw new LiveKitCredentialsMissingError(
        'LiveKit API key or Secret is missing. Set LIVEKIT_API_KEY and LIVEKIT_API_SECRET in the server environment.'
      );
    }

    return { apiKey, apiSecret, serverUrl };
  }

  /**
   * Generates a cryptographically signed LiveKit AccessToken for an authenticated room member.
   * 
   * Strict Security Enforcements:
   * 1. Identity is derived strictly from server-verified user UID (never client body).
   * 2. Host status is derived strictly by checking room.hostId === userId in Firestore.
   * 3. If a non-host explicitly attempts to request broadcasting/publishing rights, it fails with 403.
   * 4. Viewers receive strictly subscribe-only tokens (canPublish: false).
   * 5. API keys and secrets stay exclusively on the server.
   */
  public async generateRoomToken(
    room: MatchRoom,
    userId: string,
    userName: string,
    requestPublish: boolean = false
  ): Promise<LiveKitTokenResponse> {
    const { apiKey, apiSecret, serverUrl } = this.getCredentials();

    // Zero-Trust Host Role Derivation
    const isHost = room.hostId === userId;

    // Reject non-hosts attempting to acquire broadcast / publisher rights
    if (requestPublish && !isHost) {
      throw new UnauthorizedStreamHostError(
        `User '${userId}' is not the authorized host of room '${room.id}'. Publishing rights denied.`
      );
    }

    // Role-based permissions
    const canPublish = isHost;
    const canSubscribe = true;
    const canPublishData = true;

    // Create Access Token
    const at = new AccessToken(apiKey, apiSecret, {
      identity: userId,
      name: userName || (isHost ? 'Host' : 'Viewer'),
      ttl: '2h', // 2-hour session lifetime
    });

    // Scoped Video Grants
    at.addGrant({
      room: room.id,
      roomJoin: true,
      canPublish,
      canSubscribe,
      canPublishData,
    });

    const jwt = await at.toJwt();

    return {
      token: jwt,
      serverUrl,
      roomName: room.id,
      participant: {
        identity: userId,
        name: userName || (isHost ? 'Host' : 'Viewer'),
        isHost,
      },
      permissions: {
        canPublish,
        canSubscribe,
        canPublishData,
      },
    };
  }

  /**
   * Verifies and decodes a LiveKit JWT token for automated security test verification.
   */
  public async verifyTokenClaims(token: string): Promise<any> {
    const { apiKey, apiSecret } = this.getCredentials();
    const verifier = new TokenVerifier(apiKey, apiSecret);
    return await verifier.verify(token);
  }
}

export const livekitService = new LiveKitService();

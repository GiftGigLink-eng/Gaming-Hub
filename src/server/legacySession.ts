import { Response } from 'express';
import { AuthenticatedRequest } from './firebaseAdmin.js';

/**
 * Stage 3.1 Safety Policy:
 * The 1-hour gaming session start endpoint is permanently retired.
 * It strictly rejects requests with HTTP 410 Gone, ensuring no money
 * is ever deducted and no hourly session documents are ever created.
 */
export async function legacySessionStartHandler(_req: AuthenticatedRequest, res: Response) {
  return res.status(410).json({
    success: false,
    error: 'The 1-hour hourly gaming session endpoint is permanently retired. Gaming Hub operates exclusively on the Match Opportunity model (₦100/match). This endpoint does not deduct funds or create sessions.',
    code: 'LEGACY_SESSION_ENDPOINT_RETIRED',
    stage: 'Stage 3.1 Safety Cleanup',
  });
}

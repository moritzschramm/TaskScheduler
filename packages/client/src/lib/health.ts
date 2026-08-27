import { healthErrorSchema, healthResponseSchema, type HealthResponse } from '@ambitime/shared';
import { api } from './api';

export type HealthResult =
  { state: 'ok'; data: HealthResponse } | { state: 'error'; message: string };

/**
 * Fetches `/api/health` and validates the payload with the *shared* schema, so
 * a server/client contract drift fails here rather than rendering nonsense.
 */
export async function fetchHealth(): Promise<HealthResult> {
  let response: Response;

  try {
    response = await api.api.health.$get();
  } catch (cause) {
    return {
      state: 'error',
      message: cause instanceof Error ? cause.message : 'Could not reach the server',
    };
  }

  const payload: unknown = await response.json();

  if (response.ok) {
    const parsed = healthResponseSchema.safeParse(payload);
    return parsed.success
      ? { state: 'ok', data: parsed.data }
      : { state: 'error', message: 'Server returned an unexpected health payload' };
  }

  const parsedError = healthErrorSchema.safeParse(payload);
  return {
    state: 'error',
    message: parsedError.success ? parsedError.data.message : `Server responded ${response.status}`,
  };
}

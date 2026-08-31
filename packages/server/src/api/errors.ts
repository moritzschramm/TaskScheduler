import { z } from 'zod';
import { CommandError, CommandValidationError, OptimisticLockError } from '../commands/errors.js';
import { UnauthenticatedError } from '../auth/context.js';
import { CalendarNotFoundError } from '../schedule/load-context.js';
import { ScheduleInvariantError } from '../schedule/commit-check.js';
import { TenantAccessError } from '../db/context.js';
import type { ApiErrorCode, ErrorResponse } from '@ambitime/shared';

/**
 * Turning a thrown thing into an answer (spec §6.7, §11).
 *
 * Two rules shape this. The **code** is the API's own vocabulary, not HTTP's:
 * a client deciding what to do about a stale version should not be
 * pattern-matching on 409, and the codes outlive whatever status they map to.
 * The **message** is written for the person who will read it — the command
 * layer already phrases its failures that way, which is why they are passed
 * through rather than replaced with something generic.
 *
 * Anything unrecognised becomes a 500 with a fixed message. An unexpected
 * error's text is the one place a stack trace, a query or a hostname can leak
 * into a response, and none of those is the caller's business.
 */

/**
 * The statuses a failure can carry — a closed union, not `ContentfulStatusCode`.
 *
 * This is load-bearing for the RPC contract, not merely tidy. Hono infers a
 * route's response type as the union of everything it can return, keyed by
 * status; a widened status makes the error body reachable at 200, and a client
 * can then no longer narrow to the success body by checking for one. The union
 * below is what lets `if (response.status === 200)` mean something.
 */
export type ApiErrorStatus = 400 | 401 | 404 | 409 | 422 | 429 | 500;

const STATUS: Readonly<Record<ApiErrorCode, ApiErrorStatus>> = {
  invalid_request: 400,
  invalid_command: 422,
  unauthenticated: 401,
  not_found: 404,
  version_conflict: 409,
  precondition_failed: 409,
  invariant_violated: 409,
  rate_limited: 429,
  internal: 500,
};

export interface ApiFailure {
  status: ApiErrorStatus;
  body: ErrorResponse;
}

export function toApiFailure(error: unknown): ApiFailure {
  if (error instanceof UnauthenticatedError) {
    return failure('unauthenticated', 'Not signed in');
  }

  // A membership revoked mid-session: the credential is fine, the access is not.
  if (error instanceof TenantAccessError) {
    return failure('not_found', 'That context is no longer available');
  }

  if (error instanceof OptimisticLockError) {
    return failure('version_conflict', error.message, {
      expectedVersion: error.expectedVersion,
      actualVersion: error.actualVersion,
    });
  }

  if (error instanceof CommandValidationError) {
    return failure('invalid_command', error.message, { details: [...error.issues] });
  }

  if (error instanceof CommandError) {
    return failure(commandCode(error.code), error.message);
  }

  if (error instanceof CalendarNotFoundError) {
    return failure('not_found', error.message);
  }

  // §3.3's commit check refused the write. Worth its own code: nothing the
  // caller sent was malformed, and retrying it unchanged will fail again.
  if (error instanceof ScheduleInvariantError) {
    return failure('invariant_violated', error.message);
  }

  return failure('internal', 'Something went wrong');
}

/**
 * Zod failures from the request validator, before a command is even assembled.
 *
 * Typed against Zod's core error rather than `ZodError`: that is what the Hono
 * validator hands over, and widening here beats casting at the call site.
 */
export function toValidationFailure(error: z.core.$ZodError): ApiFailure {
  return failure('invalid_request', `Not a valid request: ${z.prettifyError(error)}`, {
    details: error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    })),
  });
}

/**
 * The command layer's codes are already the right vocabulary — they were chosen
 * for a caller rather than for a transport — so this is a widening, not a
 * translation.
 */
function commandCode(code: string): ApiErrorCode {
  switch (code) {
    case 'invalid_command':
    case 'not_found':
    case 'version_conflict':
    case 'precondition_failed':
      return code;
    default:
      return 'internal';
  }
}

function failure(
  code: ApiErrorCode,
  message: string,
  extra: Omit<ErrorResponse['error'], 'code' | 'message'> = {},
): ApiFailure {
  return { status: STATUS[code], body: { error: { code, message, ...extra } } };
}

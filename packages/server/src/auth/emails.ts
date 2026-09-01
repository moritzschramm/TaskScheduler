import type { EmailMessage } from '../notifications/email.js';

/**
 * The two messages authentication has to send (spec §10.1).
 *
 * Both are the same shape of thing: a link that stands in for proof the reader
 * controls the address it was sent to. That is the whole mechanism — which is
 * why the wording matters more than it looks. Somebody who did **not** ask for
 * either of these needs to know that ignoring the mail is the correct and
 * sufficient response, because the alternative is a person clicking a link to
 * find out what it does.
 *
 * They compose an `EmailMessage` rather than sending one, so they can be
 * asserted on directly and so the transport stays the single thing that
 * changes when a deployment picks a provider (see `notifications/email.ts`).
 * The links themselves are Better Auth's, built from `baseURL`; nothing here
 * constructs a URL, because a second place that knew how would be a second
 * place that could be wrong.
 */

/**
 * How long a reset link stays good, in minutes.
 *
 * An hour is the shortest window that still survives the way people actually
 * read email — noticing it later, on a phone, after a meeting. Shorter buys
 * little: the link is single-use and consumed on redemption, so the exposure
 * that matters is the mailbox rather than the clock.
 */
export const PASSWORD_RESET_TTL_MINUTES = 60;

/**
 * How long a verification link stays good, in minutes.
 *
 * A day rather than an hour, because this one is sent unprompted at sign-up
 * and there is no failure a person can act on: a verification link that has
 * expired looks exactly like an application that is broken.
 */
export const EMAIL_VERIFICATION_TTL_MINUTES = 60 * 24;

export interface AuthLink {
  to: string;
  url: string;
}

export function passwordResetMessage({ to, url }: AuthLink): EmailMessage {
  return {
    to,
    subject: 'Ambitime — reset your password',
    body: [
      'Someone asked to reset the password for this Ambitime account.',
      '',
      `Choose a new one here (the link works once, and for ${describe(PASSWORD_RESET_TTL_MINUTES)}):`,
      url,
      '',
      // The reassurance is the point: without it, the safe response and the
      // frightening one look the same from the reader's side.
      'If that was not you, nothing has changed and you can ignore this. Your',
      'current password still works, and nobody can use this link without',
      'reading this message.',
    ].join('\n'),
  };
}

export function emailVerificationMessage({ to, url }: AuthLink): EmailMessage {
  return {
    to,
    subject: 'Ambitime — confirm your email address',
    body: [
      'Confirm this address so Ambitime can reach you when your schedule needs',
      'you — a hard due date at risk, or an appointment somebody moved.',
      '',
      `Confirm here (the link works for ${describe(EMAIL_VERIFICATION_TTL_MINUTES)}):`,
      url,
      '',
      'If you did not create an Ambitime account, ignore this. The address is',
      'not confirmed until somebody follows that link, and an unconfirmed',
      'address is never written to.',
    ].join('\n'),
  };
}

/**
 * The lifetime in words.
 *
 * Derived from the constant rather than written beside it, so a deployment
 * that shortens one cannot end up promising the other.
 */
function describe(minutes: number): string {
  if (minutes % (60 * 24) === 0) return plural(minutes / (60 * 24), 'day');
  if (minutes % 60 === 0) return plural(minutes / 60, 'hour');
  return plural(minutes, 'minute');
}

function plural(count: number, unit: string): string {
  return count === 1 ? `one ${unit}` : `${count} ${unit}s`;
}

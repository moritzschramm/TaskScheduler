import { validateSchedule, type ScheduleContext, type Placement } from '@ambitime/scheduler';
import type { Violation } from '@ambitime/scheduler';

/**
 * The commit-time invariant check (spec §3.3).
 *
 * §3.3 is explicit about why this exists and about when it starts mattering:
 *
 * > For single-user private tasks, server re-derivation is sufficient. Once
 * > shared resources exist [...] the server must additionally **validate the
 * > proposed schedule against current persisted state inside a transaction with
 * > optimistic locking**, because the world can change between client
 * > computation and commit.
 *
 * Shared resources are a deferred feature, so today this validates a schedule
 * the server itself just produced — which should never fail. That is not a
 * reason to leave it out. It is wired **now**, inside the apply transaction, so
 * that supporting a client-proposed schedule later is a matter of passing
 * different placements to the same call rather than restructuring the write
 * path around a check it was never built to run.
 *
 * The check is on **hard invariants only** (§6.2), and §3.3 says why that is
 * the right shape: validating a proposed placement is order-independent and
 * cheap, where "naively recomputing and comparing" would be neither — two
 * correct schedules can differ, so a comparison would reject work that was
 * fine.
 */

/** Raised when a write would have committed a schedule that violates §6.2. */
export class ScheduleInvariantError extends Error {
  constructor(
    readonly calendarId: string,
    readonly violations: Violation[],
  ) {
    const summary = violations
      .slice(0, 3)
      .map((violation) => violation.message)
      .join(' ');
    super(
      `Refusing to commit a schedule for calendar ${calendarId} that violates ${violations.length} hard constraint(s). ${summary}`,
    );
    this.name = 'ScheduleInvariantError';
  }
}

export interface CommitCheckInput {
  calendarId: string;
  /** The context as it stands *in this transaction*, not as the caller saw it. */
  context: ScheduleContext;
  /** The placements about to be persisted. */
  placements: readonly Placement[];
}

/**
 * Throws unless every hard constraint holds, which aborts the transaction.
 *
 * Rolling back is the only safe response. A schedule that violates §6.2 has
 * double-booked someone or broken a deadline, and a half-applied command is a
 * worse thing to leave behind than a failed one.
 */
export function assertScheduleHoldsInvariants({
  calendarId,
  context,
  placements,
}: CommitCheckInput): void {
  const result = validateSchedule(context, placements);
  if (result.valid) return;

  throw new ScheduleInvariantError(calendarId, result.violations);
}

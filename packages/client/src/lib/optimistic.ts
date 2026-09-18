import { DEFAULT_TUNING, solve, type ScheduleContext } from '@ambitime/scheduler';
import { projectCommand, type CommandRequest, type ScheduledBlock } from '@ambitime/shared';

/**
 * The optimistic solve (spec §3.3; plan M12).
 *
 * The scheduler is isomorphic *because* this exists. The same engine that ran
 * on the server runs here, over the context the server sent, so a gesture can
 * show its result immediately instead of after a round trip — and the result it
 * shows is the one the server will produce, because nothing about the
 * computation differs.
 *
 * **Nothing here is authoritative.** The command still goes to the server, the
 * server still re-derives, and its answer replaces this one. What is drawn in
 * between is a prediction that happens to be reliable, not a decision.
 */

/** What a command would do, drawn as blocks, or `null` if it is not modelled. */
export function optimisticBlocks(
  context: ScheduleContext,
  command: CommandRequest,
  describe: (occurrenceId: string) => {
    taskId: string;
    title: string;
    activityTypeId: string | null;
  },
): ScheduledBlock[] | null {
  const projected = projectCommand({ context, command, config: DEFAULT_TUNING });
  if (projected === null) return null;

  const result = solve(projected, { config: DEFAULT_TUNING });

  return result.placements.map((placement) => {
    const described = describe(placement.occurrenceId);
    return {
      occurrenceId: placement.occurrenceId,
      taskId: described.taskId,
      title: described.title,
      activityTypeId: described.activityTypeId,
      start: toIso(placement.interval.start),
      end: toIso(placement.interval.end),
      cooldownMin: placement.cooldownMin,
    };
  });
}

/**
 * Whether a prediction turned out to be right.
 *
 * Compared on what a person can see — which task, from when, until when —
 * rather than on the whole record. Cooldowns and occurrence ids are real, but a
 * difference in them is not a schedule that looks different, and reporting one
 * as a mismatch would train the user to ignore the signal.
 */
export function schedulesAgree(
  predicted: readonly ScheduledBlock[],
  actual: readonly ScheduledBlock[],
): boolean {
  const key = (blocks: readonly ScheduledBlock[]) =>
    blocks
      .map((block) => `${block.taskId}@${block.start}-${block.end}`)
      .sort()
      .join('|');

  return key(predicted) === key(actual);
}

const MS_PER_MINUTE = 60_000;

function toIso(instant: number): string {
  return new Date(instant * MS_PER_MINUTE).toISOString();
}

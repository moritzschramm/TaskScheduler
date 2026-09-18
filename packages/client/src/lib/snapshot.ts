import type {
  BacklogEntry,
  CalendarConfiguration,
  CalendarSummary,
  CapacityCell,
  FixedBlock,
  Schedule,
  ScheduledBlock,
  TaskNode,
} from '@ambitime/shared';
import { formatMinuteOfDay, localDate, minuteOfDay, formatCivilDate, weekdayNames } from './time';

/**
 * The schedule, written out for a model to read (spec §2.2).
 *
 * This is the "pre-fill" half of the natural-language interface, and it is what
 * makes the thing feel instant rather than conversational: the whole week, the
 * task list, the backlog and the reasons things did not fit are already in
 * context when the first question arrives, so "what is on Thursday?" and "why
 * is the invoicing in next week?" are answered without a tool call, a round
 * trip, or a second request the person waits through.
 *
 * **Prose, not JSON.** The reader is a language model and the writer is this
 * file; there is no parser at the other end to please. Sentences cost fewer
 * tokens than the same facts wrapped in braces and quotes, and they carry the
 * units — `45m`, `09:00–10:00`, `soft` — where JSON would need a key to say so.
 *
 * **Ids in full.** They are ugly and they are the whole point: every tool call
 * names one, and a truncated id is a task the assistant cannot act on. Titles
 * are not identifiers — two tasks may share one — so the ids travel beside them
 * and the prompt tells the model to speak in titles and act in ids.
 *
 * **Context, never authority.** It goes to the server and on to the provider,
 * and nothing is trusted back: a command that came out of this is validated and
 * applied under the caller's own row-level security like any other. A snapshot
 * that lied would buy nothing, because the command naming the invented task
 * would fail.
 */

export interface SnapshotInput {
  now: string;
  zone: string;
  locale: string;
  calendar: CalendarSummary | undefined;
  configuration: CalendarConfiguration | null;
  schedule: Schedule | null;
  fixedBlocks: readonly FixedBlock[];
  tasks: readonly TaskNode[];
  backlog: readonly BacklogEntry[];
  capacity: readonly CapacityCell[];
  /** The week on screen, so "this week" means what the person can see. */
  days: readonly { year: number; month: number; day: number }[];
}

/**
 * Where a list stops.
 *
 * A planner with four hundred tasks is a planner whose whole list is not the
 * assistant's business on any one question, and a snapshot that grew without
 * limit would be a bill that grew without limit. The count of what was left out
 * is stated, because a model that knows the list is partial asks; one that
 * thinks it is complete answers confidently and wrongly.
 */
const LIST_LIMIT = 120;

export function renderSnapshot(input: SnapshotInput): string {
  const lines: string[] = [];
  const names = new Map(input.configuration?.activityTypes.map((c) => [c.id, c.name]) ?? []);
  const titles = new Map(input.tasks.map((task) => [task.id, task.title]));

  lines.push('# The schedule, as the user is looking at it');
  lines.push('');
  lines.push(`Now: ${input.now}`);
  lines.push(`Timezone: ${input.zone} (every date and time below is local to it)`);

  if (input.calendar !== undefined) lines.push(`Planner: ${input.calendar.name}`);

  const first = input.days[0];
  const last = input.days[input.days.length - 1];
  if (first !== undefined && last !== undefined) {
    lines.push(`Week on screen: ${formatCivilDate(first)} to ${formatCivilDate(last)}`);
  }

  if (input.schedule !== null) {
    lines.push(
      `Tasks are placed up to ${localDateOf(input.schedule.horizon.end, input.zone)}; ` +
        'anything later waits in the backlog.',
    );
  }

  section(lines, 'Activity types', activityTypes(input));
  section(lines, 'Special weeks', specialWeeks(input));
  section(lines, 'Fixed blocks on screen', fixedBlocks(input));
  section(lines, 'Tasks the scheduler has placed on screen', placements(input, names));
  section(lines, 'All tasks', taskList(input, names, titles));
  section(lines, 'Backlog', backlog(input));
  section(lines, 'Tasks the scheduler could not use', unusable(input, titles));
  section(lines, 'Capacity', capacity(input, names));

  return lines.join('\n');
}

function section(lines: string[], heading: string, body: string[]): void {
  lines.push('', `## ${heading}`, '');
  lines.push(...(body.length === 0 ? ['(none)'] : body));
}

/** `2026-09-16 14:32` in the calendar's zone — how every instant is written. */
function stamp(iso: string, zone: string): string {
  return `${localDateOf(iso, zone)} ${formatMinuteOfDay(minuteOfDay(iso, zone))}`;
}

function localDateOf(iso: string, zone: string): string {
  return formatCivilDate(localDate(iso, zone));
}

function activityTypes({ configuration, locale }: SnapshotInput): string[] {
  if (configuration === null) return [];

  return configuration.activityTypes.map((activityType) => {
    // The hours are what decides whether a task can be scheduled at all, so
    // they travel with the type rather than in a section of their own — "no
    // window on a Saturday" is the answer to half the questions this gets.
    // They are also the *whole* set, because `SetAvailabilityWindows` replaces
    // a set rather than adding to it: a caller working from a partial list
    // would delete the part it could not see.
    const windows = hoursFor(configuration, activityType.id, null, locale);
    const cooldown =
      activityType.defaultCooldownMin > 0 ? `, ${activityType.defaultCooldownMin}m cooldown` : '';

    return (
      `- ${activityType.id} "${activityType.name}"${cooldown} — ` +
      (windows === null ? 'no hours set, so nothing is ever placed in it' : windows)
    );
  });
}

/** One address's whole set, in reading order, or `null` when it is empty. */
function hoursFor(
  configuration: CalendarConfiguration,
  activityTypeId: string,
  weekTypeOverrideId: string | null,
  locale: string,
): string | null {
  const weekdays = weekdayNames(locale, 'short');

  const windows = configuration.availability
    .filter(
      (window) =>
        window.activityTypeId === activityTypeId &&
        window.weekTypeOverrideId === weekTypeOverrideId,
    )
    .sort((a, b) => a.weekday - b.weekday || a.startMin - b.startMin)
    .map(
      (window) =>
        `${weekdays[window.weekday - 1] ?? window.weekday} ` +
        `${formatMinuteOfDay(window.startMin)}\u2013${formatMinuteOfDay(window.endMin)}` +
        (window.focusLevel === null ? '' : ` (focus ${window.focusLevel})`),
    );

  return windows.length === 0 ? null : windows.join(', ');
}

/**
 * The stretches that run on different hours (§4.3).
 *
 * Each one lists every activity type, including the ones with nothing set —
 * because an override *replaces* the ordinary set rather than adding to it, so
 * "nothing set" during a holiday is not missing information, it is the holiday.
 * A reader who saw only the types with hours would conclude the rest carried on
 * as usual.
 */
function specialWeeks({ configuration, locale }: SnapshotInput): string[] {
  if (configuration === null) return [];

  return configuration.weekTypeOverrides.flatMap((override) => {
    const head =
      `- ${override.id} "${override.name}" from ${override.startDate} up to but not ` +
      `including ${override.endDate}. During it these hours replace the ordinary ones:`;

    const sets = configuration.activityTypes.map((activityType) => {
      const windows = hoursFor(configuration, activityType.id, override.id, locale);
      return (
        `  - "${activityType.name}": ` +
        (windows ?? 'nothing, so it is not available at all during this week')
      );
    });

    return [head, ...sets];
  });
}

function fixedBlocks({ fixedBlocks: blocks, zone }: SnapshotInput): string[] {
  return [...blocks]
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, LIST_LIMIT)
    .map((block) => {
      const parts = [
        block.isUnavailability ? 'unavailable' : 'appointment',
        block.cooldownMin > 0 ? `${block.cooldownMin}m cooldown after` : '',
        block.isRecurring
          ? `one of a repeating series, this instance ${block.occurrenceStart}`
          : '',
        block.status !== 'confirmed' ? block.status : '',
      ].filter((part) => part !== '');

      return (
        `- ${block.appointmentId} ${stamp(block.start, zone)}–` +
        `${formatMinuteOfDay(minuteOfDay(block.end, zone))} ` +
        `"${block.title === '' ? '(no title)' : block.title}" (${parts.join(', ')})`
      );
    });
}

function placements({ schedule, zone }: SnapshotInput, names: Map<string, string>): string[] {
  if (schedule === null) return [];

  return [...schedule.blocks]
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, LIST_LIMIT)
    .map(
      (block: ScheduledBlock) =>
        `- ${stamp(block.start, zone)}–${formatMinuteOfDay(minuteOfDay(block.end, zone))} ` +
        `"${block.title}" (task ${block.taskId}` +
        `${block.activityTypeId === null ? '' : `, ${names.get(block.activityTypeId) ?? 'unknown type'}`}` +
        `${block.cooldownMin > 0 ? `, ${block.cooldownMin}m cooldown after` : ''})`,
    );
}

function taskList(
  { tasks, zone }: SnapshotInput,
  names: Map<string, string>,
  titles: Map<string, string>,
): string[] {
  const active = tasks.filter((task) => task.status === 'active');
  const lines = active.slice(0, LIST_LIMIT).map((task) => describeTask(task, zone, names, titles));

  if (active.length > LIST_LIMIT) {
    lines.push(`(and ${active.length - LIST_LIMIT} more not listed here)`);
  }

  // Completed and cancelled ones are named but not described: enough for "did
  // I do the invoices?", not enough to crowd out the work that is still to do.
  const done = tasks.filter((task) => task.status !== 'active').slice(0, 30);
  if (done.length > 0) {
    lines.push(
      `Recently closed: ${done.map((task) => `"${task.title}" (${task.status})`).join(', ')}`,
    );
  }

  return lines;
}

function describeTask(
  task: TaskNode,
  zone: string,
  names: Map<string, string>,
  titles: Map<string, string>,
): string {
  const facts: string[] = [];

  if (task.effectiveActivityTypeId !== null) {
    facts.push(names.get(task.effectiveActivityTypeId) ?? 'unknown type');
  }

  facts.push(task.estimatedDurationMin === null ? 'no estimate' : `${task.estimatedDurationMin}m`);

  if (task.effectivePriority !== null) facts.push(`priority ${task.effectivePriority}`);

  if (task.effectiveDueDate !== null) {
    facts.push(`due ${stamp(task.effectiveDueDate, zone)} (${task.effectiveDueKind ?? 'soft'})`);
  }

  if (task.effectivePreferredStartMin !== null && task.effectivePreferredEndMin !== null) {
    facts.push(
      `prefers ${formatMinuteOfDay(task.effectivePreferredStartMin)}–` +
        `${formatMinuteOfDay(task.effectivePreferredEndMin)}`,
    );
  }

  if (task.recurrence !== null) {
    facts.push(`${task.recurrence.count}× per ${task.recurrence.period}`);
  }

  // Both are invisible in the schedule — a task sitting at 14:00 looks the same
  // whether it chose to or was told to — so they are worth saying out loud.
  if (task.manualFloor !== null) facts.push(`not before ${stamp(task.manualFloor, zone)}`);
  if (!task.isLeaf) facts.push('has subtasks, so it is not scheduled itself');
  if (task.parentId !== null) {
    facts.push(`subtask of "${titles.get(task.parentId) ?? 'another task'}" (${task.parentId})`);
  }

  return `- ${task.id} "${task.title}" — ${facts.join(', ')}`;
}

function backlog({ backlog: entries }: SnapshotInput): string[] {
  return entries
    .slice(0, LIST_LIMIT)
    .map(
      (entry: BacklogEntry) =>
        `- ${entry.taskId} "${entry.title}"` +
        `${entry.estimatedWeek === null ? '' : ` — likely week of ${entry.estimatedWeek}`}` +
        ` — ${entry.reason}`,
    );
}

/**
 * The tasks the solver was never offered, and why (§6.7).
 *
 * Worth its own heading rather than a footnote on the task list, because it is
 * the commonest thing a person is confused by — a task that is simply absent
 * from the week, with no diagnostic anywhere, because it has no duration.
 */
function unusable({ schedule }: SnapshotInput, titles: Map<string, string>): string[] {
  if (schedule === null) return [];

  const reasons: Record<string, string> = {
    no_activity_type: 'has no activity type, so there are no hours it may be placed in',
    no_duration: 'has no estimate, so there is nothing to place',
  };

  const lines = schedule.unschedulable.map(
    (entry) =>
      `- ${entry.taskId} "${titles.get(entry.taskId) ?? 'a task'}" — ` +
      `${reasons[entry.reason] ?? entry.reason}`,
  );

  for (const diagnostic of schedule.diagnostics) {
    lines.push(
      `- ${diagnostic.taskId} "${titles.get(diagnostic.taskId) ?? 'a task'}" — ` +
        `${diagnostic.severity}: ${diagnostic.message}`,
    );
  }

  return lines;
}

function capacity({ capacity: cells }: SnapshotInput, names: Map<string, string>): string[] {
  return cells.map((cell) => {
    const used =
      cell.utilization === null ? 'no hours at all' : `${Math.round(cell.utilization * 100)}% used`;

    return (
      `- ${names.get(cell.activityTypeId) ?? cell.activityTypeId}, week of ${cell.weekStart}: ` +
      `${used} (${cell.status}), ${cell.supplyMin}m available against ${cell.demandMin}m of work`
    );
  });
}

import {
  assistantParamsSchema,
  needsCalendarId,
  type AssistantCall,
  type AvailabilityWindow,
  type CommandRequest,
} from '@ambitime/shared';
import { language, translate, type MessageKey, type Params } from '@/i18n';
import { formatMinuteOfDay, localDate, weekdayNames } from './time';

/**
 * A proposed command, checked and then said in a sentence (spec §2.2).
 *
 * The description is built **from the command**, never from what the model said
 * about it. That is the whole trust story of this feature: a person pressing
 * Apply is agreeing to what will run, and a summary written by the thing
 * proposing it could differ from the call beside it — innocently, in a
 * paraphrase, or not innocently at all. So the model's prose sits above the
 * plan as commentary, and every line *in* the plan is rendered here out of the
 * parameters that will be sent.
 *
 * Validation happens here for the same reason. The arguments are checked
 * against the command's own Zod schema — the one the server will use — so a
 * line that cannot run is shown as one, in the panel, instead of failing in the
 * middle of a batch that has already applied three of its neighbours.
 */

/**
 * Why a set of arguments was refused, in one line.
 *
 * Zod's own multi-line rendering is for a terminal. This goes under a line in
 * a chat panel, and what a reader needs from it is which field and what was
 * wrong with it — enough to say the missing thing in their next message.
 */
function whyNot(issues: readonly { path: PropertyKey[]; message: string }[]): string {
  return issues
    .map((issue) => `${issue.path.join('.') || 'parameters'}: ${issue.message}`)
    .join('; ');
}

/** `translate` bound to the language in force, which is all this file needs. */
function t(key: MessageKey, params?: Params): string {
  return translate(language.value, key, params);
}

export interface Subject {
  taskTitles: ReadonlyMap<string, string>;
  blockTitles: ReadonlyMap<string, string>;
  activityTypeNames: ReadonlyMap<string, string>;
  weekNames: ReadonlyMap<string, string>;
  /**
   * Every availability window as it stands, so a replacement can be shown as
   * one. `SetAvailabilityWindows` replaces a whole set (§4.3), which means the
   * interesting half of any such plan is what is *missing* from it — and a plan
   * that listed only what would exist afterwards would hide exactly that.
   */
  availability: readonly AvailabilityWindow[];
  zone: string;
  locale: string;
}

export interface Proposal {
  call: AssistantCall;
  /** The command as it will be sent, or `null` when the arguments were wrong. */
  request: CommandRequest | null;
  /** One line, in the reader's language: what this will do. */
  headline: string;
  /** The parameters that matter, spelled out beneath it. */
  details: string[];
  /** Why this cannot run, when it cannot. */
  problem: string | null;
}

export function toProposal(call: AssistantCall, calendarId: string, subject: Subject): Proposal {
  const params = needsCalendarId(call.command) ? { ...call.params, calendarId } : call.params;
  const parsed = assistantParamsSchema(call.command).safeParse(params);

  if (!parsed.success) {
    return {
      call,
      request: null,
      // Still described, from what the model *meant* — a line reading "a
      // change that will not run" tells a reader nothing about whether to ask
      // again. `attempted` supplies every placeholder the sentence could want,
      // so a broken call cannot leave a raw `{title}` on screen.
      headline: t(`assistant.plan.${call.command}` as MessageKey, attempted(call.params, subject)),
      details: [],
      problem: whyNot(parsed.error.issues),
    };
  }

  // The union is discriminated on `type`, and the schema keyed by that type
  // produced these params — which the compiler cannot follow through a lookup.
  const request = { type: call.command, params: parsed.data } as CommandRequest;

  return {
    call,
    request,
    headline: headlineOf(request, subject),
    details: detailsOf(request, subject),
    problem: null,
  };
}

/** A title in quotes, or something honest when the id names nothing we hold. */
function named(id: string, from: ReadonlyMap<string, string>): string {
  const title = from.get(id);
  return title === undefined ? t('assistant.plan.unknown') : `“${title}”`;
}

/**
 * An instant, in the zone the reader's calendar is drawn in.
 *
 * Explicitly, rather than through `formatDateTime`, which formats in the
 * *browser's* zone. §13 lets somebody set a display zone that is not their
 * machine's — and a proposal is precisely where that must not be got wrong: a
 * plan line naming the wrong hour is a plan they approve for the wrong hour.
 */
function when(iso: string, subject: Subject): string {
  return new Intl.DateTimeFormat(subject.locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: subject.zone,
  }).format(new Date(iso));
}

/** Just the time, for the far end of a span whose day has already been said. */
function clock(iso: string, subject: Subject): string {
  return new Intl.DateTimeFormat(subject.locale, {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: subject.zone,
  }).format(new Date(iso));
}

/**
 * Every placeholder a headline might want, filled from a call that did not
 * validate.
 *
 * Only strings and numbers: the point is to say what was meant, and a nested
 * object rendered as `[object Object]` says less than nothing. The fallbacks
 * are what stop an unsubstituted `{when}` reaching the screen.
 */
function attempted(params: Record<string, unknown>, subject: Subject): Params {
  const supplied: Params = {};

  for (const [key, value] of Object.entries(params)) {
    if (typeof value === 'string' || typeof value === 'number') supplied[key] = value;
  }

  const unknown = t('assistant.plan.unknown');

  return {
    title: unknown,
    name: unknown,
    what: unknown,
    week: unknown,
    when: unknown,
    day: unknown,
    minutes: '?',
    a: unknown,
    b: unknown,
    ...supplied,
    ...(typeof params['start'] === 'string' ? { when: when(params['start'], subject) } : {}),
  };
}

/**
 * A `YYYY-MM-DD` written the way the reader writes dates.
 *
 * Read at midday UTC on purpose: a civil date has no instant, and any hour near
 * a boundary would land on the day before or after for somebody far enough east
 * or west. Midday is the one hour no timezone can move off the date.
 */
function day(date: string, subject: Subject): string {
  return new Intl.DateTimeFormat(subject.locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(new Date(`${date}T12:00:00Z`));
}

/**
 * The sentence at the top of a plan line.
 *
 * Every command gets its own, because the difference between them is exactly
 * what a person is being asked to approve: "put this off until tomorrow" and
 * "ask for this at 09:00 on Thursday" are both a task moving, and only one of
 * them counts as a deferral.
 */
function headlineOf(request: CommandRequest, subject: Subject): string {
  const p = request.params as Record<string, never>;

  switch (request.type) {
    case 'CreateTask':
      return t('assistant.plan.CreateTask', { title: request.params.title });
    case 'EditTask':
      return t('assistant.plan.EditTask', {
        what: named(request.params.taskId, subject.taskTitles),
      });
    case 'MoveTask':
      return t('assistant.plan.MoveTask', {
        what: named(request.params.taskId, subject.taskTitles),
        when: when(request.params.datetime, subject),
      });
    case 'ClearFloor':
      return t('assistant.plan.ClearFloor', {
        what: named(request.params.taskId, subject.taskTitles),
      });
    case 'DeferTask':
      return t(`assistant.plan.defer.${request.params.target}` as MessageKey, {
        what: named(request.params.taskId, subject.taskTitles),
      });
    case 'CompleteTask':
      return t('assistant.plan.CompleteTask', {
        what: named(request.params.taskId, subject.taskTitles),
      });
    case 'CancelTask':
      return t('assistant.plan.CancelTask', {
        what: named(request.params.taskId, subject.taskTitles),
      });
    case 'ExtendTask':
      return t('assistant.plan.ExtendTask', {
        what: named(request.params.taskId, subject.taskTitles),
        minutes: String(request.params.newEstimateMin),
      });
    case 'SwapTasks':
      return t('assistant.plan.SwapTasks', {
        a: named(request.params.taskAId, subject.taskTitles),
        b: named(request.params.taskBId, subject.taskTitles),
      });
    case 'SwapForward':
      return t('assistant.plan.SwapForward', {
        what: named(request.params.taskId, subject.taskTitles),
      });
    case 'MoveToBacklog':
      return t('assistant.plan.MoveToBacklog', {
        what: named(request.params.taskId, subject.taskTitles),
      });
    case 'PromoteFromBacklog':
      return t('assistant.plan.PromoteFromBacklog', {
        what: named(request.params.taskId, subject.taskTitles),
      });
    case 'AddAppointment':
      return t('assistant.plan.AddAppointment', {
        title: request.params.title,
        when: span(request.params.start, request.params.end, subject),
      });
    case 'AddUnavailability':
      return t('assistant.plan.AddUnavailability', {
        when: span(request.params.start, request.params.end, subject),
      });
    case 'EditAppointment':
      return request.params.patch.status === 'cancelled'
        ? t('assistant.plan.CancelAppointment', {
            what: named(request.params.appointmentId, subject.blockTitles),
          })
        : t('assistant.plan.EditAppointment', {
            what: named(request.params.appointmentId, subject.blockTitles),
          });
    case 'PostponeRestOfDay':
      return t('assistant.plan.PostponeRestOfDay', { day: day(request.params.date, subject) });
    case 'BlockOutDay':
      return t('assistant.plan.BlockOutDay', { day: day(request.params.date, subject) });
    case 'ClearWeek':
      return t('assistant.plan.ClearWeek', { day: day(request.params.week, subject) });
    case 'CreateActivityType':
      return t('assistant.plan.CreateActivityType', { name: request.params.name });
    case 'EditActivityType':
      return t('assistant.plan.EditActivityType', {
        what: named(request.params.activityTypeId, subject.activityTypeNames),
      });
    case 'DeleteActivityType':
      return t('assistant.plan.DeleteActivityType', {
        what: named(request.params.activityTypeId, subject.activityTypeNames),
      });
    case 'SetAvailabilityWindows':
      return request.params.weekTypeOverrideId === undefined
        ? t('assistant.plan.SetAvailabilityWindows', {
            what: named(request.params.activityTypeId, subject.activityTypeNames),
          })
        : t('assistant.plan.SetAvailabilityWindowsIn', {
            what: named(request.params.activityTypeId, subject.activityTypeNames),
            week: named(request.params.weekTypeOverrideId, subject.weekNames),
          });
    case 'CreateWeekTypeOverride':
      return t('assistant.plan.CreateWeekTypeOverride', { name: request.params.name });
    case 'EditWeekTypeOverride':
      return t('assistant.plan.EditWeekTypeOverride', {
        what: named(request.params.weekTypeOverrideId, subject.weekNames),
      });
    case 'DeleteWeekTypeOverride':
      return t('assistant.plan.DeleteWeekTypeOverride', {
        what: named(request.params.weekTypeOverrideId, subject.weekNames),
      });
    default:
      // Every assistant command is handled above; anything reaching here is a
      // command that gained an NL surface without gaining a sentence.
      return String(p['type'] ?? request.type);
  }
}

function span(start: string, end: string, subject: Subject): string {
  const sameDay = localDate(start, subject.zone).day === localDate(end, subject.zone).day;

  return sameDay
    ? `${when(start, subject)}–${clock(end, subject)}`
    : `${when(start, subject)} – ${when(end, subject)}`;
}

/**
 * The parameters worth spelling out under the headline.
 *
 * Generic rather than per-command prose: the headline carries the intent, and
 * this carries the facts, so a person can see that "45 minutes" is 45 and that
 * the due date is the Friday they meant. Ids are left out — they are noise to
 * a reader, and the titles are already in the sentence above.
 */
function detailsOf(request: CommandRequest, subject: Subject): string[] {
  // The one command that replaces rather than amends, shown as a replacement.
  if (request.type === 'SetAvailabilityWindows') return replacement(request.params, subject);

  const source: Record<string, unknown> =
    'patch' in request.params
      ? (request.params.patch as Record<string, unknown>)
      : (request.params as Record<string, unknown>);

  const details: string[] = [];

  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (SILENT.has(key)) continue;
    details.push(`${t(`assistant.field.${key}` as MessageKey)}: ${render(key, value, subject)}`);
  }

  return details;
}

/**
 * A replaced availability set, with the losses named.
 *
 * "Mon 09:00–17:00, Tue 09:00–17:00, Wed 09:00–17:00" is a perfectly accurate
 * description of a plan that has just deleted Thursday, and nobody reads it and
 * notices. So the removals are computed against what is there now and listed
 * separately — which is the difference between a plan a person approves and a
 * plan a person *checks*.
 */
function replacement(
  params: {
    activityTypeId: string;
    weekTypeOverrideId?: string | undefined;
    windows: readonly WindowRule[];
  },
  subject: Subject,
): string[] {
  const address = params.weekTypeOverrideId ?? null;
  const current = subject.availability.filter(
    (window) =>
      window.activityTypeId === params.activityTypeId &&
      (window.weekTypeOverrideId ?? null) === address,
  );

  const proposed = new Set(params.windows.map(key));
  const removed = current.filter((window) => !proposed.has(key(window)));

  const details = [
    `${t('assistant.field.windows')}: ${
      params.windows.length === 0
        ? t('assistant.field.noWindows')
        : [...params.windows]
            .sort(byWeekday)
            .map((window) => rule(window, subject))
            .join(', ')
    }`,
  ];

  if (removed.length > 0) {
    details.push(
      `${t('assistant.field.removed')}: ${[...removed]
        .sort(byWeekday)
        .map((window) => rule(window, subject))
        .join(', ')}`,
    );
  }

  return details;
}

/**
 * A window as either side writes one.
 *
 * `focusLevel` is optional-and-absent in a command and nullable-and-present in
 * a read model; they mean the same thing, and `key` folds both to the empty
 * string so a set is compared by what it says rather than by how it was typed.
 */
interface WindowRule {
  weekday: number;
  startMin: number;
  endMin: number;
  focusLevel?: number | null | undefined;
}

function key(window: WindowRule): string {
  return `${window.weekday}:${window.startMin}:${window.endMin}:${window.focusLevel ?? ''}`;
}

function byWeekday(a: WindowRule, b: WindowRule): number {
  return a.weekday - b.weekday || a.startMin - b.startMin;
}

function rule(window: WindowRule, subject: Subject): string {
  const name = weekdayNames(subject.locale, 'short')[window.weekday - 1] ?? window.weekday;
  const focus =
    window.focusLevel === null || window.focusLevel === undefined
      ? ''
      : ` (${t('assistant.field.focusLevel')} ${window.focusLevel})`;

  return `${name} ${formatMinuteOfDay(window.startMin)}–${formatMinuteOfDay(window.endMin)}${focus}`;
}

/** Ids, and the fields the headline has already said. */
const SILENT = new Set([
  'calendarId',
  'taskId',
  'taskAId',
  'taskBId',
  'appointmentId',
  'parentId',
  'sequenceId',
  'occurrenceStart',
  'date',
  'week',
  'target',
  'newEstimateMin',
  'datetime',
  'start',
  'end',
]);

function render(key: string, value: unknown, subject: Subject): string {
  if (value === null) return t('assistant.field.cleared');

  if (key === 'activityTypeId' && typeof value === 'string') {
    return subject.activityTypeNames.get(value) ?? value;
  }

  if (key === 'dueDate' && isRecord(value) && typeof value['date'] === 'string') {
    const kind = t(`assistant.field.${String(value['kind'])}` as MessageKey);
    return `${when(value['date'], subject)} (${kind})`;
  }

  if (key === 'interval' && isRecord(value)) {
    return span(String(value['start']), String(value['end']), subject);
  }

  if (key === 'preferredRange' && isRecord(value)) {
    return `${formatMinuteOfDay(Number(value['startMin']))}–${formatMinuteOfDay(Number(value['endMin']))}`;
  }

  if (key === 'recurrence' && isRecord(value)) {
    return 'rule' in value
      ? String(value['rule'])
      : t('assistant.field.perPeriod', {
          count: String(value['count']),
          period: t(`assistant.field.${String(value['period'])}` as MessageKey),
        });
  }

  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  return JSON.stringify(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

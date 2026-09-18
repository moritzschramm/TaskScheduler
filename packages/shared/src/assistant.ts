import { z } from 'zod';
import {
  addAppointmentParams,
  addUnavailabilityParams,
  blockOutDayParams,
  cancelTaskParams,
  clearFloorParams,
  clearWeekParams,
  completeTaskParams,
  createActivityTypeParams,
  createTaskParams,
  createWeekTypeOverrideParams,
  deferTaskParams,
  deleteActivityTypeParams,
  deleteWeekTypeOverrideParams,
  editAppointmentParams,
  editActivityTypeParams,
  editTaskParams,
  editWeekTypeOverrideParams,
  extendTaskParams,
  moveTaskParams,
  moveToBacklogParams,
  postponeRestOfDayParams,
  promoteFromBacklogParams,
  setAvailabilityWindowsParams,
  swapForwardParams,
  swapTasksParams,
  type CommandType,
} from './commands.js';

/**
 * The natural-language surface (spec §2.2, §3.2).
 *
 * §3.2 named this the fourth payoff of the command layer — "GUI actions and a
 * future NL parser both emit commands; nothing else can write" — and this file
 * is that parser's target, expressed so that a language model can aim at it.
 *
 * **The vocabulary is the command union, not a parallel one.** Every tool below
 * is a `CommandType` and its parameters are that command's own Zod schema,
 * turned into JSON Schema here rather than restated. A command gaining a field
 * gives the model that field; a command that stops accepting one stops being
 * offered it. The alternative — a hand-written tool list beside the commands —
 * is a second vocabulary that drifts, and the drift is silent, because the only
 * thing that notices is a model getting a rejection it cannot explain.
 *
 * **It is a subset, and the line is a screen.** Everything the Schedule, Tasks
 * and Activity types pages can do is here; nothing the Settings page can do is
 * (see `ASSISTANT_COMMANDS`). That line is not arbitrary. The first three are
 * the application — the week, the work, and the hours the work may happen in,
 * all of which somebody describes in sentences every day. Settings is the
 * planner itself and the person using it: which timezone their dates mean,
 * which calendars exist, what other people can see. Those change once and
 * change what every other screen *means*, so they are worth walking to.
 *
 * **Nothing here executes.** These are proposals. The client turns each call
 * into a command, shows a person what it would do in their own language, and
 * sends it only when they say so — see `packages/client/src/lib/assistant.ts`.
 */

export const ASSISTANT_PROVIDERS = ['anthropic', 'openai'] as const;
export type AssistantProvider = (typeof ASSISTANT_PROVIDERS)[number];

/**
 * What each provider is asked for when the user names no model.
 *
 * Overridable in settings, because an API key is an account with its own
 * entitlements: the key that cannot reach the default is not a broken key, and
 * a field beats a support question.
 */
export const DEFAULT_ASSISTANT_MODEL: Readonly<Record<AssistantProvider, string>> = {
  anthropic: 'claude-opus-5',
  openai: 'gpt-5',
};

/**
 * The commands the assistant may propose.
 *
 * Listed rather than derived from `COMMAND_TYPES` so that adding a command is
 * not the same act as exposing it. A new command arrives with no NL surface
 * until somebody decides it should have one, which is the right default for a
 * write vocabulary — and `assistant.test.ts` holds the list to the union, so a
 * renamed command is a compile error rather than a tool nobody can call.
 *
 * Four kinds are absent on purpose:
 *
 * - **The planner itself** (`CreateCalendar`, `ConfigureCalendar`,
 *   `SetCalendarWindows`) — the Settings page's own vocabulary.
 * - **`UpdateSettings`.** Timezone and locale change what every screen *means*;
 *   nothing a chat is asked for is worth that.
 * - **`Undo` / `Redo`.** Undo is the user's own gesture and sits in the header.
 *   A model that can undo can undo the thing you asked it to keep.
 * - **`MarkNotificationsRead`.** Dismissing a warning on someone's behalf.
 *
 * `SetAvailabilityWindows` is here and is the one that needed thinking about,
 * because it **replaces** a whole set rather than adding to it: a model that
 * forgets a Thursday deletes that Thursday. Three things make it safe enough to
 * offer. The snapshot carries every window of every set, so it is never working
 * from a partial picture; the plan draws the resulting week *and names what
 * would be removed*, so a missing Thursday is a red line a person reads; and
 * the whole thing is one undo away like everything else.
 */
export const ASSISTANT_COMMANDS = [
  'CreateTask',
  'EditTask',
  'MoveTask',
  'ClearFloor',
  'DeferTask',
  'CompleteTask',
  'CancelTask',
  'ExtendTask',
  'SwapTasks',
  'SwapForward',
  'MoveToBacklog',
  'PromoteFromBacklog',
  'AddAppointment',
  'EditAppointment',
  'AddUnavailability',
  'PostponeRestOfDay',
  'BlockOutDay',
  'ClearWeek',
  'CreateActivityType',
  'EditActivityType',
  'DeleteActivityType',
  'SetAvailabilityWindows',
  'CreateWeekTypeOverride',
  'EditWeekTypeOverride',
  'DeleteWeekTypeOverride',
] as const satisfies readonly CommandType[];

export type AssistantCommandType = (typeof ASSISTANT_COMMANDS)[number];

const IS_ASSISTANT_COMMAND = new Set<string>(ASSISTANT_COMMANDS);

export function isAssistantCommand(type: string): type is AssistantCommandType {
  return IS_ASSISTANT_COMMAND.has(type);
}

/**
 * Parameters the client supplies and the model never sees.
 *
 * `calendarId` is the big one, and it is a safety property rather than a
 * convenience: the assistant acts on the planner you are looking at because it
 * is given no way to name another one. The rest are fields with no natural
 * language behind them yet — sequence membership has no UI, and appointment
 * participants are modelled but not edited (§4.3).
 */
const WITHHELD: Readonly<Partial<Record<AssistantCommandType, readonly string[]>>> = {
  CreateTask: ['calendarId', 'sequenceId', 'sequencePosition'],
  AddAppointment: ['calendarId', 'isInternal'],
  AddUnavailability: ['calendarId'],
  PostponeRestOfDay: ['calendarId'],
  BlockOutDay: ['calendarId'],
  ClearWeek: ['calendarId'],
  SetAvailabilityWindows: ['calendarId'],
  CreateWeekTypeOverride: ['calendarId'],
};

/** True when the command's params carry a `calendarId` the client must fill in. */
export function needsCalendarId(type: AssistantCommandType): boolean {
  return WITHHELD[type]?.includes('calendarId') === true;
}

const PARAMS: Readonly<Record<AssistantCommandType, z.ZodObject>> = {
  CreateTask: createTaskParams,
  EditTask: editTaskParams,
  MoveTask: moveTaskParams,
  ClearFloor: clearFloorParams,
  DeferTask: deferTaskParams,
  CompleteTask: completeTaskParams,
  CancelTask: cancelTaskParams,
  ExtendTask: extendTaskParams,
  SwapTasks: swapTasksParams,
  SwapForward: swapForwardParams,
  MoveToBacklog: moveToBacklogParams,
  PromoteFromBacklog: promoteFromBacklogParams,
  AddAppointment: addAppointmentParams,
  EditAppointment: editAppointmentParams,
  AddUnavailability: addUnavailabilityParams,
  PostponeRestOfDay: postponeRestOfDayParams,
  BlockOutDay: blockOutDayParams,
  ClearWeek: clearWeekParams,
  CreateActivityType: createActivityTypeParams,
  EditActivityType: editActivityTypeParams,
  DeleteActivityType: deleteActivityTypeParams,
  SetAvailabilityWindows: setAvailabilityWindowsParams,
  CreateWeekTypeOverride: createWeekTypeOverrideParams,
  EditWeekTypeOverride: editWeekTypeOverrideParams,
  DeleteWeekTypeOverride: deleteWeekTypeOverrideParams,
};

/**
 * The schema a proposed call must satisfy — the command's own.
 *
 * Exported so the client can validate a model's arguments against exactly what
 * the server will validate them against, rather than against a description of
 * it. A plan that would be refused is better caught in the panel, where it can
 * be shown as a line that will not run, than at the end of a batch that has
 * already applied three commands.
 */
export function assistantParamsSchema(type: AssistantCommandType): z.ZodObject {
  return PARAMS[type];
}

/**
 * What each command is *for*, in the words a model needs.
 *
 * Not the doc comments from `commands.ts`. Those explain to a maintainer why a
 * command exists; these explain to a caller when to reach for it, which is a
 * different sentence — and the difference between `DeferTask` and `MoveTask`,
 * or `ExtendTask` and an `EditTask` patch, is exactly the kind of thing a
 * schema cannot say and a description can.
 */
const DESCRIPTIONS: Readonly<Record<AssistantCommandType, string>> = {
  CreateTask:
    'Add a new task. The scheduler decides when it happens, so do not ask for a time — ' +
    'use preferredRange (minutes after local midnight) to say when it would suit, and ' +
    'dueDate with kind "hard" only when missing the date is a real failure. ' +
    'estimatedDurationMin and activityTypeId are what make a task schedulable: a task with ' +
    'neither is never placed, so ask for a duration if the user did not give one. ' +
    'priority runs 1 to 5, 5 being the most important; focusLevel runs 1 (shallow) to 5 (deep). ' +
    'Use recurrence for standing demand ("three runs a week"), never for a fixed weekly meeting.',
  EditTask:
    "Change a task's properties. Every field in the patch has three states: leave it out " +
    'to keep the current value, send null to clear it back to what the parent task ' +
    'implies, or send a value to override. Use this for corrections; use ExtendTask when ' +
    'the estimate was simply too small.',
  MoveTask:
    'Ask for a placed task to happen at a given datetime. This is a preference plus a ' +
    'not-before floor, not a pin: the scheduler will not put the task earlier, but it may ' +
    'still choose a later slot if that one does not fit.',
  ClearFloor:
    'Forget an earlier MoveTask on this task, so the scheduler is free to place it ' +
    'wherever it fits again.',
  DeferTask:
    'Push a task out because the user does not want it now: to tomorrow, to next week, or ' +
    'all the way to the backlog. Counts as a deferral, which is what surfaces a task that ' +
    'keeps getting postponed — so prefer it to MoveTask when the user is putting something off.',
  CompleteTask:
    'Mark a task done. Pass actualEnd when the user says when they finished, so the rest ' +
    'of the day can move up.',
  CancelTask: 'Drop a task that will not be done. Not the same as completing it.',
  ExtendTask:
    "Revise a task's estimate upwards or downwards because it took longer or less time " +
    'than expected. newEstimateMin is the new total, not an increment.',
  SwapTasks: 'Exchange the times of two placed tasks.',
  SwapForward: 'Push one placed task behind whatever comes after it.',
  MoveToBacklog:
    'Take a task out of the scheduled two weeks and leave it in the backlog with an ' +
    'estimated week.',
  PromoteFromBacklog: 'Bring a backlog task into the scheduled two weeks.',
  AddAppointment:
    'Record something fixed in time that the user is committed to — a meeting, a dentist ' +
    'appointment, a class. Tasks are scheduled around it. start and end are instants with ' +
    'an offset. cooldownMin reserves minutes after it that nothing may use, for travel or ' +
    'recovery. Use recurrence (an RFC 5545 RRULE plus the timezone its times are read in) ' +
    'for something that repeats at a fixed time.',
  EditAppointment:
    'Change or cancel a fixed block. For one instance of a repeating block, pass scope ' +
    '"occurrence" and occurrenceStart; for the whole series, scope "series"; for this one ' +
    'and every later one, "this_and_future". Setting status to "cancelled" is how a ' +
    'meeting is called off — it stays in the record and stops blocking time.',
  AddUnavailability:
    'Block out a stretch of time with no content — the user is simply not available. A ' +
    'title is optional and only worth sending when it explains the absence.',
  PostponeRestOfDay:
    'The sick-day action, for one day: everything still to come that day moves to later ' +
    'days. Leaves fixed blocks where they are.',
  BlockOutDay:
    'Declare a whole day unavailable. Nothing is scheduled into it, and it stays that way ' +
    'until somebody takes the block away. Existing appointments are left alone and reported.',
  ClearWeek:
    'Declare a whole week unavailable — the holiday action. Any date inside the week will do.',
  CreateActivityType:
    'Add a kind of activity — work, exercise, errands. A new type has no hours until ' +
    'SetAvailabilityWindows gives it some, and until then nothing of that kind is ever ' +
    'scheduled, so offer to set them in the same breath. defaultCooldownMin is the gap ' +
    'reserved after every task of this kind unless the task overrides it.',
  EditActivityType: 'Rename an activity type, or change its colour or its default cooldown.',
  DeleteActivityType:
    'Remove an activity type. Refused while any task still belongs to it — move those ' +
    'first. Its hours go with it.',
  SetAvailabilityWindows:
    'Set when one activity type may be scheduled. **This replaces the whole set for that ' +
    'type**: send every window you want to keep, not just the ones you are adding, or the ' +
    'omitted ones are deleted. The current set for every type is in the schedule above — ' +
    "start from it. weekTypeOverrideId addresses a special week's replacement set; leave " +
    'it out for the ordinary week. An empty list is meaningful — it says this type is not ' +
    'available at all here, which during a holiday is exactly the point. Times are minutes ' +
    'after local midnight (540 = 09:00); focusLevel 1 (shallow) to 5 (deep) says what kind ' +
    'of work a window suits.',
  CreateWeekTypeOverride:
    'Declare a stretch of days that runs on different hours — a holiday, a conference ' +
    'week, parental leave. Dates are half-open: endDate is the first day back to normal. ' +
    'It **replaces** the ordinary hours for those dates, so a special week with no windows ' +
    'of its own is a stretch with no availability at all — which is what a holiday means, ' +
    'and is worth saying out loud if that is not what was wanted.',
  EditWeekTypeOverride: 'Rename a special week, or move its dates.',
  DeleteWeekTypeOverride:
    'Remove a special week, so its dates go back to the ordinary hours. The replacement ' +
    'hours set up for it are deleted with it.',
};

export interface AssistantTool {
  /** The command type, verbatim. */
  readonly name: AssistantCommandType;
  readonly description: string;
  /** JSON Schema (draft-07), derived from the command's own parameters. */
  readonly inputSchema: Record<string, unknown>;
}

/**
 * Strips what a tool schema does not need from what Zod generates.
 *
 * Two kinds of noise. `pattern` beside a `format` is the whole ISO-8601 grammar
 * as a regular expression — several hundred tokens per datetime field, of which
 * there are dozens — and `format: "date-time"` says the same thing to a model
 * in three words. The int64 bounds Zod attaches to every `z.int()` say only
 * that JavaScript numbers are finite.
 *
 * The parameters are re-validated against the real schema before anything is
 * proposed (`parseProposal`), so nothing here is load-bearing for correctness;
 * it is load-bearing for the context window.
 */
function simplify(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(simplify);
  if (typeof node !== 'object' || node === null) return node;

  const source = node as Record<string, unknown>;
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(source)) {
    if (key === '$schema') continue;
    if (key === 'pattern' && typeof source['format'] === 'string') continue;
    if (
      (key === 'maximum' || key === 'minimum') &&
      Math.abs(value as number) >= Number.MAX_SAFE_INTEGER
    ) {
      continue;
    }
    result[key] = simplify(value);
  }

  return result;
}

function schemaFor(type: AssistantCommandType): Record<string, unknown> {
  const json = simplify(
    z.toJSONSchema(PARAMS[type], { target: 'draft-7', io: 'input', unrepresentable: 'any' }),
  ) as { properties?: Record<string, unknown>; required?: string[] };

  const withheld = new Set(WITHHELD[type] ?? []);
  const properties = Object.fromEntries(
    Object.entries(json.properties ?? {}).filter(([name]) => !withheld.has(name)),
  );

  return {
    ...json,
    type: 'object',
    properties,
    required: (json.required ?? []).filter((name) => !withheld.has(name)),
  };
}

/** The vocabulary, built once — the tool list has to be byte-stable to cache. */
export const ASSISTANT_TOOLS: readonly AssistantTool[] = ASSISTANT_COMMANDS.map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  inputSchema: schemaFor(name),
}));

/**
 * One command the model wants run, before anybody has agreed to it.
 *
 * `id` is the provider's own call id and travels back on the result, which is
 * what keeps a transcript well-formed: both providers refuse a conversation in
 * which a tool call goes unanswered.
 */
export const assistantCallSchema = z.object({
  id: z.string().min(1),
  command: z.enum(ASSISTANT_COMMANDS),
  params: z.record(z.string(), z.unknown()),
});

export type AssistantCall = z.infer<typeof assistantCallSchema>;

/**
 * What became of one proposed command.
 *
 * `declined` is a first-class outcome rather than an error: a person refusing a
 * plan is the mechanism working, and the model is told so in those words rather
 * than being left to infer it from a silence.
 */
export const assistantCallResultSchema = z.object({
  id: z.string().min(1),
  status: z.enum(['applied', 'declined', 'failed', 'invalid']),
  detail: z.string(),
});

export type AssistantCallResult = z.infer<typeof assistantCallResultSchema>;

/**
 * The transcript, in terms neither provider owns.
 *
 * An `outcome` turn answers the calls in the `assistant` turn immediately
 * before it, and the client never sends one without the other. Anthropic
 * renders it as `tool_result` blocks in a user message; OpenAI as one `tool`
 * message per call.
 */
export const assistantTurnSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), text: z.string().min(1) }),
  z.object({
    role: z.literal('assistant'),
    text: z.string(),
    calls: z.array(assistantCallSchema),
  }),
  z.object({ role: z.literal('outcome'), results: z.array(assistantCallResultSchema).min(1) }),
]);

export type AssistantTurn = z.infer<typeof assistantTurnSchema>;

/**
 * How many commands one answer may propose.
 *
 * The cap is not really about cost. A plan a person cannot read is a plan they
 * approve without reading, and the whole safety story here is that somebody
 * looked. Twelve is about as long a list as fits in the panel at once; beyond
 * that the model is told to do the first part and come back.
 */
export const MAX_PROPOSALS_PER_TURN = 12;

/**
 * How many times one typed message may go round the model.
 *
 * Each round trip past the first costs a person a press of Apply, so this is a
 * belt over a brace. It exists for the case the braces cannot cover: a model
 * that answers every applied plan with another plan, forever.
 */
export const MAX_STEPS_PER_MESSAGE = 5;

/**
 * How long a conversation survives being ignored.
 *
 * Thirty minutes, and the reason is that stale context is worse here than no
 * context. The schedule this chat was reasoning about is a *week*, and the
 * assumptions in a half-finished exchange — which Thursday, whose dentist, what
 * "it" meant — go quietly wrong as that week is worked on elsewhere. Starting
 * clean after a break costs one sentence of re-typing; carrying on from an
 * hours-old premise costs a wrong command that looked right.
 */
export const ASSISTANT_IDLE_RESET_MS = 30 * 60 * 1000;

export const assistantRequestSchema = z.object({
  /** The conversation so far, oldest first, `outcome` turns included. */
  turns: z.array(assistantTurnSchema).min(1),
  /**
   * The schedule as the user is looking at it, rendered for reading.
   *
   * Context, never authority: every command it leads to is validated and
   * applied server-side under the caller's own row-level security, exactly as
   * if a button had been pressed. A snapshot claiming a task that is not
   * theirs buys nothing, because the command naming it still fails.
   */
  snapshot: z.string().max(200_000),
});

export type AssistantRequest = z.infer<typeof assistantRequestSchema>;

export const assistantReplySchema = z.object({
  text: z.string(),
  calls: z.array(assistantCallSchema),
  /**
   * Why the model stopped. `limit` means it ran out of room mid-answer —
   * distinct from `end`, because the text is then a fragment and saying so
   * beats presenting half a sentence as an answer.
   */
  stop: z.enum(['end', 'calls', 'limit', 'refusal']),
});

export type AssistantReply = z.infer<typeof assistantReplySchema>;

/** What the settings screen may know about a stored key: that there is one. */
export const assistantCredentialsSchema = z.object({
  provider: z.enum(ASSISTANT_PROVIDERS),
  model: z.string().min(1),
  /** The last four characters, so a person can tell two keys apart. */
  hint: z.string(),
});

export type AssistantCredentials = z.infer<typeof assistantCredentialsSchema>;

export const setAssistantCredentialsSchema = z.object({
  provider: z.enum(ASSISTANT_PROVIDERS),
  apiKey: z.string().min(8).max(500),
  /** Blank asks for the provider's default (`DEFAULT_ASSISTANT_MODEL`). */
  model: z.string().max(100).optional(),
});

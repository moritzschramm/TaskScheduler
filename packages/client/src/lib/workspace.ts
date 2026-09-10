import { computed, ref, watch, type ComputedRef, type Ref, type WritableComputedRef } from 'vue';
import {
  daysFromCivil,
  wallClockToInstant,
  type CivilDate,
  type ResolvedWindow,
  type ScheduleContext,
} from '@ambitime/scheduler';
import type {
  BacklogEntry,
  CalendarConfiguration,
  CalendarSummary,
  CapacityCell,
  Category,
  CommandRequest,
  CommandResult,
  FixedBlock,
  HistoryView,
  Notification,
  ScheduledBlock,
  TaskNode,
} from '@ambitime/shared';
import { ApiError } from './api';
import { now } from './clock';
import { fetchConfiguration, fetchContext, fetchHistory, runCommand } from './commands';
import { DEFAULT_SCALE, setScale, windowsForWeek } from './grid';
import { language, translate, type MessageKey } from '@/i18n';
import { monthOf, shiftMonth } from './month';
import { optimisticBlocks, schedulesAgree } from './optimistic';
import {
  fetchCalendars,
  fetchNotifications,
  fetchSchedule,
  fetchTasks,
  type ScheduleView,
} from './schedule';
import { displayFirstDayOfWeek, displayLocale, displayTimeZone } from './session';
import { addDays, localDate, toIso, weekDays } from './time';

/**
 * The one copy of the schedule the whole application looks at.
 *
 * Three screens draw the same week now — Schedule, Tasks and Appointments —
 * and they are three views of one answer rather than three answers. Held at
 * module scope for that reason: a per-component copy would mean three reads on
 * every navigation and, worse, three anchors, so paging to next week on one
 * screen would leave the others behind. What a user moved is the week, not the
 * week *on this tab*.
 *
 * The load is still explicit. Nothing here fetches on import; a view calls
 * `ensureLoaded` when it mounts, and the first caller wins.
 */

/**
 * What a side panel is showing. One editor at a time: a task and an appointment
 * are different enough that a merged form would be mostly conditionals, and two
 * open at once would leave "save" ambiguous.
 */
export type Editing =
  | { kind: 'none' }
  | {
      kind: 'task';
      task: TaskNode | null;
      parent: TaskNode | null;
      /**
       * The hour a new task was started from, when it was started by clicking
       * one (§7.3). Two separate things come of it: the form opens with that
       * time as the preferred range, and `submit` follows the create with a
       * `MoveTask` onto that day — see `pinToSlot`.
       */
      slot?: { day: CivilDate; startMin: number };
    }
  | { kind: 'block'; block: FixedBlock | null; defaultStart?: string };

const calendars = ref<CalendarSummary[]>([]);
const selectedId = ref<string | null>(null);
const view = ref<ScheduleView | null>(null);
const backlog = ref<BacklogEntry[]>([]);
const tasks = ref<TaskNode[]>([]);
const categories = ref<Category[]>([]);
/**
 * Held whole, not just its categories: the grid shades the hours the calendar
 * is open, and the rules for those live here rather than on the schedule.
 */
const configuration = ref<CalendarConfiguration | null>(null);
const history = ref<HistoryView | null>(null);
const notifications = ref<Notification[]>([]);
const capacity = ref<CapacityCell[]>([]);

/**
 * The solver's input, held so a gesture can be answered without asking.
 *
 * Refreshed with every read, so it is never more stale than the schedule drawn
 * beside it.
 */
const engineContext = ref<ScheduleContext | null>(null);

/**
 * Set when a prediction turned out to be wrong (plan M12: "accept the server
 * result on the rare mismatch").
 *
 * Shown rather than swallowed. The server's answer has already replaced what
 * was drawn, so nothing is broken — but a user who saw the schedule settle and
 * then move deserves to be told that is what happened, and a mismatch that
 * happens often is a bug worth someone noticing.
 */
const diverged = ref(false);
const error = ref<string | null>(null);
const loading = ref(true);
const editing = ref<Editing>({ kind: 'none' });

/** The Monday (or configured first day) of the week being shown. */
const anchor = ref<CivilDate | null>(null);

/**
 * The slice of the day the grid draws.
 *
 * A preference about looking, not about scheduling — nothing outside it is
 * hidden from the engine, and a block that falls outside is still placed. Held
 * here rather than in a component so it survives moving between Schedule and
 * Appointments.
 *
 * **Stored in this browser, not on the server.** §13's user settings are the
 * ones that change what the schedule *means* — zone, locale, first day — and
 * they travel with the account because a wrong one gives a wrong answer
 * everywhere. This changes how much of the answer fits on a screen, which is a
 * fact about the screen: the laptop and the phone should not have to agree, and
 * neither should be a command in the log for the other to undo.
 */
const DAY_RANGE_KEY = 'ambitime.dayRange';

const DEFAULT_DAY_RANGE = { startMin: 6 * 60, endMin: 22 * 60 } as const;

/** Reads the stored range, ignoring anything that is not one. */
export function readStoredRange(): { startMin: number; endMin: number } {
  try {
    const raw = globalThis.localStorage?.getItem(DAY_RANGE_KEY);
    if (raw === null || raw === undefined) return DEFAULT_DAY_RANGE;

    const parsed = JSON.parse(raw) as { startMin?: unknown; endMin?: unknown };
    const startMin = Number(parsed.startMin);
    const endMin = Number(parsed.endMin);

    // A stored value is data from outside, and one that had drifted or been
    // hand-edited would give the grid a negative height rather than an odd
    // view. The same bounds the setter enforces, applied on the way in.
    if (!Number.isFinite(startMin) || !Number.isFinite(endMin)) return DEFAULT_DAY_RANGE;
    if (startMin < 0 || endMin > 24 * 60 || endMin - startMin < 60) return DEFAULT_DAY_RANGE;

    return { startMin, endMin };
  } catch {
    // Private browsing, a disabled store, or malformed JSON. The default view
    // is a fine answer to all three and none of them is worth a message.
    return DEFAULT_DAY_RANGE;
  }
}

const initialRange = readStoredRange();
const dayStartMin = ref(initialRange.startMin);
const dayEndMin = ref(initialRange.endMin);

/** Keeps the pair ordered and at least an hour apart, whichever end moved. */
function setDayRange(startMin: number, endMin: number): void {
  const start = Math.min(Math.max(startMin, 0), 23 * 60);
  const end = Math.min(Math.max(endMin, start + 60), 24 * 60);
  dayStartMin.value = Math.min(start, end - 60);
  dayEndMin.value = end;

  try {
    globalThis.localStorage?.setItem(
      DAY_RANGE_KEY,
      JSON.stringify({ startMin: dayStartMin.value, endMin: dayEndMin.value }),
    );
  } catch {
    // Nothing to do and nothing to say: the range still applies to this
    // session, it simply will not outlive it.
  }
}

/**
 * Which shape the calendar is drawn in.
 *
 * A preference about looking rather than about scheduling, so it lives beside
 * the day range and in the same place — this browser. The two views share one
 * anchor, which is what makes clicking a day in the month land on that week
 * rather than on wherever the week view was left.
 */
const MODE_KEY = 'ambitime.calendarMode';

export type CalendarMode = 'week' | 'month';

export function readStoredMode(): CalendarMode {
  try {
    return globalThis.localStorage?.getItem(MODE_KEY) === 'month' ? 'month' : 'week';
  } catch {
    return 'week';
  }
}

const mode = ref<CalendarMode>(readStoredMode());

function setMode(next: CalendarMode): void {
  mode.value = next;
  try {
    globalThis.localStorage?.setItem(MODE_KEY, next);
  } catch {
    // Same as the day range: it applies to this session either way.
  }
}

/**
 * How tall an hour is drawn, in pixels per minute.
 *
 * A preference about looking, like the day range and the calendar mode, and
 * stored in the same place for the same reason. Held as a ref *and* pushed into
 * `lib/grid`, because the drag arithmetic there is not reactive and must agree
 * with what is on screen — a drop landing on a different hour from the one it
 * looked like is the bug this pairing exists to prevent.
 */
const ROW_HEIGHT_KEY = 'ambitime.rowHeight';

export function readStoredScale(): number {
  try {
    const raw = Number(globalThis.localStorage?.getItem(ROW_HEIGHT_KEY));
    return Number.isFinite(raw) && raw > 0 ? setScale(raw) : DEFAULT_SCALE;
  } catch {
    return DEFAULT_SCALE;
  }
}

const rowScale = ref(readStoredScale());

function setRowScale(next: number): void {
  rowScale.value = setScale(next);
  try {
    globalThis.localStorage?.setItem(ROW_HEIGHT_KEY, String(rowScale.value));
  } catch {
    // Same as the day range: it applies to this session either way.
  }
}

/**
 * Which weekdays the grid draws, as ISO numbers (1 = Monday).
 *
 * A preference about looking, like the day range and the row height — and the
 * one that answers "I do not work weekends and do not want to look at them".
 * Hiding a day does **not** hide it from the scheduler: it is still in the
 * horizon and things are still placed on it, which is why the notice about
 * work scheduled outside the week is worth having. Nothing here is a rule; it
 * is a crop.
 *
 * Never empty. A grid with no columns is not a smaller calendar, it is a
 * broken one, so the last day cannot be turned off.
 */
const WEEKDAYS_KEY = 'ambitime.weekdays';

const ALL_WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;

export function readStoredWeekdays(): number[] {
  try {
    const raw = globalThis.localStorage?.getItem(WEEKDAYS_KEY);
    if (raw === null || raw === undefined) return [...ALL_WEEKDAYS];

    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [...ALL_WEEKDAYS];

    const days = ALL_WEEKDAYS.filter((day) => parsed.includes(day));
    return days.length === 0 ? [...ALL_WEEKDAYS] : [...days];
  } catch {
    return [...ALL_WEEKDAYS];
  }
}

const visibleWeekdays = ref<number[]>(readStoredWeekdays());

function setVisibleWeekdays(next: readonly number[]): void {
  const days = ALL_WEEKDAYS.filter((day) => next.includes(day));
  if (days.length === 0) return;

  visibleWeekdays.value = [...days];
  try {
    globalThis.localStorage?.setItem(WEEKDAYS_KEY, JSON.stringify(visibleWeekdays.value));
  } catch {
    // Same as the other view preferences: it applies to this session either way.
  }
}

let started = false;

/** Only ever reached before the first read, when nothing is drawn anyway. */
const EPOCH_MONTH: CivilDate = { year: 1970, month: 1, day: 1 };

const calendar = computed(() => calendars.value.find((entry) => entry.id === selectedId.value));

const locale = computed(() => displayLocale());
const firstDayOfWeek = computed(() => displayFirstDayOfWeek());

/**
 * The zone the grid is drawn in (§13, §5.1).
 *
 * The user's setting when they have made one, and the calendar's own zone when
 * they have not — which is exactly what every screen did before the setting
 * existed, so nobody's view changes until they ask for it to.
 */
const zone = computed(() => displayTimeZone(calendar.value?.timezone ?? 'UTC'));

/** The seven days of the week in view, whether or not they are all drawn. */
const weekOf = computed<CivilDate[]>(() =>
  anchor.value === null ? [] : weekDays(anchor.value, firstDayOfWeek.value),
);

/**
 * The days the grid actually draws.
 *
 * Filtered here rather than in the grid so that everything derived from the
 * week — the shading, the lanes, the "scheduled outside this week" notice —
 * agrees about which days are on screen.
 */
const days = computed<CivilDate[]>(() =>
  weekOf.value.filter((day) => visibleWeekdays.value.includes(isoWeekday(day))),
);

/** ISO weekday for a civil date: 1 = Monday … 7 = Sunday. */
function isoWeekday(date: CivilDate): number {
  // 1970-01-01 was a Thursday, which is ISO weekday 4.
  return ((((daysFromCivil(date) + 3) % 7) + 7) % 7) + 1;
}

const today = computed<CivilDate | null>(() =>
  calendar.value ? localDate(now().toISOString(), zone.value) : null,
);

/** The month the anchor falls in — the month view's subject. */
const month = computed<CivilDate>(() => monthOf(anchor.value ?? today.value ?? EPOCH_MONTH));

/**
 * The last day anything can be scheduled on (spec §6.1).
 *
 * Read from the engine's own horizon rather than computed from a constant, so
 * the month grid marks the same boundary the solver used. Null until the first
 * read, when a grid that claimed everything was past the horizon would be
 * alarming and wrong.
 */
const horizonEnd = computed<CivilDate | null>(() => {
  const context = engineContext.value;
  if (context === null) return null;
  // The horizon is half-open, so its end instant belongs to the day after the
  // last schedulable one — a minute back lands inside that last day.
  return localDate(new Date((context.horizon.end - 1) * 60_000).toISOString(), zone.value);
});

/** The hours the calendar is open across the seven days being drawn (§4.3). */
const openWindows = computed<ResolvedWindow[]>(() =>
  configuration.value === null || calendar.value === undefined
    ? []
    : windowsForWeek(days.value, zone.value, calendar.value.id, configuration.value),
);

/**
 * §6.7's reasons for a task the solver was never offered, in words. A missing
 * window is a fact about the calendar and is fixed once in settings; a missing
 * category or estimate is a fact about one task and is fixed in its editor.
 */
const REASONS: Record<string, MessageKey> = {
  no_category: 'schedule.reason.noCategory',
  no_duration: 'schedule.reason.noDuration',
};

function reasonTextOf(reason: string): string {
  const key = REASONS[reason];
  return key === undefined ? reason : translate(language.value, key);
}

const unschedulable = computed(() =>
  (view.value?.schedule.unschedulable ?? []).map((entry) => ({
    ...entry,
    title: tasks.value.find((task) => task.id === entry.taskId)?.title ?? 'Untitled task',
    // Translated as the computed re-evaluates, so switching language
    // re-words the notice rather than leaving the last language in it.
    reasonText: reasonTextOf(entry.reason),
  })),
);

/**
 * True when the engine resolves no window at all across the week on screen.
 *
 * Read from what the engine returns rather than counted from the categories,
 * because those are not the same question: a calendar can have categories whose
 * windows are all empty, or a working window that clips every one of them away,
 * or a week-type override that closes the week — and in all three the answer to
 * "can anything be scheduled here" is still no.
 */
const noWindows = computed(() => configuration.value !== null && openWindows.value.length === 0);

/**
 * Placements the engine made outside the week on screen (spec §6.1).
 *
 * **This is the one that made "nothing is showing" so hard to believe.** The
 * horizon runs two weeks and the view opens on today's, so a calendar whose
 * only availability is a Monday that has already passed schedules everything
 * into *next* Monday — correctly, invisibly, on a grid nobody is looking at.
 * Counting them costs a filter over an array that is already in memory, and it
 * is the difference between a broken app and one that needs the Next button.
 */
const scheduledElsewhere = computed<ScheduledBlock[]>(() => {
  const week = days.value;
  const first = week[0];
  const last = week.at(-1);
  if (first === undefined || last === undefined) return [];

  const start = wallClockToInstant(first, 0, zone.value);
  const end = wallClockToInstant(addDays(last, 1), 0, zone.value);

  return (view.value?.schedule.blocks ?? []).filter((block) => {
    const at = Date.parse(block.start) / 60_000;
    return at < start || at >= end;
  });
});

/**
 * The task editor's open state, as a modal wants it.
 *
 * Derived from `editing` rather than kept beside it: two sources for "is the
 * editor open" is how a dialog ends up dismissed with the form still mounted
 * behind it, or the other way round.
 */
const taskDialogOpen = computed({
  get: () => editing.value.kind === 'task',
  set: (open: boolean) => {
    if (!open) editing.value = { kind: 'none' };
  },
});

const blockDialogOpen = computed({
  get: () => editing.value.kind === 'block',
  set: (open: boolean) => {
    if (!open) editing.value = { kind: 'none' };
  },
});

/** The local date a block outside this week was placed on. */
export function dayOf(block: ScheduledBlock): CivilDate {
  return localDate(block.start, zone.value);
}

function parentOf(task: TaskNode): TaskNode | null {
  return task.parentId === null
    ? null
    : (tasks.value.find((candidate) => candidate.id === task.parentId) ?? null);
}

function reseatEditor(): void {
  const open = editing.value;

  if (open.kind === 'task' && open.task !== null) {
    const fresh = tasks.value.find((task) => task.id === open.task!.id) ?? null;
    // Gone means cancelled or deleted from under us; there is nothing left to
    // edit and pretending otherwise would offer a save that cannot land.
    editing.value =
      fresh === null ? { kind: 'none' } : { kind: 'task', task: fresh, parent: parentOf(fresh) };
    return;
  }

  if (open.kind === 'block' && open.block !== null) {
    const fresh =
      view.value?.fixedBlocks.find((block) => block.appointmentId === open.block!.appointmentId) ??
      null;
    editing.value = fresh === null ? { kind: 'none' } : { kind: 'block', block: fresh };
  }
}

async function load({ silent = false } = {}): Promise<void> {
  // **Only a first read is a "loading" state.** Every command re-reads, and
  // raising this flag for that inserted `WorkspaceStatus`'s loading line above
  // the grid for the length of the round trip — which pushed the whole calendar
  // down 44 pixels and back. Dropping a task looked like the view jumping,
  // and the jump was a paragraph appearing, not anything on the grid moving.
  //
  // There is already a correct screen up during a re-read. Saying "loading"
  // over it is both untrue and the thing that moves it.
  loading.value = !silent && view.value === null;
  error.value = null;

  try {
    calendars.value = await fetchCalendars();
    selectedId.value ??= calendars.value[0]?.id ?? null;

    const id = selectedId.value;
    if (id === null) return;

    // Six requests, one solve. The backlog and the capacity reading are both
    // products of the schedule's own solve, and asking for them separately made
    // a single screen cost three — three loads of the same calendar, three
    // greedy passes over the same fortnight, and three writes of the same
    // placement cache, for two arrays the first answer already contained.
    const [schedule, taskList, config, log, context, signals] = await Promise.all([
      fetchSchedule(id),
      fetchTasks(id),
      fetchConfiguration(id),
      fetchHistory(),
      fetchContext(id),
      fetchNotifications(),
    ]);

    configuration.value = config;
    categories.value = config.categories;
    history.value = log;
    engineContext.value = context;
    notifications.value = signals;

    view.value = schedule;
    backlog.value = schedule.schedule.backlog;
    capacity.value = schedule.capacity;
    tasks.value = taskList;

    // Re-point the open editor at the freshly read row rather than closing it:
    // after a save the version has moved, and an editor still holding the old
    // one would have its next save refused (§5.4).
    reseatEditor();

    // Anchor on the calendar's own today, not the browser's: a Berlin calendar
    // opens on the Berlin week even for a viewer in Lisbon (§13).
    anchor.value ??= today.value;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not load the schedule';
  } finally {
    loading.value = false;
  }
}

/** Solves the command locally and draws it, returning what it drew. */
function predict(request: CommandRequest): ScheduledBlock[] | null {
  const context = engineContext.value;
  const current = view.value;
  if (context === null || current === null) return null;

  const titles = new Map(tasks.value.map((task) => [task.id, task]));
  const blocks = optimisticBlocks(context, request, (occurrenceId) => {
    const schedulable = context.schedulables.find((s) => s.occurrenceId === occurrenceId);
    const task = schedulable === undefined ? undefined : titles.get(schedulable.taskId);
    return {
      taskId: schedulable?.taskId ?? occurrenceId,
      title: task?.title ?? '…',
      categoryId: schedulable?.categoryId ?? null,
    };
  });

  if (blocks === null) return null;

  view.value = { ...current, schedule: { ...current.schedule, blocks } };
  diverged.value = false;
  return blocks;
}

/** The hour a new task was started from, if it was started from one. */
function pendingSlot(): { day: CivilDate; startMin: number } | null {
  const open = editing.value;
  return open.kind === 'task' && open.task === null ? (open.slot ?? null) : null;
}

/**
 * Puts a task created from a slot on the day it was created from (spec §7.3).
 *
 * **A preferred range cannot say this.** §4.4's range is minutes of a day with
 * no date in it, deliberately: a task is flexible about *which* Thursday, and
 * that flexibility is most of what the scheduler is for. So "at this hour, on
 * this day" is the same statement a drag makes, and it is made the same way —
 * `MoveTask`, which sets a soft not-before floor and a bias for the datetime
 * (§7.3). Soft, so the task can still move if the day fills up; a hard pin
 * would be a different promise, and one nobody made by clicking a Tuesday.
 *
 * Sent as a second command rather than folded into `CreateTask`, because they
 * are two different facts about the task and the log is read by people. The
 * shared `groupId` is what makes them one thing to undo.
 */
async function pinToSlot(
  result: CommandResult,
  slot: { day: CivilDate; startMin: number },
  groupId: string,
): Promise<void> {
  const taskId = result.created.find((entity) => entity.entity === 'task')?.id;
  if (taskId === undefined) return;

  await runCommand({
    type: 'MoveTask',
    groupId,
    params: {
      taskId,
      datetime: toIso(wallClockToInstant(slot.day, slot.startMin, zone.value)),
    },
  });
}

/**
 * Draw the answer, then ask for it (plan M12).
 *
 * The same engine the server runs is imported here, so the effect of a gesture
 * can be shown at once rather than after a round trip. The command still goes
 * to the server, the server still re-derives, and its answer still replaces
 * this one — the prediction is a prediction, not a decision.
 *
 * A command with no projection simply skips the preview and waits, which is the
 * right answer for anything whose effect depends on state the client does not
 * hold. Guessing wrong would be worse than waiting: the user would watch the
 * schedule move twice.
 */
async function submit(request: CommandRequest): Promise<boolean> {
  error.value = null;
  const predicted = predict(request);

  // A create started from an hour becomes two commands, tied into one unit of
  // history so undo takes back the whole gesture (§7.5).
  const slot = request.type === 'CreateTask' ? pendingSlot() : null;
  const sent = slot === null ? request : { ...request, groupId: crypto.randomUUID() };

  try {
    const result = await runCommand(sent);
    if (slot !== null) await pinToSlot(result, slot, sent.groupId!);
    await load({ silent: true });

    // Accept the server's result, and say so if it differed from what was
    // already on screen.
    diverged.value =
      predicted !== null && !schedulesAgree(predicted, view.value?.schedule.blocks ?? []);
    return true;
  } catch (cause) {
    // A refused command means the preview was never real. Put back what the
    // server last told us rather than leaving a schedule nobody agreed to —
    // silently, for the same reason: there is a screen up, and the error
    // message below is what should be drawing the eye, not a moving grid.
    if (predicted !== null) await load({ silent: true });

    error.value =
      cause instanceof ApiError
        ? cause.message
        : cause instanceof Error
          ? cause.message
          : 'That change could not be applied';
    return false;
  }
}

function shiftWeek(weeks: number): void {
  if (anchor.value !== null) anchor.value = addDays(anchor.value, weeks * 7);
}

/**
 * Moves the anchor a whole month, landing on the first of it.
 *
 * Both views move the one anchor, so paging months and then switching to the
 * week opens the first week of the month you paged to — rather than the week
 * you had been looking at before, which is somewhere else entirely by then.
 */
function shiftMonths(months: number): void {
  if (anchor.value !== null) anchor.value = shiftMonth(monthOf(anchor.value), months);
}

/** Jumps the week to the one containing `date` — used to follow a placement. */
function showWeekOf(date: CivilDate): void {
  anchor.value = weekDays(date, firstDayOfWeek.value)[0] ?? date;
}

function openTask(taskId: string): void {
  const task = tasks.value.find((candidate) => candidate.id === taskId);
  if (task !== undefined) editing.value = { kind: 'task', task, parent: parentOf(task) };
}

/**
 * A new task, started from an hour on the grid (§7.3, §4.4).
 *
 * The slot travels with the editor rather than being turned into command
 * parameters here, because a task is not created until somebody fills the form
 * in — and what they type may make the hour irrelevant.
 */
function newTaskAt(day: CivilDate, startMin: number): void {
  editing.value = { kind: 'task', task: null, parent: null, slot: { day, startMin } };
}

function newBlockAt(day: CivilDate, minuteOfDay = 9 * 60): void {
  editing.value = {
    kind: 'block',
    block: null,
    defaultStart: toIso(wallClockToInstant(day, minuteOfDay, zone.value)),
  };
}

/** Loads once per session; later callers join the copy already on screen. */
async function ensureLoaded(): Promise<void> {
  if (started) return;
  started = true;
  await load();
}

let watching = false;

export interface Workspace {
  calendars: Ref<CalendarSummary[]>;
  selectedId: Ref<string | null>;
  view: Ref<ScheduleView | null>;
  backlog: Ref<BacklogEntry[]>;
  tasks: Ref<TaskNode[]>;
  categories: Ref<Category[]>;
  configuration: Ref<CalendarConfiguration | null>;
  history: Ref<HistoryView | null>;
  notifications: Ref<Notification[]>;
  capacity: Ref<CapacityCell[]>;
  diverged: Ref<boolean>;
  error: Ref<string | null>;
  loading: Ref<boolean>;
  editing: Ref<Editing>;
  taskDialogOpen: WritableComputedRef<boolean>;
  blockDialogOpen: WritableComputedRef<boolean>;
  anchor: Ref<CivilDate | null>;
  visibleWeekdays: Ref<number[]>;
  setVisibleWeekdays: (next: readonly number[]) => void;
  mode: Ref<CalendarMode>;
  setMode: (next: CalendarMode) => void;
  rowScale: Ref<number>;
  setRowScale: (next: number) => void;
  dayStartMin: Ref<number>;
  dayEndMin: Ref<number>;
  setDayRange: (startMin: number, endMin: number) => void;
  calendar: ComputedRef<CalendarSummary | undefined>;
  locale: ComputedRef<string>;
  zone: ComputedRef<string>;
  days: ComputedRef<CivilDate[]>;
  today: ComputedRef<CivilDate | null>;
  month: ComputedRef<CivilDate>;
  firstDayOfWeek: ComputedRef<number>;
  horizonEnd: ComputedRef<CivilDate | null>;
  openWindows: ComputedRef<ResolvedWindow[]>;
  unschedulable: ComputedRef<
    { taskId: string; occurrenceId: string; title: string; reasonText: string }[]
  >;
  noWindows: ComputedRef<boolean>;
  scheduledElsewhere: ComputedRef<ScheduledBlock[]>;
  ensureLoaded: () => Promise<void>;
  load: () => Promise<void>;
  submit: (request: CommandRequest) => Promise<boolean>;
  shiftWeek: (weeks: number) => void;
  shiftMonths: (months: number) => void;
  showWeekOf: (date: CivilDate) => void;
  parentOf: (task: TaskNode) => TaskNode | null;
  openTask: (taskId: string) => void;
  newTaskAt: (day: CivilDate, startMin: number) => void;
  newBlockAt: (day: CivilDate, minuteOfDay?: number) => void;
}

export function useWorkspace(): Workspace {
  // Switching calendars is a different world, not a different filter, so the
  // whole read is redone. Registered once however many views ask for it.
  if (!watching) {
    watching = true;
    watch(selectedId, () => {
      if (started) void load();
    });
  }

  return {
    calendars,
    selectedId,
    view,
    backlog,
    tasks,
    categories,
    configuration,
    history,
    notifications,
    capacity,
    diverged,
    error,
    loading,
    editing,
    taskDialogOpen,
    blockDialogOpen,
    anchor,
    visibleWeekdays,
    setVisibleWeekdays,
    mode,
    setMode,
    rowScale,
    setRowScale,
    dayStartMin,
    dayEndMin,
    setDayRange,
    calendar,
    locale,
    zone,
    days,
    today,
    month,
    firstDayOfWeek,
    horizonEnd,
    openWindows,
    unschedulable,
    noWindows,
    scheduledElsewhere,
    ensureLoaded,
    load,
    submit,
    shiftWeek,
    shiftMonths,
    showWeekOf,
    parentOf,
    openTask,
    newTaskAt,
    newBlockAt,
  };
}

/**
 * Marks the shared read stale without clearing it.
 *
 * What is on screen stays on screen — it was true a moment ago and blanking it
 * would be a worse lie than showing it — but the next view to mount re-reads.
 */
export function invalidateWorkspace(): void {
  started = false;
}

/** Drops everything, so a second sign-in does not inherit the first's data. */
export function resetWorkspace(): void {
  started = false;
  calendars.value = [];
  selectedId.value = null;
  view.value = null;
  backlog.value = [];
  tasks.value = [];
  categories.value = [];
  configuration.value = null;
  history.value = null;
  notifications.value = [];
  capacity.value = [];
  engineContext.value = null;
  diverged.value = false;
  error.value = null;
  loading.value = true;
  editing.value = { kind: 'none' };
  anchor.value = null;
  // The day range is deliberately left alone. It belongs to this browser and
  // this screen, not to whoever is signed in — and re-cropping the grid on
  // every sign-out would be a small mystery with no visible cause.
}

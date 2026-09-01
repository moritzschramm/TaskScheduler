import { computed, ref, watch, type ComputedRef, type Ref } from 'vue';
import {
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
  FixedBlock,
  HistoryView,
  Notification,
  ScheduledBlock,
  TaskNode,
} from '@ambitime/shared';
import { ApiError } from './api';
import { now } from './clock';
import { fetchConfiguration, fetchContext, fetchHistory, runCommand } from './commands';
import { windowsForWeek } from './grid';
import { optimisticBlocks, schedulesAgree } from './optimistic';
import {
  fetchBacklog,
  fetchCalendars,
  fetchCapacity,
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
  | { kind: 'task'; task: TaskNode | null; parent: TaskNode | null }
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

let started = false;

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

const days = computed<CivilDate[]>(() =>
  anchor.value === null ? [] : weekDays(anchor.value, firstDayOfWeek.value),
);

const today = computed<CivilDate | null>(() =>
  calendar.value ? localDate(now().toISOString(), zone.value) : null,
);

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
const REASONS: Record<string, string> = {
  no_category: 'needs a category before a window can apply to it',
  no_duration: 'needs an estimate before there is anything to fit',
};

const unschedulable = computed(() =>
  (view.value?.schedule.unschedulable ?? []).map((entry) => ({
    ...entry,
    title: tasks.value.find((task) => task.id === entry.taskId)?.title ?? 'Untitled task',
    reasonText: REASONS[entry.reason] ?? entry.reason,
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

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    calendars.value = await fetchCalendars();
    selectedId.value ??= calendars.value[0]?.id ?? null;

    const id = selectedId.value;
    if (id === null) return;

    const [schedule, entries, taskList, config, log, context, signals, cells] = await Promise.all([
      fetchSchedule(id),
      fetchBacklog(id),
      fetchTasks(id),
      fetchConfiguration(id),
      fetchHistory(),
      fetchContext(id),
      fetchNotifications(),
      fetchCapacity(id),
    ]);

    configuration.value = config;
    categories.value = config.categories;
    history.value = log;
    engineContext.value = context;
    notifications.value = signals;
    capacity.value = cells;

    view.value = schedule;
    backlog.value = entries;
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

  try {
    await runCommand(request);
    await load();

    // Accept the server's result, and say so if it differed from what was
    // already on screen.
    diverged.value =
      predicted !== null && !schedulesAgree(predicted, view.value?.schedule.blocks ?? []);
    return true;
  } catch (cause) {
    // A refused command means the preview was never real. Put back what the
    // server last told us rather than leaving a schedule nobody agreed to.
    if (predicted !== null) await load();

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

/** Jumps the week to the one containing `date` — used to follow a placement. */
function showWeekOf(date: CivilDate): void {
  anchor.value = weekDays(date, firstDayOfWeek.value)[0] ?? date;
}

function openTask(taskId: string): void {
  const task = tasks.value.find((candidate) => candidate.id === taskId);
  if (task !== undefined) editing.value = { kind: 'task', task, parent: parentOf(task) };
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
  anchor: Ref<CivilDate | null>;
  calendar: ComputedRef<CalendarSummary | undefined>;
  locale: ComputedRef<string>;
  zone: ComputedRef<string>;
  days: ComputedRef<CivilDate[]>;
  today: ComputedRef<CivilDate | null>;
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
  showWeekOf: (date: CivilDate) => void;
  parentOf: (task: TaskNode) => TaskNode | null;
  openTask: (taskId: string) => void;
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
    anchor,
    calendar,
    locale,
    zone,
    days,
    today,
    openWindows,
    unschedulable,
    noWindows,
    scheduledElsewhere,
    ensureLoaded,
    load,
    submit,
    shiftWeek,
    showWeekOf,
    parentOf,
    openTask,
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
}

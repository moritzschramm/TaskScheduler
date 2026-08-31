<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { BacklogEntry, CalendarSummary, TaskNode } from '@ambitime/shared';
import { wallClockToInstant, type ScheduleContext } from '@ambitime/scheduler';
import type { CivilDate } from '@ambitime/scheduler';
import NotificationCentre from '@/components/NotificationCentre.vue';
import UndoRedo from '@/components/UndoRedo.vue';
import AppointmentEditor from '@/components/calendar/AppointmentEditor.vue';
import WeekGrid from '@/components/calendar/WeekGrid.vue';
import BacklogPanel from '@/components/panels/BacklogPanel.vue';
import CapacityPanel from '@/components/panels/CapacityPanel.vue';
import TaskListPanel from '@/components/panels/TaskListPanel.vue';
import TaskActions from '@/components/tasks/TaskActions.vue';
import TaskEditor from '@/components/tasks/TaskEditor.vue';
import { Button } from '@/components/ui/button';
import {
  fetchBacklog,
  fetchCalendars,
  fetchCapacity,
  fetchNotifications,
  fetchSchedule,
  fetchTasks,
  type ScheduleView,
} from '@/lib/schedule';
import { ApiError } from '@/lib/api';
import { fetchConfiguration, fetchContext, fetchHistory, runCommand } from '@/lib/commands';
import { optimisticBlocks, schedulesAgree } from '@/lib/optimistic';
import { now } from '@/lib/clock';
import { displayFirstDayOfWeek, displayLocale, displayTimeZone } from '@/lib/session';
import { addDays, formatCivilDate, localDate, toIso, weekDays } from '@/lib/time';
import type {
  CapacityCell,
  Category,
  CommandRequest,
  FixedBlock,
  HistoryView,
  Notification,
  ScheduledBlock,
} from '@ambitime/shared';
import type { GridBlock } from '@/lib/grid';

/**
 * The week view, and from M11 the place tasks and appointments are made.
 *
 * Everything drawn here still comes from the API's derived reads: the client
 * does not compute a schedule yet. M12 adds the optimistic solve, and doing it
 * early would mean two answers on screen with no way to tell which was
 * authoritative.
 *
 * Writes go the other way round — a command, then a re-read. That is a round
 * trip the user waits for, which is precisely what M12 removes; until it does,
 * waiting is the honest behaviour, because the schedule really is not known
 * until the server has re-derived it.
 */

/**
 * Formatting comes from §13's user settings, not from props.
 *
 * The props survive as overrides so a component test can pin them, but nothing
 * in the application passes them: a user who has chosen a locale has chosen it
 * everywhere, and a screen that took its own default would be one more place
 * for that choice to fail to apply.
 */
const props = defineProps<{ firstDayOfWeek?: number; locale?: string }>();

const locale = computed(() => props.locale ?? displayLocale());
const firstDayOfWeek = computed(() => props.firstDayOfWeek ?? displayFirstDayOfWeek());

/**
 * The zone the grid is drawn in (§13, §5.1).
 *
 * The user's setting when they have made one, and the calendar's own zone when
 * they have not — which is exactly what every screen did before the setting
 * existed, so nobody's view changes until they ask for it to.
 */
const zone = computed(() => displayTimeZone(calendar.value?.timezone ?? 'UTC'));

const calendars = ref<CalendarSummary[]>([]);
const selectedId = ref<string | null>(null);
const view = ref<ScheduleView | null>(null);
const backlog = ref<BacklogEntry[]>([]);
const tasks = ref<TaskNode[]>([]);
const categories = ref<Category[]>([]);
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

/**
 * What the side panel is showing. One editor at a time: a task and an
 * appointment are different enough that a merged form would be mostly
 * conditionals, and two open at once would leave "save" ambiguous.
 */
type Editing =
  | { kind: 'none' }
  | { kind: 'task'; task: TaskNode | null; parent: TaskNode | null }
  | { kind: 'block'; block: FixedBlock | null; defaultStart?: string };

const editing = ref<Editing>({ kind: 'none' });

/** The Monday (or configured first day) of the week being shown. */
const anchor = ref<CivilDate | null>(null);

const calendar = computed(() => calendars.value.find((entry) => entry.id === selectedId.value));

const days = computed<CivilDate[]>(() =>
  anchor.value === null ? [] : weekDays(anchor.value, firstDayOfWeek.value),
);

const today = computed<CivilDate | null>(() =>
  calendar.value ? localDate(now().toISOString(), zone.value) : null,
);

async function load() {
  loading.value = true;
  error.value = null;

  try {
    calendars.value = await fetchCalendars();
    selectedId.value ??= calendars.value[0]?.id ?? null;

    const id = selectedId.value;
    if (id === null) return;

    const [schedule, entries, taskList, configuration, log, context, signals, cells] =
      await Promise.all([
        fetchSchedule(id),
        fetchBacklog(id),
        fetchTasks(id),
        fetchConfiguration(id),
        fetchHistory(),
        fetchContext(id),
        fetchNotifications(),
        fetchCapacity(id),
      ]);

    categories.value = configuration.categories;
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

function shiftWeek(weeks: number) {
  if (anchor.value !== null) anchor.value = addDays(anchor.value, weeks * 7);
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

function parentOf(task: TaskNode): TaskNode | null {
  return task.parentId === null
    ? null
    : (tasks.value.find((candidate) => candidate.id === task.parentId) ?? null);
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

function editBlock(block: GridBlock): void {
  if (block.appointmentId === undefined) {
    // A task block: its source is the task, so that is what opens. The block is
    // derived, and there is nothing about it to edit directly (§3.4).
    const task = tasks.value.find((candidate) => candidate.id === block.taskId);
    if (task !== undefined) editing.value = { kind: 'task', task, parent: parentOf(task) };
    return;
  }

  const found = view.value?.fixedBlocks.find(
    (candidate) => candidate.appointmentId === block.appointmentId,
  );
  if (found !== undefined) editing.value = { kind: 'block', block: found };
}

/**
 * A block dropped, or nudged, onto a new local start (spec §7.3, §13).
 *
 * The grid speaks in local minutes, because that is what a user dragged; the
 * command speaks in instants. The conversion happens here, once, in the
 * calendar's zone — the same helper the editors use, so a drag across a DST
 * weekend lands on the wall clock the user saw rather than an hour off it.
 */
async function moveBlock(payload: {
  block: GridBlock;
  day: CivilDate;
  startMin: number;
}): Promise<void> {
  const taskId = payload.block.taskId;
  if (taskId === undefined) return;

  await submit({
    type: 'MoveTask',
    params: {
      taskId,
      // The grid speaks local minutes in the zone it drew, so the conversion
      // has to use that same zone — not the calendar's, when the two differ.
      datetime: toIso(wallClockToInstant(payload.day, payload.startMin, zone.value)),
    },
  });
}

async function postponeDay(day: CivilDate): Promise<void> {
  await submit({
    type: 'PostponeRestOfDay',
    params: { calendarId: selectedId.value!, date: formatCivilDate(day) },
  });
}

/** The placement of the task the editor has open, if it has one. */
const selectedPlacement = computed<ScheduledBlock | null>(() => {
  const open = editing.value;
  if (open.kind !== 'task' || open.task === null) return null;
  return view.value?.schedule.blocks.find((block) => block.taskId === open.task!.id) ?? null;
});

/** Everything else on the calendar, as swap candidates (§7.3). */
const swapCandidates = computed<ScheduledBlock[]>(() => {
  const open = editing.value;
  if (open.kind !== 'task' || open.task === null) return [];
  return (view.value?.schedule.blocks ?? []).filter((block) => block.taskId !== open.task!.id);
});

function addBlockOn(day: CivilDate): void {
  const at = wallClockToInstant(day, 9 * 60, zone.value);
  editing.value = { kind: 'block', block: null, defaultStart: toIso(at) };
}

onMounted(load);
watch(selectedId, load);
</script>

<template>
  <div class="flex flex-col gap-6 p-6" data-testid="calendar-view">
    <header class="flex flex-wrap items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-semibold tracking-tight">Schedule</h1>
        <select
          v-if="calendars.length > 1"
          v-model="selectedId"
          class="border-input bg-background rounded-md border px-2 py-1 text-sm"
          data-testid="calendar-select"
        >
          <option v-for="entry in calendars" :key="entry.id" :value="entry.id">
            {{ entry.name }}
          </option>
        </select>
        <span v-if="calendar" class="text-muted-foreground text-xs" data-testid="calendar-zone">
          {{ zone }}
          <template v-if="zone !== calendar.timezone">
            <!--
              Said out loud when the two differ: the grid is in your zone, but
              this calendar's availability windows are wall-clock rules in its
              own (§5.1), so "09:00 Monday" means something different to the
              scheduler than the row you are looking at.
            -->
            <span data-testid="zone-divergence">(calendar is {{ calendar.timezone }})</span>
          </template>
        </span>
      </div>

      <div class="flex items-center gap-2">
        <UndoRedo :history="history" :submit="submit" />
        <Button variant="outline" size="sm" data-testid="week-back" @click="shiftWeek(-1)">
          Previous
        </Button>
        <Button variant="outline" size="sm" data-testid="week-forward" @click="shiftWeek(1)">
          Next
        </Button>
      </div>
    </header>

    <p v-if="error" class="text-destructive text-sm" data-testid="calendar-error">{{ error }}</p>
    <p
      v-else-if="diverged"
      class="text-muted-foreground text-sm"
      role="status"
      data-testid="schedule-diverged"
    >
      The server placed things a little differently from the preview, and its answer is what you are
      looking at now.
    </p>
    <p v-else-if="loading" class="text-muted-foreground text-sm">Loading the schedule…</p>

    <!--
      A new account has a tenant but no calendar: §4.3 says a user may own
      several, so nothing creates one for them. Without this the schedule
      rendered nothing at all — signing up and landing on a blank page is not
      a working registration.
    -->
    <section
      v-else-if="calendars.length === 0"
      class="max-w-prose space-y-3"
      data-testid="no-calendar-yet"
    >
      <h2 class="text-lg font-semibold">Welcome. Let's make you a calendar.</h2>
      <p class="text-muted-foreground text-sm">
        A calendar is a scheduling context — a set of hours you work in and the kinds of thing you
        do in them. You can have several; work and personal keep their own windows and their own
        week.
      </p>
      <Button as-child data-testid="create-first-calendar">
        <RouterLink to="/settings">Set up my first calendar</RouterLink>
      </Button>
    </section>

    <template v-else-if="view && calendar">
      <WeekGrid
        :days="days"
        :time-zone="zone"
        :blocks="view.schedule.blocks"
        :fixed-blocks="view.fixedBlocks"
        :today="today"
        :locale="locale"
        editable
        @select-block="editBlock"
        @add-block="addBlockOn"
        @move-block="moveBlock"
        @postpone-day="postponeDay"
      />

      <div class="grid gap-8 lg:grid-cols-[2fr_1fr]">
        <NotificationCentre :notifications="notifications" :submit="submit" />
        <CapacityPanel :cells="capacity" :categories="categories" />
      </div>

      <div class="grid gap-8 lg:grid-cols-[2fr_1fr]">
        <TaskListPanel
          :tasks="tasks"
          :selected-id="editing.kind === 'task' ? (editing.task?.id ?? null) : null"
          editable
          @select="(task) => (editing = { kind: 'task', task, parent: parentOf(task) })"
          @add-child="(parent) => (editing = { kind: 'task', task: null, parent })"
          @add-root="editing = { kind: 'task', task: null, parent: null }"
        />
        <BacklogPanel :entries="backlog" />
      </div>

      <div
        v-if="editing.kind !== 'none'"
        class="bg-card rounded-lg border p-5"
        data-testid="editor-panel"
      >
        <template v-if="editing.kind === 'task'">
          <TaskEditor
            :key="editing.task?.id ?? `new-${editing.parent?.id ?? 'root'}`"
            :task="editing.task"
            :parent="editing.parent"
            :calendar-id="calendar.id"
            :categories="categories"
            :time-zone="zone"
            :submit="submit"
            @cancel="editing = { kind: 'none' }"
          />
          <div v-if="editing.task && editing.task.isLeaf" class="mt-6 border-t pt-5">
            <TaskActions
              :task="editing.task"
              :placement="selectedPlacement"
              :others="swapCandidates"
              :time-zone="zone"
              :submit="submit"
            />
          </div>
        </template>
        <AppointmentEditor
          v-else-if="editing.kind === 'block'"
          :key="editing.block?.appointmentId ?? 'new-block'"
          :block="editing.block"
          :calendar-id="calendar.id"
          :time-zone="zone"
          :default-start="editing.defaultStart"
          :submit="submit"
          @cancel="editing = { kind: 'none' }"
        />
      </div>
    </template>
  </div>
</template>

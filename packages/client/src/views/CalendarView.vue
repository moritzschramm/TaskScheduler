<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { BacklogEntry, CalendarSummary, TaskNode } from '@ambitime/shared';
import { wallClockToInstant } from '@ambitime/scheduler';
import type { CivilDate } from '@ambitime/scheduler';
import UndoRedo from '@/components/UndoRedo.vue';
import AppointmentEditor from '@/components/calendar/AppointmentEditor.vue';
import WeekGrid from '@/components/calendar/WeekGrid.vue';
import BacklogPanel from '@/components/panels/BacklogPanel.vue';
import TaskListPanel from '@/components/panels/TaskListPanel.vue';
import TaskActions from '@/components/tasks/TaskActions.vue';
import TaskEditor from '@/components/tasks/TaskEditor.vue';
import { Button } from '@/components/ui/button';
import {
  fetchBacklog,
  fetchCalendars,
  fetchSchedule,
  fetchTasks,
  type ScheduleView,
} from '@/lib/schedule';
import { ApiError } from '@/lib/api';
import { fetchConfiguration, fetchHistory, runCommand } from '@/lib/commands';
import { now } from '@/lib/clock';
import { addDays, formatCivilDate, localDate, toIso, weekDays } from '@/lib/time';
import type {
  Category,
  CommandRequest,
  FixedBlock,
  HistoryView,
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

const props = withDefaults(defineProps<{ firstDayOfWeek?: number; locale?: string }>(), {
  firstDayOfWeek: 1,
  locale: 'en-GB',
});

const calendars = ref<CalendarSummary[]>([]);
const selectedId = ref<string | null>(null);
const view = ref<ScheduleView | null>(null);
const backlog = ref<BacklogEntry[]>([]);
const tasks = ref<TaskNode[]>([]);
const categories = ref<Category[]>([]);
const history = ref<HistoryView | null>(null);
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
  anchor.value === null ? [] : weekDays(anchor.value, props.firstDayOfWeek),
);

const today = computed<CivilDate | null>(() =>
  calendar.value ? localDate(now().toISOString(), calendar.value.timezone) : null,
);

async function load() {
  loading.value = true;
  error.value = null;

  try {
    calendars.value = await fetchCalendars();
    selectedId.value ??= calendars.value[0]?.id ?? null;

    const id = selectedId.value;
    if (id === null) return;

    const [schedule, entries, taskList, configuration, log] = await Promise.all([
      fetchSchedule(id),
      fetchBacklog(id),
      fetchTasks(id),
      fetchConfiguration(id),
      fetchHistory(),
    ]);

    categories.value = configuration.categories;
    history.value = log;

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

/** One command, then a re-read. The response is what the screen believes. */
async function submit(request: CommandRequest): Promise<boolean> {
  error.value = null;

  try {
    await runCommand(request);
    await load();
    return true;
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? cause.message
        : cause instanceof Error
          ? cause.message
          : 'That change could not be applied';
    return false;
  }
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

  const zone = calendar.value?.timezone ?? 'UTC';
  await submit({
    type: 'MoveTask',
    params: { taskId, datetime: toIso(wallClockToInstant(payload.day, payload.startMin, zone)) },
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
  const zone = calendar.value?.timezone ?? 'UTC';
  const at = wallClockToInstant(day, 9 * 60, zone);
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
          {{ calendar.timezone }}
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
    <p v-else-if="loading" class="text-muted-foreground text-sm">Loading the schedule…</p>

    <template v-else-if="view && calendar">
      <WeekGrid
        :days="days"
        :time-zone="calendar.timezone"
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
            :time-zone="calendar.timezone"
            :submit="submit"
            @cancel="editing = { kind: 'none' }"
          />
          <div v-if="editing.task && editing.task.isLeaf" class="mt-6 border-t pt-5">
            <TaskActions
              :task="editing.task"
              :placement="selectedPlacement"
              :others="swapCandidates"
              :time-zone="calendar.timezone"
              :submit="submit"
            />
          </div>
        </template>
        <AppointmentEditor
          v-else-if="editing.kind === 'block'"
          :key="editing.block?.appointmentId ?? 'new-block'"
          :block="editing.block"
          :calendar-id="calendar.id"
          :time-zone="calendar.timezone"
          :default-start="editing.defaultStart"
          :submit="submit"
          @cancel="editing = { kind: 'none' }"
        />
      </div>
    </template>
  </div>
</template>

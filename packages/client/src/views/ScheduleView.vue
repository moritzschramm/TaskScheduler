<script setup lang="ts">
import { onMounted } from 'vue';
import { wallClockToInstant, type CivilDate } from '@ambitime/scheduler';
import AppointmentEditor from '@/components/calendar/AppointmentEditor.vue';
import WeekGrid from '@/components/calendar/WeekGrid.vue';
import WeekToolbar from '@/components/calendar/WeekToolbar.vue';
import NotificationCentre from '@/components/NotificationCentre.vue';
import CapacityPanel from '@/components/panels/CapacityPanel.vue';
import TaskActions from '@/components/tasks/TaskActions.vue';
import TaskEditor from '@/components/tasks/TaskEditor.vue';
import WorkspaceStatus from '@/components/WorkspaceStatus.vue';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { formatCivilDate, formatDayLabel, toIso } from '@/lib/time';
import { dayOf, useWorkspace } from '@/lib/workspace';
import type { GridBlock } from '@/lib/grid';
import type { ScheduledBlock } from '@ambitime/shared';

/**
 * The week, and only the week (spec §6.1, §13).
 *
 * The task list and the backlog used to hang below this grid, which made the
 * screen a list of everything the application knows rather than an answer to
 * "what am I doing". They live on Tasks now. What stays here is the schedule
 * itself and the two things that comment on it — the signals of §11 and the
 * capacity indicator of §6.6 — plus an editor for whatever block you click,
 * because the block you clicked is the thing you want to change.
 */
const {
  view,
  categories,
  notifications,
  capacity,
  calendar,
  zone,
  days,
  today,
  locale,
  editing,
  taskDialogOpen,
  blockDialogOpen,
  openWindows,
  dayStartMin,
  dayEndMin,
  unschedulable,
  noWindows,
  scheduledElsewhere,
  ensureLoaded,
  submit,
  openTask,
  newBlockAt,
  showWeekOf,
  selectedId,
} = useWorkspace();

onMounted(ensureLoaded);

function editBlock(block: GridBlock): void {
  if (block.appointmentId === undefined) {
    // A task block: its source is the task, so that is what opens. The block is
    // derived, and there is nothing about it to edit directly (§3.4).
    if (block.taskId !== undefined) openTask(block.taskId);
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
      datetime: toIso(wallClockToInstant(payload.day, payload.startMin, zone.value)),
    },
  });
}

/**
 * Done, from the grid (spec §7.3).
 *
 * The block stays where it was rather than disappearing: the placement is
 * copied onto the occurrence at completion, so the week keeps its record of
 * what the afternoon was spent on even though the solver has given the slot
 * back to everything that comes after it.
 */
async function completeBlock(block: GridBlock): Promise<void> {
  if (block.taskId === undefined) return;
  await submit({ type: 'CompleteTask', params: { taskId: block.taskId } });
}

async function postponeDay(day: CivilDate): Promise<void> {
  await submit({
    type: 'PostponeRestOfDay',
    params: { calendarId: selectedId.value!, date: formatCivilDate(day) },
  });
}

/** The placement of the task the editor has open, if it has one. */
function placementOf(taskId: string): ScheduledBlock | null {
  return view.value?.schedule.blocks.find((block) => block.taskId === taskId) ?? null;
}

/** Everything else on the calendar, as swap candidates (§7.3). */
function swapCandidates(taskId: string): ScheduledBlock[] {
  return (view.value?.schedule.blocks ?? []).filter((block) => block.taskId !== taskId);
}
</script>

<template>
  <div class="flex flex-col gap-6 p-6" data-testid="calendar-view">
    <WeekToolbar title="Schedule" />
    <WorkspaceStatus />

    <template v-if="view && calendar">
      <!--
        Ahead of the grid rather than below it: this is the answer to the
        question an empty week has just made the reader ask, and an answer
        underneath two panels is an answer they have to go looking for.
      -->
      <section
        v-if="noWindows"
        class="max-w-prose space-y-3 rounded-lg border border-amber-300 bg-amber-50 p-4 dark:border-amber-800 dark:bg-amber-950"
        role="status"
        data-testid="no-windows-yet"
      >
        <h2 class="text-sm font-semibold">Nothing can be scheduled in this week.</h2>
        <p class="text-sm">
          No availability window falls in it, so the engine has nowhere to put anything — the whole
          week below is closed. Availability is set per category, in settings.
        </p>
        <Button as-child size="sm" data-testid="set-up-availability">
          <RouterLink to="/settings">Set up availability</RouterLink>
        </Button>
      </section>

      <!--
        The horizon is two weeks and this view opens on today's, so a calendar
        whose only free hours fall later schedules into a week nobody is
        looking at. Without this the schedule is simply missing, and the
        explanation — "press Next" — is unreachable by inspection.
      -->
      <section
        v-if="scheduledElsewhere.length > 0"
        class="max-w-prose space-y-2 rounded-lg border p-4"
        role="status"
        data-testid="scheduled-elsewhere"
      >
        <h2 class="text-sm font-semibold">
          {{ scheduledElsewhere.length }}
          {{ scheduledElsewhere.length === 1 ? 'task is' : 'tasks are' }} scheduled outside this
          week
        </h2>
        <ul class="space-y-1">
          <li v-for="block in scheduledElsewhere" :key="block.occurrenceId" class="text-sm">
            <button
              type="button"
              class="underline underline-offset-4"
              data-testid="jump-to-week"
              @click="showWeekOf(dayOf(block))"
            >
              {{ block.title }}
            </button>
            <span class="text-muted-foreground">
              — {{ formatDayLabel(dayOf(block), locale) }}
            </span>
          </li>
        </ul>
      </section>

      <section
        v-if="unschedulable.length > 0"
        class="max-w-prose space-y-2 rounded-lg border p-4"
        role="status"
        data-testid="unschedulable-notice"
      >
        <h2 class="text-sm font-semibold">
          {{ unschedulable.length }}
          {{ unschedulable.length === 1 ? 'task is' : 'tasks are' }} not being scheduled
        </h2>
        <ul class="space-y-1">
          <li v-for="entry in unschedulable" :key="entry.occurrenceId" class="text-sm">
            <RouterLink
              class="underline underline-offset-4"
              to="/tasks"
              data-testid="unschedulable-task"
              :data-task-id="entry.taskId"
              @click="openTask(entry.taskId)"
            >
              {{ entry.title }}
            </RouterLink>
            <span class="text-muted-foreground"> — {{ entry.reasonText }}.</span>
          </li>
        </ul>
      </section>

      <WeekGrid
        :days="days"
        :time-zone="zone"
        :blocks="view.schedule.blocks"
        :fixed-blocks="view.fixedBlocks"
        :completed-blocks="view.completedBlocks"
        :windows="openWindows"
        :day-start-min="dayStartMin"
        :day-end-min="dayEndMin"
        :today="today"
        :locale="locale"
        editable
        @select-block="editBlock"
        @add-block="(day) => newBlockAt(day)"
        @move-block="moveBlock"
        @complete-block="completeBlock"
        @postpone-day="postponeDay"
      />

      <div class="grid gap-8 lg:grid-cols-[2fr_1fr]">
        <NotificationCentre :notifications="notifications" :submit="submit" />
        <CapacityPanel :cells="capacity" :categories="categories" />
      </div>

      <!--
        A task opens over the week; an appointment opens beside it. The
        asymmetry is deliberate — a task's form is long and has nothing to do
        with the grid behind it, while an appointment is a time you are reading
        off that grid as you type.
      -->
      <Dialog
        v-if="editing.kind === 'task'"
        v-model:open="taskDialogOpen"
        :title="editing.task === null ? 'New task' : 'Edit task'"
        data-testid="editor-panel"
      >
        <TaskEditor
          :key="editing.task?.id ?? `new-${editing.parent?.id ?? 'root'}`"
          :task="editing.task"
          :parent="editing.parent"
          :calendar-id="calendar.id"
          :categories="categories"
          :time-zone="zone"
          :submit="submit"
          @cancel="editing = { kind: 'none' }"
          @saved="editing = { kind: 'none' }"
        />
        <div v-if="editing.task && editing.task.isLeaf" class="mt-6 border-t pt-5">
          <TaskActions
            :task="editing.task"
            :placement="placementOf(editing.task.id)"
            :others="swapCandidates(editing.task.id)"
            :time-zone="zone"
            :submit="submit"
          />
        </div>
      </Dialog>

      <Dialog
        v-else-if="editing.kind === 'block'"
        v-model:open="blockDialogOpen"
        :title="editing.block === null ? 'New fixed block' : 'Edit fixed block'"
        data-testid="editor-panel"
      >
        <AppointmentEditor
          :key="editing.block?.appointmentId ?? 'new-block'"
          :block="editing.block"
          :calendar-id="calendar.id"
          :time-zone="zone"
          :default-start="editing.defaultStart"
          :submit="submit"
          @cancel="editing = { kind: 'none' }"
          @saved="editing = { kind: 'none' }"
        />
      </Dialog>
    </template>
  </div>
</template>

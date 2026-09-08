<script setup lang="ts">
import { onMounted } from 'vue';
import { useI18n } from '@/i18n';
import { wallClockToInstant, type CivilDate } from '@ambitime/scheduler';
import AppointmentEditor from '@/components/calendar/AppointmentEditor.vue';
import MonthGrid from '@/components/calendar/MonthGrid.vue';
import WeekGrid from '@/components/calendar/WeekGrid.vue';
import WeekToolbar from '@/components/calendar/WeekToolbar.vue';
import NotificationCentre from '@/components/NotificationCentre.vue';
import BacklogPanel from '@/components/panels/BacklogPanel.vue';
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
import { Plus } from 'lucide-vue-next';

const { t, plural } = useI18n();

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
  backlog,
  configuration,
  mode,
  month,
  firstDayOfWeek,
  horizonEnd,
  ensureLoaded,
  submit,
  openTask,
  showWeekOf,
  setMode,
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
/** Opens the task modal on a new root task (§4.4). */
function newTask(): void {
  editing.value = { kind: 'task', task: null, parent: null };
}

async function completeBlock(block: GridBlock): Promise<void> {
  if (block.taskId === undefined) return;
  await submit({ type: 'CompleteTask', params: { taskId: block.taskId } });
}

/**
 * "I'm not in this day" (spec §7.2).
 *
 * One gesture for a sick day or for something coming up, and it says the thing
 * that is actually true — the day is not available — rather than instructing
 * the scheduler to shuffle tasks out of it. What follows is the same either
 * way, because a day with no capacity holds nothing.
 */
/** A day clicked in the month opens that week, which is where the hours are. */
function openDay(day: CivilDate): void {
  showWeekOf(day);
  setMode('week');
}

async function blockDay(day: CivilDate): Promise<void> {
  await submit({
    type: 'BlockOutDay',
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
    <WeekToolbar :title="t('schedule.title')">
      <template #actions>
        <Button size="sm" data-testid="new-task" @click="newTask">
          <Plus class="size-4" aria-hidden="true" />
          {{ t('schedule.newTask') }}
        </Button>
      </template>
    </WeekToolbar>
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
        <h2 class="text-sm font-semibold">{{ t('schedule.noWindowsTitle') }}</h2>
        <p class="text-sm">
          {{ t('schedule.noWindowsBody') }}
        </p>
        <Button as-child size="sm" data-testid="set-up-availability">
          <RouterLink to="/categories">{{ t('schedule.noWindowsAction') }}</RouterLink>
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
          {{ plural('schedule.elsewhere', scheduledElsewhere.length) }}
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
          {{ plural('schedule.unschedulable', unschedulable.length) }}
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
        v-if="mode === 'week'"
        :days="days"
        :time-zone="zone"
        :blocks="view.schedule.blocks"
        :fixed-blocks="view.fixedBlocks"
        :completed-blocks="view.completedBlocks"
        :windows="openWindows"
        :categories="categories"
        :day-start-min="dayStartMin"
        :day-end-min="dayEndMin"
        :today="today"
        :locale="locale"
        editable
        blockable
        @select-block="editBlock"
        @move-block="moveBlock"
        @complete-block="completeBlock"
        @block-day="blockDay"
      />

      <!--
        The month, with the backlog beside it.
        Those two answer one question together: the grid shows where the weeks
        are already full and the special weeks that empty them, and the backlog
        is what did not fit. Reading them apart is what makes an overloaded
        month look like a quiet one.
      -->
      <div v-else class="grid items-start gap-8 lg:grid-cols-[3fr_1fr]">
        <MonthGrid
          :month="month"
          :time-zone="zone"
          :first-day-of-week="firstDayOfWeek"
          :locale="locale"
          :blocks="view.schedule.blocks"
          :fixed-blocks="view.fixedBlocks"
          :completed-blocks="view.completedBlocks"
          :special-weeks="configuration?.weekTypeOverrides ?? []"
          :today="today"
          :horizon-end="horizonEnd"
          editable
          @open-day="openDay"
          @block-day="blockDay"
        />
        <BacklogPanel :entries="backlog" />
      </div>

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
        :title="editing.task === null ? t('editor.newTask') : t('editor.editTask')"
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
        :title="editing.block === null ? t('appointments.editorNew') : t('appointments.editorEdit')"
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

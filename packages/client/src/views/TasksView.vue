<script setup lang="ts">
import { onMounted } from 'vue';
import { useI18n } from '@/i18n';
import BacklogPanel from '@/components/panels/BacklogPanel.vue';
import TaskListPanel, { type QuickAddDraft } from '@/components/panels/TaskListPanel.vue';
import TaskActions from '@/components/tasks/TaskActions.vue';
import TaskEditor from '@/components/tasks/TaskEditor.vue';
import WorkspaceStatus from '@/components/WorkspaceStatus.vue';
import { Dialog } from '@/components/ui/dialog';
import { useWorkspace } from '@/lib/workspace';
import { fromLocalInput } from '@/lib/time';
import { uuidv7, type ScheduledBlock } from '@ambitime/shared';

const { t, plural } = useI18n();

/**
 * Everything there is to do, whether or not it has a slot yet (spec §4.4, §6.7).
 *
 * The tree and the backlog belong together and neither belongs on the grid.
 * The grid answers "when"; this answers "what", and the backlog is the part of
 * "what" that has no "when" — §6.1 puts it past the hard horizon, so it has a
 * week and not a datetime, and a panel wedged under a calendar was a poor place
 * to say that.
 *
 * The editor is here rather than shared with Schedule because this is where a
 * task is *defined*. Schedule keeps its own for the block you clicked, which is
 * a different gesture with a different answer.
 */
const {
  view,
  tasks,
  backlog,
  activityTypes,
  calendar,
  zone,
  editing,
  taskDialogOpen,
  unschedulable,
  ensureLoaded,
  submit,
  runBatch,
  parentOf,
  openTask,
} = useWorkspace();

onMounted(ensureLoaded);

/** The placement of a task, if the engine found it one (§3.4). */
function placementOf(taskId: string): ScheduledBlock | null {
  return view.value?.schedule.blocks.find((block) => block.taskId === taskId) ?? null;
}

/** Everything else on the calendar, as swap candidates (§7.3). */
function swapCandidates(taskId: string): ScheduledBlock[] {
  return (view.value?.schedule.blocks ?? []).filter((block) => block.taskId !== taskId);
}

/**
 * The hour a date-only due date means.
 *
 * The quick row asks for a day, because that is what a person has in mind, and
 * §4.4's due date is an instant. Five in the afternoon of that day, in the
 * calendar's own zone: the end of a working day rather than midnight, which is
 * the first moment of the day *after* the one somebody typed.
 */
const DUE_HOUR = '17:00';

/**
 * A task from the quick-add row (§4.4).
 *
 * The command is assembled here rather than in the panel because this is the
 * layer that knows which calendar is open and which zone its dates are read
 * in — the panel deals in a group, four fields and a local date.
 */
async function quickAdd(draft: QuickAddDraft): Promise<boolean> {
  const calendarId = calendar.value?.id;
  if (calendarId === undefined) return false;

  const due =
    draft.dueDate === null ? null : fromLocalInput(`${draft.dueDate}T${DUE_HOUR}`, zone.value);

  return submit({
    type: 'CreateTask',
    params: {
      calendarId,
      title: draft.title,
      estimatedDurationMin: draft.estimatedDurationMin,
      ...(draft.parentId === null ? {} : { parentId: draft.parentId }),
      ...(draft.activityTypeId === null ? {} : { activityTypeId: draft.activityTypeId }),
      ...(draft.priority === null ? {} : { priority: draft.priority }),
      ...(due === null ? {} : { dueDate: { date: due, kind: 'soft' as const } }),
    },
  });
}

/**
 * Grouping several tasks under one, as a single act (§4.4, §7.5).
 *
 * One `groupId` across the batch, so §7.5 folds them into one unit of history:
 * grouping three tasks was one decision and one press of undo takes it back,
 * rather than three presses that leave the tree half-moved in between.
 */
async function moveTasks({
  taskIds,
  parentId,
}: {
  taskIds: string[];
  parentId: string | null;
}): Promise<void> {
  if (taskIds.length === 0) return;

  await runBatch(
    taskIds.map((taskId) => ({ type: 'SetTaskParent' as const, params: { taskId, parentId } })),
    uuidv7(),
  );
}
</script>

<template>
  <div class="flex flex-col gap-6 p-6" data-testid="tasks-view">
    <header class="max-w-prose space-y-1">
      <h1 class="text-xl font-semibold tracking-tight">{{ t('tasks.title') }}</h1>
      <!--
        What a task is, said once where they are made — the same courtesy
        Activity types pays. The two screens define the two halves of the
        model, and a reader who lands on either should not have to infer the
        other from a table of columns.
      -->
      <p class="text-muted-foreground text-sm">
        {{ t('tasks.lead') }}
      </p>
    </header>

    <WorkspaceStatus />

    <template v-if="view && calendar">
      <!--
        Repeated from Schedule on purpose. This is the screen where the fix
        lives — a missing activity type or estimate is a field on the editor below —
        so naming the task where it can be opened is worth the duplication.
      -->
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
            <button
              type="button"
              class="underline underline-offset-4"
              data-testid="unschedulable-task"
              :data-task-id="entry.taskId"
              @click="openTask(entry.taskId)"
            >
              {{ entry.title }}
            </button>
            <span class="text-muted-foreground"> — {{ entry.reasonText }}.</span>
          </li>
        </ul>
      </section>

      <div class="grid gap-8 lg:grid-cols-[2fr_1fr]">
        <TaskListPanel
          :tasks="tasks"
          :activity-types="activityTypes"
          :selected-id="editing.kind === 'task' ? (editing.task?.id ?? null) : null"
          :quick-add="quickAdd"
          editable
          @select="(task) => (editing = { kind: 'task', task, parent: parentOf(task) })"
          @add-child="(parent) => (editing = { kind: 'task', task: null, parent })"
          @add-root="editing = { kind: 'task', task: null, parent: null }"
          @move="moveTasks"
        />
        <BacklogPanel :entries="backlog" />
      </div>

      <!--
        A modal, because editing a task is a modal act: the tree behind it is
        the thing you picked from, and a form that shares the page with its own
        list invites saving the one you are no longer looking at.
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
          :activity-types="activityTypes"
          :time-zone="zone"
          :submit="submit"
          @cancel="editing = { kind: 'none' }"
          @saved="editing = { kind: 'none' }"
        >
          <div v-if="editing.task && editing.task.isLeaf" class="border-t pt-5">
            <TaskActions
              :task="editing.task"
              :placement="placementOf(editing.task.id)"
              :others="swapCandidates(editing.task.id)"
              :time-zone="zone"
              :submit="submit"
            />
          </div>
        </TaskEditor>
      </Dialog>
    </template>
  </div>
</template>

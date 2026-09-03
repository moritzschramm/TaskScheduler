<script setup lang="ts">
import { onMounted } from 'vue';
import BacklogPanel from '@/components/panels/BacklogPanel.vue';
import TaskListPanel from '@/components/panels/TaskListPanel.vue';
import TaskActions from '@/components/tasks/TaskActions.vue';
import TaskEditor from '@/components/tasks/TaskEditor.vue';
import WorkspaceStatus from '@/components/WorkspaceStatus.vue';
import { Dialog } from '@/components/ui/dialog';
import { useWorkspace } from '@/lib/workspace';
import type { ScheduledBlock } from '@ambitime/shared';

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
  categories,
  calendar,
  zone,
  editing,
  taskDialogOpen,
  unschedulable,
  ensureLoaded,
  submit,
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
</script>

<template>
  <div class="flex flex-col gap-6 p-6" data-testid="tasks-view">
    <header class="flex flex-wrap items-center justify-between gap-4">
      <h1 class="text-xl font-semibold tracking-tight">Tasks</h1>
    </header>

    <WorkspaceStatus />

    <template v-if="view && calendar">
      <!--
        Repeated from Schedule on purpose. This is the screen where the fix
        lives — a missing category or estimate is a field on the editor below —
        so naming the task where it can be opened is worth the duplication.
      -->
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
          :categories="categories"
          :selected-id="editing.kind === 'task' ? (editing.task?.id ?? null) : null"
          editable
          @select="(task) => (editing = { kind: 'task', task, parent: parentOf(task) })"
          @add-child="(parent) => (editing = { kind: 'task', task: null, parent })"
          @add-root="editing = { kind: 'task', task: null, parent: null }"
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
    </template>
  </div>
</template>

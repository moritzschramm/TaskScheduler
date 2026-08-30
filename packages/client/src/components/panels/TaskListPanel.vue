<script setup lang="ts">
import { computed } from 'vue';
import {
  createCoreRowModel,
  useTable,
  type ColumnDef,
  type TableFeatures,
} from '@tanstack/vue-table';
import type { TaskNode } from '@ambitime/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const props = withDefaults(
  defineProps<{ tasks: TaskNode[]; selectedId?: string | null; editable?: boolean }>(),
  { selectedId: null, editable: false },
);

const emit = defineEmits<{ select: [task: TaskNode]; addChild: [parent: TaskNode]; addRoot: [] }>();

/**
 * Spec §4.4's hard cap. A task at depth 5 can have no children, and the button
 * that would create one is disabled rather than absent — an affordance that
 * vanishes teaches nothing, and the limit is a rule worth stating.
 */
const MAX_DEPTH = 5;

/**
 * The dense tabular view (client convention: TanStack Table for these).
 *
 * The columns show a property's **effective** value and mark it when it came
 * from an ancestor, because §4.4's inheritance is invisible otherwise: a row
 * showing only the effective value cannot tell you whether clearing it would
 * change anything. The editor beside it shows the same distinction as a
 * control rather than as an italic.
 *
 * The tree is already in depth-first order with a `path`, so indentation is a
 * left margin rather than a second data structure — and because parents always
 * precede their children, the visual nesting is the query's ordering rather
 * than something rebuilt here.
 */

// v9 carries the row-model factories on `features` rather than as separate
// options. Only the core model: no sorting, filtering or pagination yet.
const features = { coreRowModel: createCoreRowModel() } satisfies TableFeatures;

const columns: ColumnDef<typeof features, TaskNode>[] = [
  { id: 'title', header: 'Task', accessorKey: 'title' },
  { id: 'status', header: 'Status', accessorKey: 'status' },
  { id: 'duration', header: 'Estimate', accessorKey: 'estimatedDurationMin' },
  { id: 'priority', header: 'Priority', accessorKey: 'effectivePriority' },
  { id: 'due', header: 'Due', accessorKey: 'effectiveDueDate' },
  { id: 'actions', header: '', accessorKey: 'id' },
];

const table = useTable({
  features,
  columns,
  data: computed(() => props.tasks),
});

const rows = computed(() => table.getRowModel().rows);
const headers = computed(() => table.getHeaderGroups()[0]?.headers ?? []);

function inheritedPriority(task: TaskNode): boolean {
  return task.ownPriority === null && task.effectivePriority !== null;
}

function inheritedDue(task: TaskNode): boolean {
  return task.ownDueDate === null && task.effectiveDueDate !== null;
}

function formatDue(value: string | null): string {
  return value === null ? '—' : value.slice(0, 10);
}

function canHaveChildren(task: TaskNode): boolean {
  return task.depth < MAX_DEPTH && task.status === 'active';
}
</script>

<template>
  <section class="flex flex-col gap-3" data-testid="task-panel" aria-labelledby="tasks-title">
    <header class="flex items-baseline justify-between gap-3">
      <h2 id="tasks-title" class="text-sm font-semibold">Tasks</h2>
      <div class="flex items-center gap-3">
        <span class="text-muted-foreground text-xs">{{ tasks.length }}</span>
        <Button v-if="editable" size="sm" data-testid="add-root-task" @click="emit('addRoot')">
          New task
        </Button>
      </div>
    </header>

    <p v-if="tasks.length === 0" class="text-muted-foreground text-sm">No tasks yet.</p>

    <table v-else class="w-full text-sm" data-testid="task-table">
      <thead>
        <tr class="text-muted-foreground border-b text-left text-xs">
          <th v-for="header in headers" :key="header.id" class="py-1.5 pr-3 font-medium">
            {{ header.column.columnDef.header }}
          </th>
        </tr>
      </thead>

      <tbody>
        <tr
          v-for="row in rows"
          :key="row.id"
          class="border-b last:border-0"
          :class="row.original.id === selectedId ? 'bg-accent/50' : ''"
          data-testid="task-row"
          :data-task-id="row.original.id"
          :data-depth="row.original.depth"
          :data-selected="row.original.id === selectedId ? 'true' : 'false'"
        >
          <td class="py-1.5 pr-3">
            <span :style="{ paddingLeft: `${(row.original.depth - 1) * 16}px` }">
              <button
                v-if="editable"
                type="button"
                class="hover:underline"
                data-testid="select-task"
                @click="emit('select', row.original)"
              >
                {{ row.original.title }}
              </button>
              <template v-else>{{ row.original.title }}</template>
            </span>
          </td>
          <td class="py-1.5 pr-3">
            <Badge v-if="row.original.status !== 'active'" variant="secondary">
              {{ row.original.status }}
            </Badge>
            <span v-else class="text-muted-foreground text-xs">
              {{ row.original.isLeaf ? 'leaf' : 'parent' }}
            </span>
          </td>
          <td class="py-1.5 pr-3 tabular-nums">
            {{ row.original.estimatedDurationMin ?? '—' }}
          </td>
          <td class="py-1.5 pr-3 tabular-nums">
            <span :class="inheritedPriority(row.original) ? 'text-muted-foreground italic' : ''">
              {{ row.original.effectivePriority ?? '—' }}
            </span>
          </td>
          <td class="py-1.5 pr-3 tabular-nums">
            <span :class="inheritedDue(row.original) ? 'text-muted-foreground italic' : ''">
              {{ formatDue(row.original.effectiveDueDate) }}
            </span>
          </td>
          <td class="py-1.5 text-right">
            <Button
              v-if="editable"
              variant="ghost"
              size="sm"
              :disabled="!canHaveChildren(row.original)"
              :title="
                row.original.depth >= MAX_DEPTH
                  ? 'Tasks can nest five deep at most'
                  : 'Add a subtask'
              "
              :aria-label="`Add a subtask to ${row.original.title}`"
              data-testid="add-subtask"
              @click="emit('addChild', row.original)"
            >
              Subtask
            </Button>
          </td>
        </tr>
      </tbody>
    </table>

    <p class="text-muted-foreground text-xs">
      Values shown in <span class="italic">italics</span> are inherited from an ancestor (§4.4).
      Tasks nest five deep at most.
    </p>
  </section>
</template>

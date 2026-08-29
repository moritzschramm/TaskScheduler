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

const props = defineProps<{ tasks: TaskNode[] }>();

/**
 * The dense tabular view (client convention: TanStack Table for these).
 *
 * Read-only in M10, and the columns are chosen for what M11 will need to make
 * editable: a property's **own** value beside its **effective** one, because
 * §4.4's inheritance is invisible otherwise. A row showing only the effective
 * value cannot tell you whether clearing it would change anything.
 *
 * The tree is already in depth-first order with a `path`, so indentation is a
 * left margin rather than a second data structure.
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
</script>

<template>
  <section class="flex flex-col gap-3" data-testid="task-panel" aria-labelledby="tasks-title">
    <header class="flex items-baseline justify-between">
      <h2 id="tasks-title" class="text-sm font-semibold">Tasks</h2>
      <span class="text-muted-foreground text-xs">{{ tasks.length }}</span>
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
          data-testid="task-row"
          :data-task-id="row.original.id"
          :data-depth="row.original.depth"
        >
          <td class="py-1.5 pr-3">
            <span :style="{ paddingLeft: `${(row.original.depth - 1) * 16}px` }">
              {{ row.original.title }}
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
        </tr>
      </tbody>
    </table>

    <p class="text-muted-foreground text-xs">
      Values shown in <span class="italic">italics</span> are inherited from an ancestor (§4.4).
    </p>
  </section>
</template>

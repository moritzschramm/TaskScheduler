<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  createCoreRowModel,
  useTable,
  type ColumnDef,
  type TableFeatures,
} from '@tanstack/vue-table';
import type { Category, TaskNode } from '@ambitime/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

const props = withDefaults(
  defineProps<{
    tasks: TaskNode[];
    /** Names for the groups; a task's own is `effectiveCategoryId` (§4.3). */
    categories?: Category[];
    selectedId?: string | null;
    editable?: boolean;
  }>(),
  { categories: () => [], selectedId: null, editable: false },
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
 *
 * **Grouped by activity type, and collapsible.** A flat list of everything is
 * the same shape as the backlog and answers the same question badly: what a
 * person wants from this screen is "how much work is there, of what kind", and
 * a category is the only division the system actually schedules by (§6.2 rule
 * 1). Every group starts open, because collapsing is a thing you do to a
 * section you have decided to ignore — never the state you should have to
 * undo before you can read the page.
 *
 * Inheritance keeps the trees whole. A subtask with no category of its own
 * takes its parent's (§4.4), so a group holds entire subtrees unless somebody
 * has deliberately said otherwise — and when they have, the task appears under
 * the type they gave it, which is the thing they were asking for.
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
  { id: 'actions', header: 'Actions', accessorKey: 'id' },
];

const table = useTable({
  features,
  columns,
  data: computed(() => props.tasks),
});

const rows = computed(() => table.getRowModel().rows);
const headers = computed(() => table.getHeaderGroups()[0]?.headers ?? []);

/** Groups the user has folded away. Empty is the default: everything open. */
const collapsed = ref(new Set<string>());

/** The key a task with no activity type is grouped under. */
const NO_CATEGORY = '';

const byId = computed(() => new Map(props.tasks.map((task) => [task.id, task])));

/**
 * How deep to indent a task *within its group*.
 *
 * Counted as ancestors that are in the same group rather than taken from
 * `depth`, so a subtask whose type was overridden sits at the left edge of the
 * group it was moved to rather than three levels in under nothing.
 */
function indentOf(task: TaskNode, groupKey: string): number {
  let indent = 0;
  let current = task.parentId === null ? undefined : byId.value.get(task.parentId);

  while (current !== undefined) {
    if ((current.effectiveCategoryId ?? NO_CATEGORY) === groupKey) indent += 1;
    current = current.parentId === null ? undefined : byId.value.get(current.parentId);
  }

  return indent;
}

interface Group {
  key: string;
  name: string;
  rows: { row: (typeof rows.value)[number]; indent: number }[];
}

/**
 * The groups, in the order their first task appears.
 *
 * Not alphabetical: the tree's own order is somebody's ordering of their work,
 * and re-sorting the containers around it would move the group you were reading
 * every time you renamed a category.
 */
const groups = computed<Group[]>(() => {
  const found = new Map<string, Group>();

  for (const row of rows.value) {
    const key = row.original.effectiveCategoryId ?? NO_CATEGORY;
    const existing = found.get(key);
    const entry = { row, indent: indentOf(row.original, key) };

    if (existing === undefined) found.set(key, { key, name: nameOf(key), rows: [entry] });
    else existing.rows.push(entry);
  }

  return [...found.values()];
});

function nameOf(key: string): string {
  if (key === NO_CATEGORY) return 'No activity type';
  return props.categories.find((category) => category.id === key)?.name ?? 'Unknown activity type';
}

function toggle(key: string): void {
  const next = new Set(collapsed.value);
  if (!next.delete(key)) next.add(key);
  collapsed.value = next;
}

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
          <th
            v-for="header in headers"
            :key="header.id"
            scope="col"
            class="py-1.5 pr-3 font-medium"
          >
            <!--
              Every column needs a header a screen reader can announce, even the
              one whose heading would be noise on screen (WCAG 1.3.1) — axe's
              `empty-table-header` is exactly this, and it was real.
            -->
            <span :class="header.id === 'actions' ? 'sr-only' : ''">
              {{ header.column.columnDef.header }}
            </span>
          </th>
        </tr>
      </thead>

      <tbody
        v-for="group in groups"
        :key="group.key"
        data-testid="task-group"
        :data-group="group.key"
      >
        <tr class="bg-muted/40 border-b">
          <th :colspan="headers.length" scope="colgroup" class="py-1.5 pr-3 text-left">
            <button
              type="button"
              class="flex w-full items-center gap-2 text-left"
              :aria-expanded="!collapsed.has(group.key)"
              data-testid="toggle-group"
              @click="toggle(group.key)"
            >
              <span class="text-muted-foreground text-xs" aria-hidden="true">
                {{ collapsed.has(group.key) ? '▸' : '▾' }}
              </span>
              <span class="text-sm font-semibold">{{ group.name }}</span>
              <span class="text-muted-foreground text-xs font-normal">{{ group.rows.length }}</span>
            </button>
          </th>
        </tr>

        <tr
          v-for="entry in collapsed.has(group.key) ? [] : group.rows"
          :key="entry.row.id"
          class="border-b last:border-0"
          :class="entry.row.original.id === selectedId ? 'bg-accent/50' : ''"
          data-testid="task-row"
          :data-task-id="entry.row.original.id"
          :data-depth="entry.row.original.depth"
          :data-selected="entry.row.original.id === selectedId ? 'true' : 'false'"
        >
          <td class="py-1.5 pr-3">
            <span :style="{ paddingLeft: `${entry.indent * 16}px` }">
              <button
                v-if="editable"
                type="button"
                class="hover:underline"
                data-testid="select-task"
                @click="emit('select', entry.row.original)"
              >
                {{ entry.row.original.title }}
              </button>
              <template v-else>{{ entry.row.original.title }}</template>
            </span>
          </td>
          <td class="py-1.5 pr-3">
            <Badge v-if="entry.row.original.status !== 'active'" variant="secondary">
              {{ entry.row.original.status }}
            </Badge>
            <span v-else class="text-muted-foreground text-xs">
              {{ entry.row.original.isLeaf ? 'leaf' : 'parent' }}
            </span>
          </td>
          <td class="py-1.5 pr-3 tabular-nums">
            {{ entry.row.original.estimatedDurationMin ?? '—' }}
          </td>
          <td class="py-1.5 pr-3 tabular-nums">
            <span
              :class="inheritedPriority(entry.row.original) ? 'text-muted-foreground italic' : ''"
            >
              {{ entry.row.original.effectivePriority ?? '—' }}
            </span>
          </td>
          <td class="py-1.5 pr-3 tabular-nums">
            <span :class="inheritedDue(entry.row.original) ? 'text-muted-foreground italic' : ''">
              {{ formatDue(entry.row.original.effectiveDueDate) }}
            </span>
          </td>
          <td class="py-1.5 text-right">
            <Button
              v-if="editable"
              variant="ghost"
              size="sm"
              :disabled="!canHaveChildren(entry.row.original)"
              :title="
                entry.row.original.depth >= MAX_DEPTH
                  ? 'Tasks can nest five deep at most'
                  : 'Add a subtask'
              "
              :aria-label="`Add a subtask to ${entry.row.original.title}`"
              data-testid="add-subtask"
              @click="emit('addChild', entry.row.original)"
            >
              Subtask
            </Button>
          </td>
        </tr>
      </tbody>
    </table>

    <p class="text-muted-foreground text-xs">
      Grouped by activity type. Values shown in <span class="italic">italics</span> are inherited
      from an ancestor. Tasks nest five deep at most.
    </p>
  </section>
</template>

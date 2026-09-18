<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from '@/i18n';
import {
  createCoreRowModel,
  useTable,
  type ColumnDef,
  type TableFeatures,
} from '@tanstack/vue-table';
import type { ActivityType, TaskNode } from '@ambitime/shared';
import type { MessageKey } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Plus } from 'lucide-vue-next';

// Read during setup as well as during render — the quick-add drafts are
// seeded from the group names — so it is destructured before anything uses it.
const { t } = useI18n();

/**
 * What the quick-add row can say about a task: the four fields §4.4 needs to
 * place one, and nothing else.
 *
 * Everything a task *can* have is a long form, and opening it is the right
 * thing to do when there is something to think about. Most tasks have nothing
 * to think about — a name, how long, and sometimes a deadline — and for those
 * the modal was the whole cost of writing one down.
 */
export interface QuickAddDraft {
  /** The group the row belongs to; `null` is the ungrouped one. */
  activityTypeId: string | null;
  title: string;
  estimatedDurationMin: number;
  priority: number | null;
  /** A local `YYYY-MM-DD`; the view knows the zone to read it in. */
  dueDate: string | null;
}

const props = withDefaults(
  defineProps<{
    tasks: TaskNode[];
    /** Names for the groups; a task's own is `effectiveActivityTypeId` (§4.3). */
    activityTypes?: ActivityType[];
    selectedId?: string | null;
    editable?: boolean;
    /**
     * Creates a task from the quick-add row, and says whether it landed.
     *
     * A function rather than an emit, for one reason: the row has to know
     * whether to clear itself, and an emit cannot answer. Building the command
     * stays with the view, which is the layer that knows the calendar and the
     * zone a due date is read in.
     */
    quickAdd?: ((draft: QuickAddDraft) => Promise<boolean>) | undefined;
  }>(),
  { activityTypes: () => [], selectedId: null, editable: false, quickAdd: undefined },
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
 * an activity type is the only division the system actually schedules by (§6.2 rule
 * 1). Every group starts open, because collapsing is a thing you do to a
 * section you have decided to ignore — never the state you should have to
 * undo before you can read the page.
 *
 * Inheritance keeps the trees whole. A subtask with no activity type of its own
 * takes its parent's (§4.4), so a group holds entire subtrees unless somebody
 * has deliberately said otherwise — and when they have, the task appears under
 * the type they gave it, which is the thing they were asking for.
 */

// v9 carries the row-model factories on `features` rather than as separate
// options. Only the core model: no sorting, filtering or pagination yet.
const features = { coreRowModel: createCoreRowModel() } satisfies TableFeatures;

/**
 * No status column.
 *
 * It carried two things and neither earned a fifth of the width: a badge for
 * the tasks that are not active, which are a small minority of a list somebody
 * is reading to decide what to do next, and the words "leaf" or "parent" for
 * every task that is — which is the shape of the tree, and the indentation
 * beside it already says that. What was worth keeping is that a cancelled or
 * completed task should not read as work outstanding; the title is struck
 * through and dimmed instead, which costs no column at all.
 */
const columns: ColumnDef<typeof features, TaskNode>[] = [
  { id: 'title', header: 'tasks.column.task', accessorKey: 'title' },
  { id: 'duration', header: 'tasks.column.estimate', accessorKey: 'estimatedDurationMin' },
  { id: 'priority', header: 'tasks.column.priority', accessorKey: 'effectivePriority' },
  { id: 'due', header: 'tasks.column.due', accessorKey: 'effectiveDueDate' },
  { id: 'actions', header: 'tasks.column.actions', accessorKey: 'id' },
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
const NO_ACTIVITY_TYPE = '';

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
    if ((current.effectiveActivityTypeId ?? NO_ACTIVITY_TYPE) === groupKey) indent += 1;
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
 * every time you renamed an activity type.
 */
const groups = computed<Group[]>(() => {
  const found = new Map<string, Group>();

  for (const row of rows.value) {
    const key = row.original.effectiveActivityTypeId ?? NO_ACTIVITY_TYPE;
    const existing = found.get(key);
    const entry = { row, indent: indentOf(row.original, key) };

    if (existing === undefined) found.set(key, { key, name: nameOf(key), rows: [entry] });
    else existing.rows.push(entry);
  }

  return [...found.values()];
});

function nameOf(key: string): string {
  if (key === NO_ACTIVITY_TYPE) return t('tasks.ungrouped');
  return (
    props.activityTypes.find((activityType) => activityType.id === key)?.name ??
    t('tasks.unknownGroup')
  );
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

/**
 * One unsent task per group, held while it is being typed.
 *
 * Per group rather than one shared row, because the group *is* the activity
 * type: the row is already the answer to "what kind of thing is this", which is
 * the field a person is least likely to volunteer and the one §6.2 rule 1 makes
 * mandatory. A single row at the bottom of the table would have to ask.
 */
interface QuickDraft {
  title: string;
  /**
   * `string | number`, and both really happen: `v-model` on a `type="number"`
   * input hands back a **number** once it parses and the empty string while it
   * does not, so a draft field that claimed to be a string was a `.trim()`
   * waiting to throw. Read through `numberIn` rather than cast.
   */
  estimate: string | number;
  priority: string | number;
  due: string;
}

const drafts = reactive(new Map<string, QuickDraft>());
const adding = ref<string | null>(null);

function emptyDraft(): QuickDraft {
  return { title: '', estimate: '', priority: '', due: '' };
}

/** The whole number a numeric field holds, or `null` when it holds nothing. */
function numberIn(value: string | number): number | null {
  const parsed = typeof value === 'number' ? value : Number(value.trim());
  if (value === '' || !Number.isInteger(parsed)) return null;
  return parsed;
}

// Seeded from the groups rather than created on demand in the template: a
// render that writes to reactive state is a render that schedules another one.
watch(
  () => groups.value.map((group) => group.key),
  (keys) => {
    for (const key of keys) if (!drafts.has(key)) drafts.set(key, emptyDraft());
    const live = new Set(keys);
    for (const key of [...drafts.keys()]) if (!live.has(key)) drafts.delete(key);
  },
  { immediate: true },
);

/**
 * Both required, and that is the point.
 *
 * A task with no estimate cannot be placed (§6.2), so a quick way to make one
 * would be a quick way to fill the "these could not be scheduled" list. The
 * long form is where a task without one belongs, because there it is a
 * deliberate act rather than a field somebody skipped.
 */
function ready(key: string): boolean {
  const draft = drafts.get(key);
  if (draft === undefined) return false;

  const estimate = numberIn(draft.estimate);
  return draft.title.trim() !== '' && estimate !== null && estimate > 0;
}

async function add(key: string): Promise<void> {
  const draft = drafts.get(key);
  if (props.quickAdd === undefined || draft === undefined || !ready(key) || adding.value !== null) {
    return;
  }

  adding.value = key;
  try {
    const landed = await props.quickAdd({
      activityTypeId: key === NO_ACTIVITY_TYPE ? null : key,
      title: draft.title.trim(),
      estimatedDurationMin: numberIn(draft.estimate)!,
      priority: numberIn(draft.priority),
      dueDate: draft.due === '' ? null : draft.due,
    });

    // Cleared only when it landed: a refused command leaves the error banner
    // above the table and the words still in the row, which is the only state
    // from which the user can try again without retyping.
    if (landed) drafts.set(key, emptyDraft());
  } finally {
    adding.value = null;
  }
}
</script>

<template>
  <section class="flex flex-col gap-3" data-testid="task-panel" aria-labelledby="tasks-title">
    <header class="flex items-baseline justify-between gap-3">
      <h2 id="tasks-title" class="text-sm font-semibold">{{ t('tasks.title') }}</h2>
      <div class="flex items-center gap-3">
        <span class="text-muted-foreground text-xs">{{ tasks.length }}</span>
        <Button v-if="editable" size="sm" data-testid="add-root-task" @click="emit('addRoot')">
          <Plus class="size-4" aria-hidden="true" />
          {{ t('tasks.newTask') }}
        </Button>
      </div>
    </header>

    <p v-if="tasks.length === 0" class="text-muted-foreground text-sm">{{ t('tasks.empty') }}</p>

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
              {{ t(header.column.columnDef.header as MessageKey) }}
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
              <!--
                Struck through and dimmed where the status column used to say
                so: a completed or cancelled task is still part of the tree and
                still worth reading, and it must not read as work outstanding.
              -->
              <button
                v-if="editable"
                type="button"
                class="hover:underline"
                :class="
                  entry.row.original.status === 'active' ? '' : 'text-muted-foreground line-through'
                "
                data-testid="select-task"
                @click="emit('select', entry.row.original)"
              >
                {{ entry.row.original.title }}
              </button>
              <span
                v-else
                :class="
                  entry.row.original.status === 'active' ? '' : 'text-muted-foreground line-through'
                "
                >{{ entry.row.original.title }}</span
              >
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
                  ? t('tasks.depthCapped')
                  : t('tasks.addSubtask')
              "
              :aria-label="t('tasks.addSubtaskTo', { title: entry.row.original.title })"
              data-testid="add-subtask"
              @click="emit('addChild', entry.row.original)"
            >
              {{ t('tasks.subtask') }}
            </Button>
          </td>
        </tr>

        <!--
          The empty row at the foot of every group: a task written down without
          opening anything. One per group because the group is the activity
          type, which is the field §6.2 rule 1 makes mandatory and the one a
          person is least likely to volunteer — a single row under the whole
          table would have to ask for it.

          Enter sends from any of the four fields. The modal is still there for
          everything this row cannot say, and the title links to it.
        -->
        <tr
          v-if="editable && quickAdd && !collapsed.has(group.key) && drafts.get(group.key)"
          class="border-b last:border-0"
          data-testid="quick-add"
          :data-group="group.key"
        >
          <td class="py-1.5 pr-3">
            <Input
              v-model="drafts.get(group.key)!.title"
              :placeholder="t('tasks.quickAdd')"
              :aria-label="t('tasks.quickAddIn', { group: group.name })"
              data-testid="quick-add-title"
              @keydown.enter="add(group.key)"
            />
          </td>
          <td class="py-1.5 pr-3">
            <Input
              v-model="drafts.get(group.key)!.estimate"
              type="number"
              min="1"
              class="w-20"
              :placeholder="t('tasks.quickAddMinutes')"
              :aria-label="t('tasks.column.estimate')"
              data-testid="quick-add-estimate"
              @keydown.enter="add(group.key)"
            />
          </td>
          <td class="py-1.5 pr-3">
            <Input
              v-model="drafts.get(group.key)!.priority"
              type="number"
              class="w-20"
              :aria-label="t('tasks.column.priority')"
              data-testid="quick-add-priority"
              @keydown.enter="add(group.key)"
            />
          </td>
          <td class="py-1.5 pr-3">
            <input
              v-model="drafts.get(group.key)!.due"
              type="date"
              class="border-input bg-background focus-visible:ring-ring h-9 rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
              :aria-label="t('tasks.column.due')"
              data-testid="quick-add-due"
              @keydown.enter="add(group.key)"
            />
          </td>
          <td class="py-1.5 text-right">
            <Button
              size="sm"
              :disabled="!ready(group.key) || adding !== null"
              data-testid="quick-add-save"
              @click="add(group.key)"
            >
              {{ t('common.add') }}
            </Button>
          </td>
        </tr>
      </tbody>
    </table>

    <p class="text-muted-foreground text-xs">
      {{ t('tasks.footnote') }}
    </p>
  </section>
</template>

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
const { t, plural } = useI18n();

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
  /**
   * The task to hang it under, when the row is inside one (§4.4).
   *
   * Set means the new task inherits — its activity type comes from the parent,
   * so the group's own id is deliberately not sent as well. An override
   * identical to what would be inherited is still an override, and clearing it
   * later would look like it did nothing.
   */
  parentId: string | null;
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

const emit = defineEmits<{
  select: [task: TaskNode];
  addChild: [parent: TaskNode];
  addRoot: [];
  /** Re-parent several tasks at once; `null` takes them back to the top. */
  move: [{ taskIds: string[]; parentId: string | null }];
}>();

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

/**
 * What a container is worth, and how far through it somebody is.
 *
 * §4.4 says a parent's duration and completion "roll up from its leaves", and
 * until now nothing computed it: the Estimate column showed a container's own
 * `estimated_duration_min`, which is a number that is never scheduled, in the
 * same type as the leaves' numbers that are. A reader had no way to tell the
 * two apart, and the one honest figure for a container — what the work under it
 * actually costs — was not on the page at all.
 *
 * Cancelled leaves are in neither total. They are not work outstanding, and
 * counting them would make a project that somebody pruned look further from
 * done than before they pruned it.
 *
 * One reverse pass. Tasks arrive depth-first, so every child is visited before
 * the parent it contributes to, and no recursion or memo is needed.
 */
interface Rollup {
  /** Direct children, which is what makes a task a container. */
  children: number;
  /** Σ of the leaves' estimates, in minutes. */
  minutes: number;
  leaves: number;
  done: number;
}

const EMPTY_ROLLUP: Rollup = { children: 0, minutes: 0, leaves: 0, done: 0 };

const rollups = computed<Map<string, Rollup>>(() => {
  const acc = new Map<string, Rollup>();
  for (const task of props.tasks) acc.set(task.id, { ...EMPTY_ROLLUP });

  for (let index = props.tasks.length - 1; index >= 0; index -= 1) {
    const task = props.tasks[index]!;
    const own = acc.get(task.id)!;

    if (task.isLeaf && task.status !== 'cancelled') {
      own.minutes = task.estimatedDurationMin ?? 0;
      own.leaves = 1;
      own.done = task.status === 'completed' ? 1 : 0;
    }

    const parent = task.parentId === null ? undefined : acc.get(task.parentId);
    if (parent === undefined) continue;

    parent.children += 1;
    parent.minutes += own.minutes;
    parent.leaves += own.leaves;
    parent.done += own.done;
  }

  return acc;
});

const rollupOf = (task: TaskNode): Rollup => rollups.value.get(task.id) ?? EMPTY_ROLLUP;

/**
 * Containers the user has folded away — the same gesture the groups have.
 *
 * A container had no affordance of its own: the activity-type headings above it
 * got a triangle and a count, and a task holding three others got sixteen
 * pixels of indent on the rows beneath it and nothing else. Folding is what
 * makes a project a thing you can put away, which is most of what makes it read
 * as a thing at all.
 */
const foldedTasks = ref(new Set<string>());

function foldTask(id: string): void {
  const next = new Set(foldedTasks.value);
  if (!next.delete(id)) next.add(id);
  foldedTasks.value = next;
}

function foldedAbove(task: TaskNode): boolean {
  let current = task.parentId === null ? undefined : byId.value.get(task.parentId);

  while (current !== undefined) {
    if (foldedTasks.value.has(current.id)) return true;
    current = current.parentId === null ? undefined : byId.value.get(current.parentId);
  }

  return false;
}

interface Entry {
  row: (typeof rows.value)[number];
  task: TaskNode;
  indent: number;
  rollup: Rollup;
  container: boolean;
}

/**
 * A row, or the empty row that writes one.
 *
 * The quick-add row used to exist once per group, so the cheap way to write a
 * task down always made a root: getting it under a project cost a button and a
 * modal, which made structuring more expensive than not structuring. There is
 * now one at the foot of every open container too, and it is the same row.
 */
type Item =
  | { kind: 'task'; key: string; entry: Entry }
  | { kind: 'add'; key: string; parent: TaskNode | null };

interface Group {
  key: string;
  name: string;
  count: number;
  items: Item[];
}

/**
 * The groups, in the order their first task appears.
 *
 * Not alphabetical: the tree's own order is somebody's ordering of their work,
 * and re-sorting the containers around it would move the group you were reading
 * every time you renamed an activity type.
 */
const groups = computed<Group[]>(() => {
  const collected = new Map<string, Entry[]>();

  for (const row of rows.value) {
    const task = row.original;
    const key = task.effectiveActivityTypeId ?? NO_ACTIVITY_TYPE;
    const rollup = rollupOf(task);
    const entry: Entry = {
      row,
      task,
      indent: indentOf(task, key),
      rollup,
      container: rollup.children > 0,
    };

    const existing = collected.get(key);
    if (existing === undefined) collected.set(key, [entry]);
    else existing.push(entry);
  }

  return [...collected.entries()].map(([key, entries]) => ({
    key,
    name: nameOf(key),
    count: entries.length,
    items: [...itemsOf(entries), { kind: 'add' as const, key: `group:${key}`, parent: null }],
  }));
});

/**
 * The rows of a group, with an empty row closing every open container.
 *
 * Entries arrive depth-first, so a container's block ends at the first entry
 * indented no further than it — which is exactly when its empty row belongs,
 * beneath the last thing in it rather than at the bottom of the whole group.
 * The stack is what turns "indentation went back out" into "these containers
 * just closed", innermost first.
 */
function itemsOf(entries: Entry[]): Item[] {
  const items: Item[] = [];
  const open: Entry[] = [];

  const close = (toIndent: number): void => {
    while ((open[open.length - 1]?.indent ?? -1) >= toIndent) {
      const container = open.pop()!;
      items.push({ kind: 'add', key: `sub:${container.task.id}`, parent: container.task });
    }
  };

  for (const entry of entries) {
    if (foldedAbove(entry.task)) continue;

    close(entry.indent);
    items.push({ kind: 'task', key: entry.task.id, entry });
    if (entry.container && !foldedTasks.value.has(entry.task.id)) open.push(entry);
  }

  close(0);
  return items;
}

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
 * Grouping work that was written down flat (spec §4.4).
 *
 * The motion this exists for is the ordinary one: jot five things, notice three
 * of them are one job, put them together. Until `SetTaskParent` there was no
 * way to do it — `parent_id` was settable at creation and never after — so the
 * only route was to delete and retype, losing the task's id, its history and
 * wherever it had been placed.
 *
 * Ticking rather than dragging. Three tasks that belong together are rarely
 * adjacent, and a drag that has to scroll is a drag that goes wrong; a tick is
 * also the only version of this a keyboard can do at all (WCAG 2.1.1).
 */
const chosen = ref(new Set<string>());
const target = ref('');

/** `null` means the top level, which is a real destination and not "none". */
const TO_TOP_LEVEL = 'top';

function choose(id: string): void {
  const next = new Set(chosen.value);
  if (!next.delete(id)) next.add(id);
  chosen.value = next;
}

function clearChosen(): void {
  chosen.value = new Set();
  target.value = '';
}

// A task that is deleted, or filtered away, must not go on counting.
watch(
  () => props.tasks.map((task) => task.id).join(','),
  () => {
    const live = new Set(props.tasks.map((task) => task.id));
    const kept = [...chosen.value].filter((id) => live.has(id));
    if (kept.length !== chosen.value.size) chosen.value = new Set(kept);
  },
);

/**
 * Every task travelling, mapped to the chosen task it travels under.
 *
 * A subtree moves with its root, so choosing a container and something inside
 * it is choosing the container twice. This is what collapses that, and what
 * keeps the destinations below from offering somewhere inside the very thing
 * being moved.
 */
const travelling = computed<Map<string, string>>(() => {
  const roots = new Map<string, string>();

  for (const task of props.tasks) {
    if (chosen.value.has(task.id)) roots.set(task.id, task.id);
    else if (task.parentId !== null && roots.has(task.parentId)) {
      roots.set(task.id, roots.get(task.parentId)!);
    }
  }

  return roots;
});

/** The chosen tasks that are not already inside another chosen task. */
const movingRoots = computed<string[]>(() =>
  [...chosen.value].filter((id) => {
    const task = byId.value.get(id);
    return task?.parentId == null || travelling.value.get(task.parentId) === undefined;
  }),
);

/**
 * How many levels the deepest thing being moved sits below its own root.
 *
 * Depth is capped at 5 (§4.4) and the cap is enforced over the whole subtree, so
 * a destination that would push a grandchild to six is a command the server
 * refuses. Working it out here means offering only the destinations that work,
 * rather than a list where some of the entries are errors.
 */
const movingSpan = computed<number>(() => {
  let span = 0;

  for (const [id, rootId] of travelling.value) {
    const task = byId.value.get(id);
    const root = byId.value.get(rootId);
    if (task !== undefined && root !== undefined) span = Math.max(span, task.depth - root.depth);
  }

  return span;
});

const destinations = computed<TaskNode[]>(() => {
  if (chosen.value.size === 0) return [];

  return props.tasks.filter(
    (task) =>
      task.status === 'active' &&
      travelling.value.get(task.id) === undefined &&
      task.depth + 1 + movingSpan.value <= MAX_DEPTH,
  );
});

function applyMove(): void {
  if (target.value === '' || movingRoots.value.length === 0) return;

  emit('move', {
    taskIds: movingRoots.value,
    parentId: target.value === TO_TOP_LEVEL ? null : target.value,
  });
  clearChosen();
}

/**
 * One unsent task per empty row, held while it is being typed.
 *
 * Per row rather than one shared draft, because each row already answers a
 * question the form would otherwise have to ask. A group's row knows the
 * activity type — the field §6.2 rule 1 makes mandatory and the one a person is
 * least likely to volunteer — and a container's row knows the parent, from
 * which the type is inherited anyway.
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

// Seeded from the rendered rows rather than created on demand in the template:
// a render that writes to reactive state is a render that schedules another one.
watch(
  () =>
    groups.value.flatMap((group) =>
      group.items.filter((item) => item.kind === 'add').map((item) => item.key),
    ),
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

async function add(key: string, group: string, parent: TaskNode | null): Promise<void> {
  const draft = drafts.get(key);
  if (props.quickAdd === undefined || draft === undefined || !ready(key) || adding.value !== null) {
    return;
  }

  adding.value = key;
  try {
    const landed = await props.quickAdd({
      // Inside a container the type is inherited, so it is not sent (§4.4).
      activityTypeId: parent !== null || group === NO_ACTIVITY_TYPE ? null : group,
      parentId: parent?.id ?? null,
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

    <!--
      Only while something is ticked, and directly above the thing it acts on.
      A toolbar that is present and disabled most of the time teaches the reader
      to stop looking at it.
    -->
    <div
      v-if="editable && chosen.size > 0"
      class="bg-muted/60 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2"
      role="group"
      :aria-label="t('tasks.moveChosen')"
      data-testid="chosen-bar"
    >
      <span class="text-sm font-medium" data-testid="chosen-count">
        {{ plural('tasks.chosen', chosen.size) }}
      </span>
      <select
        v-model="target"
        class="border-input bg-background rounded-md border px-2 py-1 text-sm"
        :aria-label="t('tasks.moveChosen')"
        data-testid="move-target"
      >
        <option value="">{{ t('tasks.chooseDestination') }}</option>
        <option :value="TO_TOP_LEVEL">{{ t('tasks.topLevel') }}</option>
        <option v-for="option in destinations" :key="option.id" :value="option.id">
          {{ option.title }}
        </option>
      </select>
      <Button size="sm" :disabled="target === ''" data-testid="move-apply" @click="applyMove">
        {{ t('tasks.move') }}
      </Button>
      <Button variant="ghost" size="sm" data-testid="move-clear" @click="clearChosen">
        {{ t('common.cancel') }}
      </Button>
    </div>

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
              <span class="text-muted-foreground text-xs font-normal">{{ group.count }}</span>
            </button>
          </th>
        </tr>

        <template v-for="item in collapsed.has(group.key) ? [] : group.items" :key="item.key">
          <tr
            v-if="item.kind === 'task'"
            class="border-b last:border-0"
            :class="item.entry.task.id === selectedId ? 'bg-accent/50' : ''"
            data-testid="task-row"
            :data-task-id="item.entry.task.id"
            :data-depth="item.entry.task.depth"
            :data-container="item.entry.container ? 'true' : 'false'"
            :data-selected="item.entry.task.id === selectedId ? 'true' : 'false'"
          >
            <td class="py-1.5 pr-3">
              <!--
                A container's own row is the affordance: the triangle that folds
                it, the count of what is in it, and — on the rows beneath — a
                rule at the start of the indent, so the offset reads as
                containment rather than as an accident of spacing. On the inner
                span rather than this one: a border here would draw at the left
                of the *padding*, which is the same x for every depth.
              -->
              <span
                class="flex items-stretch"
                :style="{ paddingLeft: `${item.entry.indent * 18}px` }"
              >
                <span
                  v-if="item.entry.indent > 0"
                  class="border-border mr-2 border-l"
                  aria-hidden="true"
                ></span>
                <span class="flex items-center gap-1.5">
                  <input
                    v-if="editable"
                    type="checkbox"
                    class="size-3.5 shrink-0 accent-current"
                    :checked="chosen.has(item.entry.task.id)"
                    :aria-label="t('tasks.choose', { title: item.entry.task.title })"
                    data-testid="choose-task"
                    @change="choose(item.entry.task.id)"
                  />

                  <button
                    v-if="item.entry.container"
                    type="button"
                    class="text-muted-foreground w-3 shrink-0 text-xs"
                    :aria-expanded="!foldedTasks.has(item.entry.task.id)"
                    :aria-label="t('tasks.foldProject', { title: item.entry.task.title })"
                    data-testid="fold-task"
                    @click="foldTask(item.entry.task.id)"
                  >
                    {{ foldedTasks.has(item.entry.task.id) ? '▸' : '▾' }}
                  </button>
                  <span v-else class="w-3 shrink-0" aria-hidden="true"></span>

                  <!--
                  Struck through and dimmed where the status column used to say
                  so: a completed or cancelled task is still part of the tree and
                  still worth reading, and it must not read as work outstanding.
                -->
                  <button
                    v-if="editable"
                    type="button"
                    class="hover:underline"
                    :class="[
                      item.entry.task.status === 'active'
                        ? ''
                        : 'text-muted-foreground line-through',
                      item.entry.container ? 'font-medium' : '',
                    ]"
                    data-testid="select-task"
                    @click="emit('select', item.entry.task)"
                  >
                    {{ item.entry.task.title }}
                  </button>
                  <span
                    v-else
                    :class="
                      item.entry.task.status === 'active'
                        ? ''
                        : 'text-muted-foreground line-through'
                    "
                    >{{ item.entry.task.title }}</span
                  >

                  <!--
                  How far through it somebody is, which is the question a
                  container is actually asked. Nothing for a leaf: "0/1 done" is
                  a progress bar over a single task.
                -->
                  <span
                    v-if="item.entry.container && item.entry.rollup.leaves > 0"
                    class="text-muted-foreground text-xs tabular-nums"
                    data-testid="project-progress"
                  >
                    {{
                      t('tasks.progress', {
                        done: item.entry.rollup.done,
                        total: item.entry.rollup.leaves,
                      })
                    }}
                  </span>
                </span>
              </span>
            </td>
            <td class="py-1.5 pr-3 tabular-nums">
              <!--
                A container is not scheduled, so its own estimate is a number
                that never becomes time on the grid. What is true of it is what
                the work inside it costs, and it is marked as derived in the
                same italic the inherited values use.
              -->
              <span
                v-if="item.entry.container"
                class="text-muted-foreground italic"
                data-testid="rolled-up-estimate"
              >
                {{ item.entry.rollup.minutes }}
              </span>
              <span v-else>{{ item.entry.task.estimatedDurationMin ?? '—' }}</span>
            </td>
            <td class="py-1.5 pr-3 tabular-nums">
              <span
                :class="inheritedPriority(item.entry.task) ? 'text-muted-foreground italic' : ''"
              >
                {{ item.entry.task.effectivePriority ?? '—' }}
              </span>
            </td>
            <td class="py-1.5 pr-3 tabular-nums">
              <span :class="inheritedDue(item.entry.task) ? 'text-muted-foreground italic' : ''">
                {{ formatDue(item.entry.task.effectiveDueDate) }}
              </span>
            </td>
            <td class="py-1.5 text-right">
              <Button
                v-if="editable"
                variant="ghost"
                size="sm"
                :disabled="!canHaveChildren(item.entry.task)"
                :title="
                  item.entry.task.depth >= MAX_DEPTH
                    ? t('tasks.depthCapped')
                    : t('tasks.addSubtask')
                "
                :aria-label="t('tasks.addSubtaskTo', { title: item.entry.task.title })"
                data-testid="add-subtask"
                @click="emit('addChild', item.entry.task)"
              >
                {{ item.entry.container ? t('tasks.addTask') : t('tasks.breakUp') }}
              </Button>
            </td>
          </tr>

          <!--
            The empty row: a task written down without opening anything. One at
            the foot of every group, where it makes a root, and one at the foot
            of every open container, where it makes something inside it. The
            second is the whole point — while the cheap way to write a task down
            could only ever make a root, structuring cost more than not
            structuring, and people do the cheaper thing.

            Enter sends from any of the four fields. The modal is still there
            for everything this row cannot say, and the title opens it.
          -->
          <tr
            v-else-if="editable && quickAdd && drafts.get(item.key)"
            class="border-b last:border-0"
            data-testid="quick-add"
            :data-group="group.key"
            :data-parent="item.parent?.id ?? ''"
          >
            <td class="py-1.5 pr-3">
              <Input
                v-model="drafts.get(item.key)!.title"
                :class="item.parent ? 'ml-5' : ''"
                :placeholder="item.parent ? t('tasks.quickAddUnder') : t('tasks.quickAdd')"
                :aria-label="
                  item.parent
                    ? t('tasks.quickAddIn', { group: item.parent.title })
                    : t('tasks.quickAddIn', { group: group.name })
                "
                data-testid="quick-add-title"
                @keydown.enter="add(item.key, group.key, item.parent)"
              />
            </td>
            <td class="py-1.5 pr-3">
              <Input
                v-model="drafts.get(item.key)!.estimate"
                type="number"
                min="1"
                class="w-20"
                :placeholder="t('tasks.quickAddMinutes')"
                :aria-label="t('tasks.column.estimate')"
                data-testid="quick-add-estimate"
                @keydown.enter="add(item.key, group.key, item.parent)"
              />
            </td>
            <td class="py-1.5 pr-3">
              <Input
                v-model="drafts.get(item.key)!.priority"
                type="number"
                class="w-20"
                :aria-label="t('tasks.column.priority')"
                data-testid="quick-add-priority"
                @keydown.enter="add(item.key, group.key, item.parent)"
              />
            </td>
            <td class="py-1.5 pr-3">
              <input
                v-model="drafts.get(item.key)!.due"
                type="date"
                class="border-input bg-background focus-visible:ring-ring h-9 rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
                :aria-label="t('tasks.column.due')"
                data-testid="quick-add-due"
                @keydown.enter="add(item.key, group.key, item.parent)"
              />
            </td>
            <td class="py-1.5 text-right">
              <Button
                size="sm"
                :disabled="!ready(item.key) || adding !== null"
                data-testid="quick-add-save"
                @click="add(item.key, group.key, item.parent)"
              >
                {{ t('common.add') }}
              </Button>
            </td>
          </tr>
        </template>
      </tbody>
    </table>

    <p class="text-muted-foreground text-xs">
      {{ t('tasks.footnote') }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import InheritedField from './InheritedField.vue';
import { formatMinuteOfDay, fromLocalInput, parseMinuteOfDay, toLocalInput } from '@/lib/time';
import type { Category, CommandRequest, TaskNode } from '@ambitime/shared';

/**
 * Every property spec §4.4 gives a task, editable.
 *
 * **The whole patch is sent, every time.** `EditTask` distinguishes absent
 * (leave alone) from `null` (clear the override) from a value, and the form
 * knows its own answer for all three on every field — it was seeded from the
 * server's. Sending only what changed would mean tracking dirtiness per field
 * to save a version bump that costs nothing.
 *
 * The one rule checked here rather than left to the server is the due-date one:
 * a child cannot be due after its container (§4.4). The database enforces it
 * with a deferred trigger and the API turns that into a sentence, but a form
 * that lets you type a date, press save, and then explains has wasted the
 * typing.
 */
const props = defineProps<{
  /** `null` when creating. */
  task: TaskNode | null;
  /** The parent a new task is created under, or the existing task's parent. */
  parent: TaskNode | null;
  calendarId: string;
  categories: Category[];
  timeZone: string;
  submit: (request: CommandRequest) => Promise<boolean>;
}>();

const emit = defineEmits<{ cancel: [] }>();

interface Draft {
  title: string;
  notes: string;
  estimate: string;
  category: { overridden: boolean; value: string };
  priority: { overridden: boolean; value: string };
  due: { overridden: boolean; value: string; kind: 'soft' | 'hard' };
  preferred: { overridden: boolean; start: string; end: string };
  focus: { overridden: boolean; value: string };
  cooldown: { overridden: boolean; value: string };
  recurrence: {
    on: boolean;
    period: 'day' | 'week' | 'month';
    count: string;
    missedPolicy: 'rollover' | 'expire';
  };
}

const busy = ref(false);
const draft = ref<Draft>(emptyDraft());

const isCreate = computed(() => props.task === null);

function emptyDraft(): Draft {
  return {
    title: '',
    notes: '',
    estimate: '',
    category: { overridden: false, value: '' },
    priority: { overridden: false, value: '' },
    due: { overridden: false, value: '', kind: 'soft' },
    preferred: { overridden: false, start: '09:00', end: '17:00' },
    focus: { overridden: false, value: '3' },
    cooldown: { overridden: false, value: '0' },
    recurrence: { on: false, period: 'week', count: '1', missedPolicy: 'rollover' },
  };
}

/**
 * Seeded from the server's answer, not from what was typed.
 *
 * `own* !== null` is exactly "this task overrides the property", which is why
 * the read model carries the pair: the effective value alone cannot tell an
 * override from an inheritance, and a form built on it would turn every
 * inherited value into an override the first time it was saved.
 */
watch(
  () => props.task,
  (task) => {
    if (task === null) {
      draft.value = emptyDraft();
      return;
    }

    draft.value = {
      title: task.title,
      notes: task.notes ?? '',
      estimate: task.estimatedDurationMin === null ? '' : String(task.estimatedDurationMin),
      category: {
        overridden: task.ownCategoryId !== null,
        value: task.ownCategoryId ?? task.effectiveCategoryId ?? '',
      },
      priority: {
        overridden: task.ownPriority !== null,
        value: String(task.ownPriority ?? task.effectivePriority ?? 0),
      },
      due: {
        overridden: task.ownDueDate !== null,
        value: task.ownDueDate === null ? '' : toLocalInput(task.ownDueDate, props.timeZone),
        kind: task.ownDueKind ?? task.effectiveDueKind ?? 'soft',
      },
      preferred: {
        overridden: task.ownPreferredStartMin !== null,
        start: formatMinuteOfDay(task.ownPreferredStartMin ?? 9 * 60),
        end: formatMinuteOfDay(task.ownPreferredEndMin ?? 17 * 60),
      },
      focus: {
        overridden: task.ownFocusLevel !== null,
        value: String(task.ownFocusLevel ?? task.effectiveFocusLevel ?? 3),
      },
      cooldown: {
        overridden: task.ownCooldownOverrideMin !== null,
        value: String(task.ownCooldownOverrideMin ?? task.effectiveCooldownOverrideMin ?? 0),
      },
      recurrence: {
        on: task.recurrence !== null,
        period: task.recurrence?.period ?? 'week',
        count: String(task.recurrence?.count ?? 1),
        missedPolicy: task.recurrence?.missedPolicy ?? 'rollover',
      },
    };
  },
  { immediate: true },
);

const categoryName = (id: string | null): string | null =>
  id === null ? null : (props.categories.find((category) => category.id === id)?.name ?? id);

/** What an ancestor supplies for each field, for the "Inherited: …" line. */
const inherited = computed(() => {
  const source = props.task ?? props.parent;
  if (source === null) return null;

  // For a task, the inherited value is what it *would* fall back to — which is
  // its effective value whenever that is not its own.
  const from = <T,>(own: T | null, effective: T | null): T | null =>
    props.task === null ? effective : own === null ? effective : null;

  return {
    category: categoryName(from(source.ownCategoryId, source.effectiveCategoryId)),
    priority: from(source.ownPriority, source.effectivePriority),
    due: from(source.ownDueDate, source.effectiveDueDate),
    focus: from(source.ownFocusLevel, source.effectiveFocusLevel),
    cooldown: from(source.ownCooldownOverrideMin, source.effectiveCooldownOverrideMin),
    preferredStart: from(source.ownPreferredStartMin, source.effectivePreferredStartMin),
    preferredEnd: from(source.ownPreferredEndMin, source.effectivePreferredEndMin),
  };
});

function displayDue(iso: string | null): string | null {
  return iso === null ? null : toLocalInput(iso, props.timeZone).replace('T', ' ');
}

function displayRange(start: number | null, end: number | null): string | null {
  if (start === null || end === null) return null;
  return `${formatMinuteOfDay(start)}–${formatMinuteOfDay(end)}`;
}

/**
 * The container's due date, which this task's own may not exceed (§4.4).
 *
 * The *effective* one, not the parent's own: a grandparent's date binds through
 * a parent that has none of its own, which is what nearest-ancestor-wins means.
 */
const containerDue = computed(() => props.parent?.effectiveDueDate ?? null);

const dueConflict = computed(() => {
  if (!draft.value.due.overridden || draft.value.due.value === '') return null;
  if (containerDue.value === null) return null;

  const chosen = fromLocalInput(draft.value.due.value, props.timeZone);
  if (chosen === null) return null;
  if (Date.parse(chosen) <= Date.parse(containerDue.value)) return null;

  return `Its container is due ${displayDue(containerDue.value)}, and a subtask cannot be due after it.`;
});

const canSave = computed(
  () => draft.value.title.trim() !== '' && dueConflict.value === null && !busy.value,
);

/** `null` clears the override; a value sets one (§4.4). */
function overrideOf<T>(field: { overridden: boolean }, value: T): T | null {
  return field.overridden ? value : null;
}

function dueValue(): { date: string; kind: 'soft' | 'hard' } | null {
  if (!draft.value.due.overridden) return null;
  const iso = fromLocalInput(draft.value.due.value, props.timeZone);
  return iso === null ? null : { date: iso, kind: draft.value.due.kind };
}

function preferredValue(): { startMin: number; endMin: number } | null {
  if (!draft.value.preferred.overridden) return null;
  const startMin = parseMinuteOfDay(draft.value.preferred.start);
  const endMin = parseMinuteOfDay(draft.value.preferred.end);
  if (startMin === null || endMin === null || startMin >= endMin) return null;
  return { startMin, endMin };
}

/**
 * The demand rule of spec §8.2, or nothing.
 *
 * A count below one is not a rule, so the toggle is what says whether the task
 * recurs at all — an empty box would otherwise mean "0× per week", which is a
 * confusing way of saying "never".
 */
function recurrenceValue(): {
  period: 'day' | 'week' | 'month';
  count: number;
  missedPolicy: 'rollover' | 'expire';
} | null {
  const { recurrence } = draft.value;
  if (!recurrence.on) return null;

  const count = Number(recurrence.count);
  if (!Number.isInteger(count) || count < 1) return null;

  return { period: recurrence.period, count, missedPolicy: recurrence.missedPolicy };
}

function numberOrNull(field: { overridden: boolean; value: string }): number | null {
  if (!field.overridden) return null;
  const parsed = Number(field.value);
  return Number.isFinite(parsed) ? parsed : null;
}

async function save(): Promise<void> {
  busy.value = true;
  try {
    const applied = await props.submit(isCreate.value ? createRequest() : editRequest());
    if (applied && isCreate.value) draft.value = emptyDraft();
  } finally {
    busy.value = false;
  }
}

function createRequest(): CommandRequest {
  const category = overrideOf(draft.value.category, draft.value.category.value);
  const estimate = draft.value.estimate === '' ? null : Number(draft.value.estimate);
  const due = dueValue();
  const preferred = preferredValue();

  // A create takes no nulls: an absent property simply is not set, and there is
  // no prior override to clear.
  return {
    type: 'CreateTask',
    params: {
      calendarId: props.calendarId,
      title: draft.value.title,
      ...(draft.value.notes === '' ? {} : { notes: draft.value.notes }),
      ...(props.parent === null ? {} : { parentId: props.parent.id }),
      ...(category === null || category === '' ? {} : { categoryId: category }),
      ...(estimate === null ? {} : { estimatedDurationMin: estimate }),
      ...(numberOrNull(draft.value.priority) === null
        ? {}
        : { priority: numberOrNull(draft.value.priority)! }),
      ...(due === null ? {} : { dueDate: due }),
      ...(preferred === null ? {} : { preferredRange: preferred }),
      ...(numberOrNull(draft.value.focus) === null
        ? {}
        : { focusLevel: numberOrNull(draft.value.focus)! }),
      ...(numberOrNull(draft.value.cooldown) === null
        ? {}
        : { cooldownOverrideMin: numberOrNull(draft.value.cooldown)! }),
      ...(recurrenceValue() === null ? {} : { recurrence: recurrenceValue()! }),
    },
  };
}

function editRequest(): CommandRequest {
  const category = overrideOf(draft.value.category, draft.value.category.value);

  return {
    type: 'EditTask',
    expectedVersion: props.task!.version,
    params: {
      taskId: props.task!.id,
      patch: {
        title: draft.value.title,
        notes: draft.value.notes === '' ? null : draft.value.notes,
        categoryId: category === '' ? null : category,
        estimatedDurationMin: draft.value.estimate === '' ? null : Number(draft.value.estimate),
        priority: numberOrNull(draft.value.priority),
        dueDate: dueValue(),
        preferredRange: preferredValue(),
        focusLevel: numberOrNull(draft.value.focus),
        cooldownOverrideMin: numberOrNull(draft.value.cooldown),
        recurrence: recurrenceValue(),
      },
    },
  };
}

async function cancelTask(): Promise<void> {
  if (props.task === null) return;

  busy.value = true;
  try {
    // `CancelTask`, not a delete: §7.3's vocabulary, and it frees the task's
    // footprint and re-derives rather than making the history untrue.
    await props.submit({
      type: 'CancelTask',
      expectedVersion: props.task.version,
      params: { taskId: props.task.id },
    });
  } finally {
    busy.value = false;
  }
}

async function complete(): Promise<void> {
  if (props.task === null) return;

  busy.value = true;
  try {
    await props.submit({
      type: 'CompleteTask',
      expectedVersion: props.task.version,
      params: { taskId: props.task.id },
    });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="space-y-5" data-testid="task-editor">
    <header class="space-y-1">
      <h2 class="text-lg font-semibold">
        {{ isCreate ? (parent ? 'New subtask' : 'New task') : 'Edit task' }}
      </h2>
      <p v-if="parent" class="text-muted-foreground text-sm" data-testid="editor-parent">
        Inside <span class="font-medium">{{ parent.title }}</span>
      </p>
      <p v-if="task && !task.isLeaf" class="text-muted-foreground text-sm">
        This task has subtasks, so it is not scheduled itself — its duration and completion roll up
        from them.
      </p>
    </header>

    <div class="grid gap-4 sm:grid-cols-2">
      <div class="space-y-1 sm:col-span-2">
        <Label for="task-title">Title</Label>
        <Input id="task-title" v-model="draft.title" data-testid="task-title" />
      </div>

      <div class="space-y-1 sm:col-span-2">
        <Label for="task-notes">Notes</Label>
        <Input id="task-notes" v-model="draft.notes" data-testid="task-notes" />
      </div>

      <div class="space-y-1">
        <Label for="task-estimate">Estimate (minutes)</Label>
        <Input
          id="task-estimate"
          v-model="draft.estimate"
          type="number"
          min="1"
          data-testid="task-estimate"
        />
        <p class="text-muted-foreground text-xs">Not inherited — each task carries its own.</p>
      </div>
    </div>

    <div class="grid gap-5 sm:grid-cols-2">
      <InheritedField
        v-model:overridden="draft.category.overridden"
        label="Category"
        :inherited="inherited?.category ?? null"
      >
        <Select v-model="draft.category.value" data-testid="task-category">
          <option value="">None</option>
          <option v-for="category in categories" :key="category.id" :value="category.id">
            {{ category.name }}
          </option>
        </Select>
      </InheritedField>

      <InheritedField
        v-model:overridden="draft.priority.overridden"
        label="Priority"
        :inherited="inherited?.priority === null ? null : String(inherited?.priority)"
      >
        <Input v-model="draft.priority.value" type="number" data-testid="task-priority" />
      </InheritedField>

      <InheritedField
        v-model:overridden="draft.due.overridden"
        label="Due"
        :inherited="displayDue(inherited?.due ?? null)"
        :hint="`Local to ${timeZone}. A hard due date is enforced; a soft one warns.`"
        class="sm:col-span-2"
      >
        <div class="flex flex-wrap items-center gap-2">
          <input
            v-model="draft.due.value"
            type="datetime-local"
            class="border-input bg-background focus-visible:ring-ring h-9 rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            aria-label="Due date and time"
            data-testid="task-due"
          />
          <Select v-model="draft.due.kind" class="h-9 w-32" data-testid="task-due-kind">
            <option value="soft">Soft</option>
            <option value="hard">Hard</option>
          </Select>
        </div>
        <p v-if="dueConflict" class="text-destructive text-sm" data-testid="due-conflict">
          {{ dueConflict }}
        </p>
      </InheritedField>

      <InheritedField
        v-model:overridden="draft.preferred.overridden"
        label="Preferred time"
        :inherited="
          displayRange(inherited?.preferredStart ?? null, inherited?.preferredEnd ?? null)
        "
      >
        <div class="flex items-center gap-2">
          <input
            v-model="draft.preferred.start"
            type="time"
            class="border-input bg-background h-9 rounded-md border px-2 text-sm"
            aria-label="Preferred start"
            data-testid="task-preferred-start"
          />
          <span class="text-muted-foreground text-sm">to</span>
          <input
            v-model="draft.preferred.end"
            type="time"
            class="border-input bg-background h-9 rounded-md border px-2 text-sm"
            aria-label="Preferred end"
            data-testid="task-preferred-end"
          />
        </div>
      </InheritedField>

      <InheritedField
        v-model:overridden="draft.focus.overridden"
        label="Focus level"
        :inherited="inherited?.focus === null ? null : String(inherited?.focus)"
        hint="Matched against a window's focus profile."
      >
        <Select v-model="draft.focus.value" data-testid="task-focus">
          <option v-for="level in 5" :key="level" :value="String(level)">{{ level }}</option>
        </Select>
      </InheritedField>

      <InheritedField
        v-model:overridden="draft.cooldown.overridden"
        label="Cooldown (minutes)"
        :inherited="inherited?.cooldown === null ? null : String(inherited?.cooldown)"
        hint="Overrides the category default. Non-compressible."
      >
        <Input v-model="draft.cooldown.value" type="number" min="0" data-testid="task-cooldown" />
      </InheritedField>
    </div>

    <section class="space-y-2 border-t pt-4" data-testid="recurrence-field">
      <div class="flex items-center justify-between gap-3">
        <Label>Repeats</Label>
        <label class="text-muted-foreground flex items-center gap-2 text-xs">
          <span>Recurring</span>
          <Switch
            v-model="draft.recurrence.on"
            aria-label="This task recurs"
            data-testid="recurrence-toggle"
          />
        </label>
      </div>

      <template v-if="draft.recurrence.on">
        <div class="flex flex-wrap items-center gap-2">
          <Input
            v-model="draft.recurrence.count"
            type="number"
            min="1"
            class="w-20"
            aria-label="Times per period"
            data-testid="recurrence-count"
          />
          <span class="text-muted-foreground text-sm">times per</span>
          <Select
            v-model="draft.recurrence.period"
            class="w-32"
            aria-label="Period"
            data-testid="recurrence-period"
          >
            <option value="day">day</option>
            <option value="week">week</option>
            <option value="month">month</option>
          </Select>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <span class="text-muted-foreground text-sm">If a period is missed:</span>
          <Select
            v-model="draft.recurrence.missedPolicy"
            class="w-44"
            aria-label="Missed period policy"
            data-testid="recurrence-missed"
          >
            <option value="rollover">carry it over</option>
            <option value="expire">let it go</option>
          </Select>
        </div>

        <p class="text-muted-foreground text-xs">
          This is a demand rule, not a time: each period gets that many occurrences, scheduled
          wherever they fit inside it. A recurring <em>appointment</em> is a different thing and
          repeats at a fixed time.
        </p>
      </template>
    </section>

    <div class="flex flex-wrap items-center gap-2">
      <Button :disabled="!canSave" data-testid="save-task" @click="save">
        {{ isCreate ? 'Create task' : 'Save task' }}
      </Button>
      <Button variant="ghost" :disabled="busy" data-testid="cancel-edit" @click="emit('cancel')">
        Cancel
      </Button>

      <template v-if="task && task.status === 'active'">
        <span class="grow" />
        <Button variant="outline" :disabled="busy" data-testid="complete-task" @click="complete">
          Complete
        </Button>
        <Button variant="ghost" :disabled="busy" data-testid="delete-task" @click="cancelTask">
          Cancel task
        </Button>
      </template>
    </div>
  </section>
</template>

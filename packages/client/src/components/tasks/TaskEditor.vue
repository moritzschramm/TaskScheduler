<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import InheritedField from './InheritedField.vue';
import { FOCUS_LEVELS, focusLabel } from '@/lib/focus';
import { formatMinuteOfDay, fromLocalInput, parseMinuteOfDay, toLocalInput } from '@/lib/time';
import type { ActivityType, CommandRequest, TaskNode } from '@ambitime/shared';

const { t } = useI18n();

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
  activityTypes: ActivityType[];
  timeZone: string;
  /**
   * The hour a new task was started from, as §4.4's preferred range.
   *
   * Only ever seeds a *new* task: an existing one's range is its own, and a
   * form that overwrote it with wherever the user happened to click would be
   * editing a field nobody touched.
   */
  defaultPreferred?: { startMin: number; endMin: number } | undefined;
  submit: (request: CommandRequest) => Promise<boolean>;
}>();

/**
 * `saved` is separate from `cancel` because the caller does different things
 * with them — and because a modal that stayed open after a successful save
 * left its overlay across the whole page with no obvious way past it. Found by
 * driving the real browser; nothing in the suite was looking at what the
 * editor did *after* the command landed.
 */
const emit = defineEmits<{ cancel: []; saved: [] }>();

interface Draft {
  title: string;
  notes: string;
  estimate: string;
  /**
   * The chosen activity type id, or `''` meaning "whatever an ancestor supplies".
   *
   * Not an `{ overridden, value }` pair like its neighbours, because an activity type
   * is not optional: §6.2 rule 1 makes it the thing that decides whether a task
   * can be placed at all, so there is no third "unset" state to express and no
   * switch is needed to reach it. Inheriting is still expressible — it is the
   * empty option, offered only when there is in fact something to inherit.
   */
  activityType: string;
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
    // Inherit where there is something to inherit; otherwise the first
    // activity type, because a new task must have one and picking the only sensible
    // default is better than presenting an empty box that refuses to save.
    activityType:
      props.parent?.effectiveActivityTypeId == null ? (props.activityTypes[0]?.id ?? '') : '',
    priority: { overridden: false, value: '' },
    due: { overridden: false, value: '', kind: 'soft' },
    // Overridden when it came from a click on the grid: the user pointed at an
    // hour, which is a statement about this task rather than an inheritance.
    preferred: {
      overridden: props.defaultPreferred !== undefined,
      start: formatMinuteOfDay(props.defaultPreferred?.startMin ?? 9 * 60),
      end: formatMinuteOfDay(props.defaultPreferred?.endMin ?? 17 * 60),
    },
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
      // Its own, or empty for "inherited" — the same two states the select
      // offers, so what is on screen is what will be sent.
      activityType: task.ownActivityTypeId ?? '',
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

const activityTypeName = (id: string | null): string | null =>
  id === null
    ? null
    : (props.activityTypes.find((activityType) => activityType.id === id)?.name ?? id);

/** What an ancestor supplies for each field, for the "Inherited: …" line. */
const inherited = computed(() => {
  const source = props.task ?? props.parent;
  if (source === null) return null;

  // For a task, the inherited value is what it *would* fall back to — which is
  // its effective value whenever that is not its own.
  const from = <T,>(own: T | null, effective: T | null): T | null =>
    props.task === null ? effective : own === null ? effective : null;

  return {
    activityType: activityTypeName(from(source.ownActivityTypeId, source.effectiveActivityTypeId)),
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

/**
 * What this task's activity type would be if it set none of its own (§4.4).
 *
 * The parent's *effective* value, so a grandparent's activity type binds through a
 * parent that has none — which is what nearest-ancestor-wins means.
 */
const inheritedActivityTypeId = computed(() => {
  // Creating: the container decides what a new child would fall back to.
  if (props.parent !== null) return props.parent.effectiveActivityTypeId;

  // Editing: what this task falls back to is its effective value, but only
  // where that is not its own — the same distinction `inherited` draws for
  // every other property.
  const task = props.task;
  return task !== null && task.ownActivityTypeId === null ? task.effectiveActivityTypeId : null;
});

/**
 * Every task needs an activity type, but not every task needs its *own* (§4.4, §6.2).
 *
 * The rule the engine enforces is that a leaf has an **effective** activity type,
 * because without one no availability window applies to it and it is never
 * offered to the solver at all — it simply disappears, which is the bug this
 * form now refuses to create. Inheritance still satisfies it: a subtask under a
 * categorised parent is already covered, and demanding its own would make
 * §4.4's whole mechanism unusable in the one place it is most useful.
 */
const effectiveActivityTypeId = computed(
  () => draft.value.activityType || inheritedActivityTypeId.value,
);

/** The parent's activity type, named, for the "same as" option. */
const inheritedActivityTypeName = computed(() => activityTypeName(inheritedActivityTypeId.value));

const canSave = computed(
  () =>
    draft.value.title.trim() !== '' &&
    effectiveActivityTypeId.value !== null &&
    dueConflict.value === null &&
    !busy.value,
);

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
    if (!applied) return;

    if (isCreate.value) draft.value = emptyDraft();
    emit('saved');
  } finally {
    busy.value = false;
  }
}

function createRequest(): CommandRequest {
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
      ...(draft.value.activityType === '' ? {} : { activityTypeId: draft.value.activityType }),
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
  return {
    type: 'EditTask',
    expectedVersion: props.task!.version,
    params: {
      taskId: props.task!.id,
      patch: {
        title: draft.value.title,
        notes: draft.value.notes === '' ? null : draft.value.notes,
        // `null` clears the override and reverts to the inherited value (§4.4).
        activityTypeId: draft.value.activityType === '' ? null : draft.value.activityType,
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
        {{
          isCreate ? (parent ? t('editor.newSubtask') : t('editor.newTask')) : t('editor.editTask')
        }}
      </h2>
      <p v-if="parent" class="text-muted-foreground text-sm" data-testid="editor-parent">
        {{ t('editor.inside', { title: parent.title }) }}
      </p>
      <p v-if="task && !task.isLeaf" class="text-muted-foreground text-sm">
        {{ t('editor.hasChildren') }}
      </p>
    </header>

    <div class="grid gap-4 sm:grid-cols-2">
      <div class="space-y-1 sm:col-span-2">
        <Label for="task-title">{{ t('common.title') }}</Label>
        <Input id="task-title" v-model="draft.title" data-testid="task-title" />
      </div>

      <div class="space-y-1 sm:col-span-2">
        <Label for="task-notes">{{ t('common.notes') }}</Label>
        <textarea
          id="task-notes"
          v-model="draft.notes"
          rows="3"
          class="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-16 w-full resize-y rounded-md border px-3 py-2 text-sm shadow-xs transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
          data-testid="task-notes"
        />
      </div>

      <div class="space-y-1">
        <Label for="task-estimate">{{ t('editor.estimate') }}</Label>
        <Input
          id="task-estimate"
          v-model="draft.estimate"
          type="number"
          min="1"
          data-testid="task-estimate"
        />
      </div>
    </div>

    <div class="grid gap-5 sm:grid-cols-2">
      <!--
        No override toggle: an activity type is not one of §4.4's three-state
        properties in practice, because "unset" is not a state a task may be
        saved in. Inheriting is still reachable — it is the first option, and it
        appears only when there is an ancestor to inherit from.
      -->
      <div class="space-y-1.5" data-testid="field-activity-type">
        <Label for="task-activity-type">{{ t('editor.activityType') }}</Label>
        <Select
          id="task-activity-type"
          v-model="draft.activityType"
          :aria-invalid="effectiveActivityTypeId === null ? 'true' : undefined"
          data-testid="task-activity-type"
        >
          <option v-if="inheritedActivityTypeId !== null" value="">
            <template v-if="parent">{{
              t('editor.sameAsParent', { title: parent.title })
            }}</template>
            <template v-else>{{ t('editor.inherited') }}</template>
            ({{ inheritedActivityTypeName }})
          </option>
          <option
            v-for="activityType in activityTypes"
            :key="activityType.id"
            :value="activityType.id"
          >
            {{ activityType.name }}
          </option>
        </Select>
        <p
          v-if="activityTypes.length === 0"
          class="text-muted-foreground text-xs"
          data-testid="no-activity-types-yet"
        >
          {{ t('editor.noneYet') }}
          <RouterLink class="underline underline-offset-4" to="/activity-types">
            {{ t('editor.addOne') }}
          </RouterLink>
          {{ t('editor.cannotSchedule') }}
        </p>
      </div>

      <InheritedField
        v-model:overridden="draft.focus.overridden"
        field="focus-level"
        :label="t('editor.focusLabel')"
        :inherited="inherited?.focus == null ? null : focusLabel(inherited.focus)"
        :hint="t('editor.focusHint')"
      >
        <Select
          v-model="draft.focus.value"
          :aria-label="t('editor.focus')"
          data-testid="task-focus"
        >
          <option v-for="level in FOCUS_LEVELS" :key="level.value" :value="String(level.value)">
            {{ t(level.label) }}
          </option>
        </Select>
      </InheritedField>

      <InheritedField
        v-model:overridden="draft.priority.overridden"
        field="priority"
        :label="t('editor.priorityLabel')"
        :inherited="inherited?.priority == null ? null : String(inherited.priority)"
      >
        <Input
          v-model="draft.priority.value"
          type="number"
          :aria-label="t('editor.priority')"
          data-testid="task-priority"
        />
      </InheritedField>

      <InheritedField
        v-model:overridden="draft.cooldown.overridden"
        field="cooldown-(minutes)"
        :label="t('editor.cooldownLabel')"
        :inherited="inherited?.cooldown == null ? null : String(inherited.cooldown)"
        :hint="t('editor.cooldownHint')"
      >
        <Input
          v-model="draft.cooldown.value"
          type="number"
          min="0"
          :aria-label="t('editor.cooldown')"
          data-testid="task-cooldown"
        />
      </InheritedField>
      <InheritedField
        v-model:overridden="draft.due.overridden"
        field="due"
        :label="t('editor.dueLabel')"
        :inherited="displayDue(inherited?.due ?? null)"
        :hint="t('editor.dueHint', { zone: timeZone })"
      >
        <div class="flex flex-wrap items-center gap-2">
          <input
            v-model="draft.due.value"
            type="datetime-local"
            class="border-input bg-background focus-visible:ring-ring h-9 rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            :aria-label="t('editor.due')"
            data-testid="task-due"
          />
          <Select
            v-model="draft.due.kind"
            class="h-9 w-32"
            :aria-label="t('editor.dueKind')"
            data-testid="task-due-kind"
          >
            <option value="soft">{{ t('editor.soft') }}</option>
            <option value="hard">{{ t('editor.hard') }}</option>
          </Select>
        </div>
        <p v-if="dueConflict" class="text-destructive text-sm" data-testid="due-conflict">
          {{ dueConflict }}
        </p>
      </InheritedField>

      <InheritedField
        v-model:overridden="draft.preferred.overridden"
        field="preferred-time"
        :label="t('editor.preferredLabel')"
        :inherited="
          displayRange(inherited?.preferredStart ?? null, inherited?.preferredEnd ?? null)
        "
      >
        <div class="flex items-center gap-2">
          <input
            v-model="draft.preferred.start"
            type="time"
            class="border-input bg-background h-9 rounded-md border px-2 text-sm"
            :aria-label="t('editor.preferredStart')"
            data-testid="task-preferred-start"
          />
          <span class="text-muted-foreground text-sm">to</span>
          <input
            v-model="draft.preferred.end"
            type="time"
            class="border-input bg-background h-9 rounded-md border px-2 text-sm"
            :aria-label="t('editor.preferredEnd')"
            data-testid="task-preferred-end"
          />
        </div>
      </InheritedField>
    </div>

    <section class="space-y-2 border-t pt-4" data-testid="recurrence-field">
      <div class="flex items-center justify-between gap-3">
        <Label>{{ t('editor.repeats') }}</Label>
        <label class="text-muted-foreground flex items-center gap-2 text-xs">
          <span>{{ t('editor.recurring') }}</span>
          <Switch
            v-model="draft.recurrence.on"
            :aria-label="t('editor.thisRecurs')"
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
            :aria-label="t('editor.timesPerPeriod')"
            data-testid="recurrence-count"
          />
          <span class="text-muted-foreground text-sm">{{ t('editor.timesPer') }}</span>
          <Select
            v-model="draft.recurrence.period"
            class="w-32"
            :aria-label="t('editor.period')"
            data-testid="recurrence-period"
          >
            <option value="day">{{ t('editor.day') }}</option>
            <option value="week">{{ t('editor.week') }}</option>
            <option value="month">{{ t('editor.month') }}</option>
          </Select>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <span class="text-muted-foreground text-sm">{{ t('editor.ifMissed') }}</span>
          <Select
            v-model="draft.recurrence.missedPolicy"
            class="w-44"
            :aria-label="t('editor.missedPolicy')"
            data-testid="recurrence-missed"
          >
            <option value="rollover">{{ t('editor.rollover') }}</option>
            <option value="expire">{{ t('editor.expire') }}</option>
          </Select>
        </div>

        <p class="text-muted-foreground text-xs">
          {{ t('editor.demandNote') }}
        </p>
      </template>
    </section>

    <!--
      Whatever else the modal wants under the form — §7.3's manual actions, for
      a task that has a placement to act on. It goes here rather than after the
      editor so that the buttons below stay the last thing in the dialog, which
      is the whole point of them being where they are.
    -->
    <slot />

    <!--
      The four decisions, kept on screen while the form scrolls under them.

      A task's form is long: nine properties, an override switch on most of
      them, a recurrence rule. Saving meant scrolling past all of it to reach a
      button, and cancelling — the thing you want most when you have opened the
      wrong task — meant the same journey.

      Sticky rather than a bar outside the scroller, because the dialog *is*
      the scroller: this way the buttons are still the end of the form, in
      source order, so tab order and a screen reader meet them where they
      belong.

      All three negative offsets hand back the dialog's own padding, and each
      is load-bearing. `-mx-6` spans the bar across the full width. `-mb-6`
      puts its resting place flush with the bottom edge, so it does not jump
      when the scroll runs out. `-bottom-6` is the one that is easy to miss: a
      sticky offset is measured from the scrollport *inset by the padding*, so
      `bottom-0` pins the bar twenty-four pixels up and leaves a strip of the
      form sliding through underneath it.
    -->
    <div
      class="bg-card sticky -bottom-6 -mx-6 -mb-6 flex flex-wrap items-center gap-2 border-t px-6 py-4"
      data-testid="task-editor-actions"
    >
      <Button :disabled="!canSave" data-testid="save-task" @click="save">
        {{ isCreate ? t('editor.createTask') : t('editor.saveTask') }}
      </Button>
      <Button variant="ghost" :disabled="busy" data-testid="cancel-edit" @click="emit('cancel')">
        {{ t('common.cancel') }}
      </Button>

      <template v-if="task && task.status === 'active'">
        <span class="grow" />
        <Button variant="outline" :disabled="busy" data-testid="complete-task" @click="complete">
          {{ t('editor.complete') }}
        </Button>
        <Button variant="ghost" :disabled="busy" data-testid="delete-task" @click="cancelTask">
          {{ t('editor.cancelTask') }}
        </Button>
      </template>
    </div>
  </section>
</template>

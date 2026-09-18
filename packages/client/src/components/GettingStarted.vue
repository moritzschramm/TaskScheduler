<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '@/i18n';
import { uuidv7 } from '@ambitime/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { browserZone } from '@/lib/zones';
import { createdId, runCommand } from '@/lib/commands';
import { useWorkspace } from '@/lib/workspace';

const { t } = useI18n();

/**
 * The first thing a new account is asked for (spec §4.3, §6.2 rule 1).
 *
 * **It used to ask for a calendar, and that was the wrong question.** A planner
 * is a container; on its own it schedules nothing, so answering it left the
 * user on an empty grid with no idea what was still missing. What is actually
 * required is an activity type and some hours — "a task is placed within an
 * availability window of its activity type" — so that is what this asks for, and the
 * planner is created underneath as a consequence rather than as a prerequisite.
 *
 * Three commands in one group (§7.5), so undo takes back the whole beginning
 * rather than leaving a planner with an activity type and no hours — which is exactly
 * the half-configured state this screen exists to prevent.
 *
 * **And then a second question, about shape.** The first screen used to stop at
 * "you have hours", which leaves the one other structuring idea in the model —
 * that a task with tasks under it is a project, and they inherit its priority,
 * its deadline and its preferred times (§4.4) — to be discovered from a button
 * marked "Break up" on a row somebody has not written yet. This is the only
 * moment the application has anyone's attention on how their work is arranged,
 * so it asks once, and skipping is a button rather than a shrug.
 *
 * It asks for the first task inside the project as well, and will not make one
 * without it. A container with no children is a leaf with no estimate, which is
 * §6.7's `no_duration` — so a well-meant empty project would greet a brand-new
 * account with a warning about itself.
 */
const { calendars, load } = useWorkspace();

const WEEKDAYS = [
  { value: 1, label: 'Mon' },
  { value: 2, label: 'Tue' },
  { value: 3, label: 'Wed' },
  { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' },
  { value: 6, label: 'Sat' },
  { value: 7, label: 'Sun' },
] as const;

const name = ref('Work');
const days = ref<number[]>([1, 2, 3, 4, 5]);
const startTime = ref('09:00');
const endTime = ref('17:00');
const busy = ref(false);
const error = ref<string | null>(null);

/** 1 asks for the hours, 2 for the shape. */
const step = ref<1 | 2>(1);
const projectName = ref('');
const firstTask = ref('');
const firstEstimate = ref('60');

/**
 * What step 1 made, kept for step 2.
 *
 * `load()` is deliberately not called between the two: this whole screen is
 * rendered only while the account has no planner and no activity type, so
 * refreshing the workspace after step 1 would unmount the component in the
 * middle of its own flow.
 */
const made = ref<{ calendarId: string; activityTypeId: string } | null>(null);

const canFinish = computed(
  () =>
    projectName.value.trim() !== '' &&
    firstTask.value.trim() !== '' &&
    Number(firstEstimate.value) > 0 &&
    !busy.value,
);

const minutes = (value: string): number => {
  const [hours, mins] = value.split(':').map(Number);
  return (hours ?? 0) * 60 + (mins ?? 0);
};

const canSubmit = computed(
  () =>
    name.value.trim() !== '' &&
    days.value.length > 0 &&
    minutes(startTime.value) < minutes(endTime.value) &&
    !busy.value,
);

function toggle(weekday: number): void {
  days.value = days.value.includes(weekday)
    ? days.value.filter((day) => day !== weekday)
    : [...days.value, weekday];
}

function failed(cause: unknown): void {
  error.value =
    cause instanceof ApiError
      ? cause.message
      : cause instanceof Error
        ? cause.message
        : t('errors.setup');
}

async function begin(): Promise<void> {
  busy.value = true;
  error.value = null;
  const groupId = uuidv7();

  try {
    // One planner is enough for most people, and somebody who wants a second
    // can say so in settings. Naming it here would be one more question before
    // the first useful answer.
    const calendarId =
      calendars.value[0]?.id ??
      createdId(
        await runCommand({
          type: 'CreateCalendar',
          groupId,
          params: { name: 'Personal', timezone: browserZone() },
        }),
        'calendar',
      );

    const activityTypeId = createdId(
      await runCommand({
        type: 'CreateActivityType',
        groupId,
        params: { name: name.value.trim() },
      }),
      'activity_type',
    );

    await runCommand({
      type: 'SetAvailabilityWindows',
      groupId,
      params: {
        calendarId,
        activityTypeId,
        windows: [...days.value]
          .sort((a, b) => a - b)
          .map((weekday) => ({
            weekday,
            startMin: minutes(startTime.value),
            endMin: minutes(endTime.value),
          })),
      },
    });

    made.value = { calendarId, activityTypeId };
    step.value = 2;
  } catch (cause) {
    failed(cause);
  } finally {
    busy.value = false;
  }
}

/**
 * The project and the first thing in it, as one group (§7.5).
 *
 * The child carries the estimate and the parent carries none: only leaves are
 * placed (§4.4), so an estimate on the container would be a number that never
 * becomes time on the grid. The activity type is set on the parent alone, and
 * the child inherits it — which is the inheritance this step exists to show.
 */
async function finish(): Promise<void> {
  const setup = made.value;
  if (setup === null || !canFinish.value) return;

  busy.value = true;
  error.value = null;
  const groupId = uuidv7();

  try {
    const parentId = createdId(
      await runCommand({
        type: 'CreateTask',
        groupId,
        params: {
          calendarId: setup.calendarId,
          title: projectName.value.trim(),
          activityTypeId: setup.activityTypeId,
        },
      }),
      'task',
    );

    await runCommand({
      type: 'CreateTask',
      groupId,
      params: {
        calendarId: setup.calendarId,
        title: firstTask.value.trim(),
        parentId,
        estimatedDurationMin: Number(firstEstimate.value),
      },
    });

    await load();
  } catch (cause) {
    failed(cause);
    busy.value = false;
  }
}

async function skip(): Promise<void> {
  busy.value = true;
  await load();
}
</script>

<template>
  <section class="max-w-prose space-y-5" data-testid="getting-started">
    <header class="space-y-2">
      <h2 class="text-lg font-semibold">
        {{ step === 1 ? t('gettingStarted.title') : t('gettingStarted.projectTitle') }}
      </h2>
      <p class="text-muted-foreground text-sm">
        {{
          step === 1
            ? t('gettingStarted.lead', { kind: t('gettingStarted.kindWord') })
            : t('gettingStarted.projectLead')
        }}
      </p>
    </header>

    <template v-if="step === 1">
      <div class="space-y-1">
        <Label for="first-activity-type">{{ t('gettingStarted.nameLabel') }}</Label>
        <Input
          id="first-activity-type"
          v-model="name"
          :placeholder="t('gettingStarted.namePlaceholder')"
          data-testid="first-activity-type-name"
        />
      </div>

      <fieldset class="space-y-2">
        <legend class="text-sm font-medium">{{ t('gettingStarted.daysLabel') }}</legend>
        <div class="flex flex-wrap gap-2">
          <label
            v-for="day in WEEKDAYS"
            :key="day.value"
            class="flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-sm"
            :class="days.includes(day.value) ? 'bg-secondary border-foreground/20' : ''"
          >
            <input
              type="checkbox"
              class="accent-primary"
              :checked="days.includes(day.value)"
              :data-testid="`first-weekday-${day.value}`"
              @change="toggle(day.value)"
            />
            {{ day.label }}
          </label>
        </div>
      </fieldset>

      <div class="flex flex-wrap items-end gap-3">
        <div class="space-y-1">
          <Label for="first-start">{{ t('common.from') }}</Label>
          <Input id="first-start" v-model="startTime" type="time" data-testid="first-start" />
        </div>
        <div class="space-y-1">
          <Label for="first-end">{{ t('common.until') }}</Label>
          <Input id="first-end" v-model="endTime" type="time" data-testid="first-end" />
        </div>
      </div>
    </template>

    <template v-else>
      <div class="space-y-1">
        <Label for="first-project">{{ t('gettingStarted.projectLabel') }}</Label>
        <Input
          id="first-project"
          v-model="projectName"
          :placeholder="t('gettingStarted.projectPlaceholder')"
          data-testid="first-project-name"
        />
      </div>

      <div class="flex flex-wrap items-end gap-3">
        <div class="grow space-y-1">
          <Label for="first-task">{{ t('gettingStarted.firstTaskLabel') }}</Label>
          <Input
            id="first-task"
            v-model="firstTask"
            :placeholder="t('gettingStarted.firstTaskPlaceholder')"
            data-testid="first-task-title"
          />
        </div>
        <div class="space-y-1">
          <Label for="first-estimate">{{ t('gettingStarted.minutesLabel') }}</Label>
          <Input
            id="first-estimate"
            v-model="firstEstimate"
            type="number"
            min="1"
            class="w-24"
            data-testid="first-task-estimate"
          />
        </div>
      </div>
    </template>

    <p
      v-if="error"
      class="text-destructive text-sm"
      role="alert"
      data-testid="getting-started-error"
    >
      {{ error }}
    </p>

    <div class="flex flex-wrap items-center gap-2">
      <Button v-if="step === 1" :disabled="!canSubmit" data-testid="begin" @click="begin">
        {{ busy ? `${t('gettingStarted.begin')}…` : t('gettingStarted.begin') }}
      </Button>
      <template v-else>
        <Button :disabled="!canFinish" data-testid="finish" @click="finish">
          {{ t('gettingStarted.finish') }}
        </Button>
        <!--
          A button rather than a shrug. Somebody who does not want a project yet
          should be able to say so and land on the grid, and leaving them to
          find the way out is how a two-step form becomes a trap.
        -->
        <Button variant="ghost" :disabled="busy" data-testid="skip" @click="skip">
          {{ t('gettingStarted.skip') }}
        </Button>
      </template>
    </div>
  </section>
</template>

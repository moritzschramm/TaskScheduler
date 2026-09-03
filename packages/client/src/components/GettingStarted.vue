<script setup lang="ts">
import { computed, ref } from 'vue';
import { uuidv7 } from '@ambitime/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api';
import { browserZone } from '@/lib/zones';
import { createdId, runCommand } from '@/lib/commands';
import { useWorkspace } from '@/lib/workspace';

/**
 * The first thing a new account is asked for (spec §4.3, §6.2 rule 1).
 *
 * **It used to ask for a calendar, and that was the wrong question.** A planner
 * is a container; on its own it schedules nothing, so answering it left the
 * user on an empty grid with no idea what was still missing. What is actually
 * required is a category and some hours — "a task is placed within an
 * availability window of its category" — so that is what this asks for, and the
 * planner is created underneath as a consequence rather than as a prerequisite.
 *
 * Three commands in one group (§7.5), so undo takes back the whole beginning
 * rather than leaving a planner with a category and no hours — which is exactly
 * the half-configured state this screen exists to prevent.
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

    const categoryId = createdId(
      await runCommand({
        type: 'CreateCategory',
        groupId,
        params: { name: name.value.trim() },
      }),
      'category',
    );

    await runCommand({
      type: 'SetAvailabilityWindows',
      groupId,
      params: {
        calendarId,
        categoryId,
        windows: [...days.value]
          .sort((a, b) => a - b)
          .map((weekday) => ({
            weekday,
            startMin: minutes(startTime.value),
            endMin: minutes(endTime.value),
          })),
      },
    });

    await load();
  } catch (cause) {
    error.value =
      cause instanceof ApiError
        ? cause.message
        : cause instanceof Error
          ? cause.message
          : 'That could not be set up';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="max-w-prose space-y-5" data-testid="getting-started">
    <header class="space-y-2">
      <h2 class="text-lg font-semibold">Let's find some time.</h2>
      <p class="text-muted-foreground text-sm">
        Tasks are scheduled into the hours you set aside for a <em>kind</em> of activity. Name your
        first one and say when you are free for it — you can add more, and change these, later.
      </p>
    </header>

    <div class="space-y-1">
      <Label for="first-category">What kind of activity?</Label>
      <Input
        id="first-category"
        v-model="name"
        placeholder="Work"
        data-testid="first-category-name"
      />
    </div>

    <fieldset class="space-y-2">
      <legend class="text-sm font-medium">On which days?</legend>
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
        <Label for="first-start">From</Label>
        <Input id="first-start" v-model="startTime" type="time" data-testid="first-start" />
      </div>
      <div class="space-y-1">
        <Label for="first-end">Until</Label>
        <Input id="first-end" v-model="endTime" type="time" data-testid="first-end" />
      </div>
    </div>

    <p
      v-if="error"
      class="text-destructive text-sm"
      role="alert"
      data-testid="getting-started-error"
    >
      {{ error }}
    </p>

    <Button :disabled="!canSubmit" data-testid="begin" @click="begin">
      {{ busy ? 'Setting up…' : 'Start scheduling' }}
    </Button>
  </section>
</template>

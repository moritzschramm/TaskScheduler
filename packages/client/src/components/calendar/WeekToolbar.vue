<script setup lang="ts">
import { Button } from '@/components/ui/button';
import DayRangeSlider from '@/components/calendar/DayRangeSlider.vue';
import { formatMonth } from '@/lib/month';
import UndoRedo from '@/components/UndoRedo.vue';
import { useWorkspace } from '@/lib/workspace';

/**
 * The controls that belong to the week rather than to what is drawn on it.
 *
 * Schedule and Appointments draw the same days, so both need the same picker,
 * the same zone caption and the same pair of arrows. They share the workspace's
 * anchor, which is what makes paging on one screen and switching to the other
 * land on the week you were looking at.
 *
 * The week/month switch is here for the same reason: it changes how the days
 * are drawn, not what is on them, so it belongs with the controls that move
 * between days rather than inside either grid.
 */
defineProps<{ title: string }>();

const {
  calendars,
  selectedId,
  calendar,
  zone,
  locale,
  month,
  mode,
  setMode,
  history,
  submit,
  shiftWeek,
  shiftMonths,
} = useWorkspace();

/** Paging means a week or a month depending on what is drawn. */
function shift(steps: number): void {
  if (mode.value === 'month') shiftMonths(steps);
  else shiftWeek(steps);
}
</script>

<template>
  <header class="flex flex-wrap items-center justify-between gap-4">
    <div class="flex items-center gap-3">
      <h1 class="text-xl font-semibold tracking-tight">{{ title }}</h1>
      <select
        v-if="calendars.length > 1"
        v-model="selectedId"
        class="border-input bg-background rounded-md border px-2 py-1 text-sm"
        data-testid="calendar-select"
      >
        <option v-for="entry in calendars" :key="entry.id" :value="entry.id">
          {{ entry.name }}
        </option>
      </select>
      <span v-if="calendar" class="text-muted-foreground text-xs" data-testid="calendar-zone">
        {{ zone }}
        <template v-if="zone !== calendar.timezone">
          <!--
            Said out loud when the two differ: the grid is in your zone, but
            this calendar's availability windows are wall-clock rules in its
            own (§5.1), so "09:00 Monday" means something different to the
            scheduler than the row you are looking at.
          -->
          <span data-testid="zone-divergence">(planner is {{ calendar.timezone }})</span>
        </template>
      </span>
      <!--
        Hidden in month view rather than disabled: it crops the hours a day
        shows, and a month draws no hours at all. A control that visibly does
        nothing is worse than one that is not there.
      -->
      <DayRangeSlider v-if="calendar && mode === 'week'" />
      <span
        v-else-if="calendar"
        class="text-muted-foreground text-sm tabular-nums"
        data-testid="month-label"
      >
        {{ formatMonth(month, locale) }}
      </span>
    </div>

    <div class="flex items-center gap-2">
      <!-- Whatever this screen makes: a task, or a block of fixed time. -->
      <slot name="actions" />

      <!--
        Two buttons rather than a dropdown. There are exactly two, both are
        one word, and a select would hide the option you are not in behind a
        click for no saving of space.
      -->
      <div class="bg-muted flex rounded-md p-0.5" role="group" aria-label="Calendar view">
        <button
          v-for="option in ['week', 'month'] as const"
          :key="option"
          type="button"
          class="rounded px-2.5 py-1 text-sm capitalize"
          :class="mode === option ? 'bg-background shadow-sm font-medium' : 'text-muted-foreground'"
          :aria-pressed="mode === option"
          :data-testid="`view-${option}`"
          @click="setMode(option)"
        >
          {{ option }}
        </button>
      </div>

      <UndoRedo :history="history" :submit="submit" />
      <Button variant="outline" size="sm" data-testid="week-back" @click="shift(-1)">
        Previous
      </Button>
      <Button variant="outline" size="sm" data-testid="week-forward" @click="shift(1)">
        Next
      </Button>
    </div>
  </header>
</template>

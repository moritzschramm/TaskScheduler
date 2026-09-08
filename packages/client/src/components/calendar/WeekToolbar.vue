<script setup lang="ts">
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import DisplayOptions from '@/components/calendar/DisplayOptions.vue';
import { formatMonth } from '@/lib/month';
import { useWorkspace } from '@/lib/workspace';
import { ChevronLeft, ChevronRight } from 'lucide-vue-next';

const { t } = useI18n();

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
  locale,
  month,
  mode,
  setMode,
  today,
  shiftWeek,
  shiftMonths,
  showWeekOf,
} = useWorkspace();

/** Paging means a week or a month depending on what is drawn. */
function shift(steps: number): void {
  if (mode.value === 'month') shiftMonths(steps);
  else shiftWeek(steps);
}

/** Back to the week — or month — holding the calendar's own today (§13). */
function showToday(): void {
  if (today.value !== null) showWeekOf(today.value);
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
      <!--
        Which month, when the days on screen are not one week. The week view
        labels its own columns with dates; a month grid shows only day numbers,
        so without this there is nothing on the page naming the month.
      -->
      <span
        v-if="calendar && mode === 'month'"
        class="text-muted-foreground text-sm tabular-nums"
        data-testid="month-label"
      >
        {{ formatMonth(month, locale) }}
      </span>
      <DisplayOptions v-if="calendar" />
    </div>

    <div class="flex items-center gap-2">
      <!-- Whatever this screen makes: a task, or a block of fixed time. -->
      <slot name="actions" />

      <!--
        Two buttons rather than a dropdown. There are exactly two, both are
        one word, and a select would hide the option you are not in behind a
        click for no saving of space.
      -->
      <div class="bg-muted flex rounded-md p-0.5" role="group" :aria-label="t('calendar.view')">
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
          {{ t(`calendar.${option}`) }}
        </button>
      </div>

      <Button variant="outline" size="sm" data-testid="week-back" @click="shift(-1)">
        <ChevronLeft class="size-4" aria-hidden="true" />
        {{ t('common.previous') }}
      </Button>
      <!--
        Between the two arrows, because that is where "back to the middle"
        belongs — and paging a fortnight out is exactly when somebody wants it.
      -->
      <Button variant="outline" size="sm" data-testid="week-today" @click="showToday">
        {{ t('common.today') }}
      </Button>
      <Button variant="outline" size="sm" data-testid="week-forward" @click="shift(1)">
        {{ t('common.next') }}
        <ChevronRight class="size-4" aria-hidden="true" />
      </Button>
    </div>
  </header>
</template>

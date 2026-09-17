<script setup lang="ts">
import { ref } from 'vue';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/i18n';
import DisplayOptions from '@/components/calendar/DisplayOptions.vue';
import { now } from '@/lib/clock';
import { formatMonth } from '@/lib/month';
import { formatCivilDate, formatMinuteOfDay, minuteOfDay } from '@/lib/time';
import { useWorkspace } from '@/lib/workspace';
import { CalendarOff, ChevronLeft, ChevronRight } from 'lucide-vue-next';

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
  notice,
  zone,
  shiftWeek,
  shiftMonths,
  showWeekOf,
  submit,
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

/**
 * "I'm not in today" (spec §7.2), as one button.
 *
 * The gesture used to be a `⊘` in every day heading and every month cell —
 * forty of them on one screen, each one glyph wide, for something a person
 * does when they wake up ill. One button with the word on it is the same
 * command and a tenth of the chrome.
 *
 * It says *today* rather than "the day you last looked at", because a day is
 * only ever blocked out for one reason and that reason is happening now. Other
 * days are still closable, by the two means that were always better at it: an
 * unavailability block on Appointments for an afternoon, a special week for a
 * holiday.
 */
const blocking = ref(false);

async function blockToday(): Promise<void> {
  const day = today.value;
  const calendarId = selectedId.value;
  if (day === null || calendarId === null || blocking.value) return;

  blocking.value = true;
  try {
    const from = minuteOfDay(now().toISOString(), zone.value);
    const applied = await submit({
      type: 'BlockOutDay',
      params: { calendarId, date: formatCivilDate(day) },
    });
    // Whatever week was on screen, the change is on today's. A command whose
    // effect is off-screen reads as a button that did nothing.
    showWeekOf(day);

    // **And it can still be off screen after that.** The day closes from now
    // forward (§7.2), so pressing this late in the evening writes hours the
    // grid's own crop does not reach — the same screen, and a button that
    // appears not to have worked. Said in words, with the hour it starts from,
    // because that is the part a reader cannot infer from a grid they cannot
    // see the change on.
    if (applied) notice.value = t('calendar.blockedToday', { time: formatMinuteOfDay(from) });
  } finally {
    blocking.value = false;
  }
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

      <Button
        v-if="calendar"
        variant="outline"
        size="sm"
        :disabled="today === null || blocking"
        :title="t('calendar.blockTodayHint')"
        data-testid="block-today"
        @click="blockToday"
      >
        <CalendarOff class="size-4" aria-hidden="true" />
        {{ t('calendar.blockToday') }}
      </Button>

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
          :class="mode === option ? 'bg-background shadow-sm font-medium' : 'text-(--ink-subtle)'"
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

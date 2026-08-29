<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { BacklogEntry, CalendarSummary, TaskNode } from '@ambitime/shared';
import type { CivilDate } from '@ambitime/scheduler';
import WeekGrid from '@/components/calendar/WeekGrid.vue';
import BacklogPanel from '@/components/panels/BacklogPanel.vue';
import TaskListPanel from '@/components/panels/TaskListPanel.vue';
import { Button } from '@/components/ui/button';
import {
  fetchBacklog,
  fetchCalendars,
  fetchSchedule,
  fetchTasks,
  type ScheduleView,
} from '@/lib/schedule';
import { now } from '@/lib/clock';
import { addDays, localDate, weekDays } from '@/lib/time';

/**
 * The week view (plan M10) — read-only.
 *
 * Everything drawn here comes from the API's derived reads. The client does not
 * compute a schedule in this milestone; M12 adds the optimistic solve, and
 * doing it early would mean two answers on screen with no way to tell which was
 * authoritative.
 */

const props = withDefaults(defineProps<{ firstDayOfWeek?: number; locale?: string }>(), {
  firstDayOfWeek: 1,
  locale: 'en-GB',
});

const calendars = ref<CalendarSummary[]>([]);
const selectedId = ref<string | null>(null);
const view = ref<ScheduleView | null>(null);
const backlog = ref<BacklogEntry[]>([]);
const tasks = ref<TaskNode[]>([]);
const error = ref<string | null>(null);
const loading = ref(true);

/** The Monday (or configured first day) of the week being shown. */
const anchor = ref<CivilDate | null>(null);

const calendar = computed(() => calendars.value.find((entry) => entry.id === selectedId.value));

const days = computed<CivilDate[]>(() =>
  anchor.value === null ? [] : weekDays(anchor.value, props.firstDayOfWeek),
);

const today = computed<CivilDate | null>(() =>
  calendar.value ? localDate(now().toISOString(), calendar.value.timezone) : null,
);

async function load() {
  loading.value = true;
  error.value = null;

  try {
    calendars.value = await fetchCalendars();
    selectedId.value ??= calendars.value[0]?.id ?? null;

    const id = selectedId.value;
    if (id === null) return;

    const [schedule, entries, taskList] = await Promise.all([
      fetchSchedule(id),
      fetchBacklog(id),
      fetchTasks(id),
    ]);

    view.value = schedule;
    backlog.value = entries;
    tasks.value = taskList;

    // Anchor on the calendar's own today, not the browser's: a Berlin calendar
    // opens on the Berlin week even for a viewer in Lisbon (§13).
    anchor.value ??= today.value;
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'Could not load the schedule';
  } finally {
    loading.value = false;
  }
}

function shiftWeek(weeks: number) {
  if (anchor.value !== null) anchor.value = addDays(anchor.value, weeks * 7);
}

onMounted(load);
watch(selectedId, load);
</script>

<template>
  <div class="flex flex-col gap-6 p-6" data-testid="calendar-view">
    <header class="flex flex-wrap items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-semibold tracking-tight">Schedule</h1>
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
          {{ calendar.timezone }}
        </span>
      </div>

      <div class="flex items-center gap-2">
        <Button variant="outline" size="sm" data-testid="week-back" @click="shiftWeek(-1)">
          Previous
        </Button>
        <Button variant="outline" size="sm" data-testid="week-forward" @click="shiftWeek(1)">
          Next
        </Button>
      </div>
    </header>

    <p v-if="error" class="text-destructive text-sm" data-testid="calendar-error">{{ error }}</p>
    <p v-else-if="loading" class="text-muted-foreground text-sm">Loading the schedule…</p>

    <template v-else-if="view && calendar">
      <WeekGrid
        :days="days"
        :time-zone="calendar.timezone"
        :blocks="view.schedule.blocks"
        :fixed-blocks="view.fixedBlocks"
        :today="today"
        :locale="locale"
      />

      <div class="grid gap-8 lg:grid-cols-[2fr_1fr]">
        <TaskListPanel :tasks="tasks" />
        <BacklogPanel :entries="backlog" />
      </div>
    </template>
  </div>
</template>

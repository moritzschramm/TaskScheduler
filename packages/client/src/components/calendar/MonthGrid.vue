<script setup lang="ts">
import { computed } from 'vue';
import type { CivilDate } from '@ambitime/scheduler';
import type {
  CompletedBlock,
  FixedBlock,
  ScheduledBlock,
  WeekTypeOverrideEntry,
} from '@ambitime/shared';
import { monthWeeks, specialWeekOn, weekdayHeadings, type MonthDay } from '@/lib/month';
import { localDate, sameCivilDate } from '@/lib/time';

/**
 * A month at a glance — what the week grid cannot show (spec §4.3, §6.1).
 *
 * Two things only become visible at this size. **Special weeks**, which are
 * date ranges: a fortnight away is one shaded band here and seven separate
 * paging gestures in the week view, which is why they were so easy to set up
 * wrongly and so hard to notice. And **the shape of the load** — which days are
 * full and which are empty — which is the question somebody asks before
 * deciding what to take on.
 *
 * It deliberately does not draw hours. A month of hour rows is a wall of grey
 * that answers nothing; a count and the first few titles answer the question
 * this view exists for, and the week view is one click away for the rest.
 *
 * **The horizon is marked, and has to be.** Nothing is placed beyond it (§6.1)
 * — it is in the backlog with an estimated week — so the far half of a month
 * is legitimately empty. Unmarked, that reads as "the scheduler has given up",
 * which is the single most alarming way for this screen to be misread.
 */
const props = withDefaults(
  defineProps<{
    month: CivilDate;
    timeZone: string;
    firstDayOfWeek: number;
    locale?: string;
    blocks?: readonly ScheduledBlock[];
    fixedBlocks?: readonly FixedBlock[];
    completedBlocks?: readonly CompletedBlock[];
    specialWeeks?: readonly WeekTypeOverrideEntry[];
    today?: CivilDate | null;
    /** The last day anything can be scheduled on; past it, empty means nothing. */
    horizonEnd?: CivilDate | null;
    /** Whether a day offers "I'm not available" and opens on click. */
    editable?: boolean;
  }>(),
  {
    locale: 'en-GB',
    blocks: () => [],
    fixedBlocks: () => [],
    completedBlocks: () => [],
    specialWeeks: () => [],
    today: null,
    horizonEnd: null,
    editable: false,
  },
);

const emit = defineEmits<{
  /** Jump to the week view on this day. */
  openDay: [day: CivilDate];
  blockDay: [day: CivilDate];
}>();

/** How many titles a cell lists before it starts counting instead. */
const SHOWN_PER_DAY = 3;

interface DayEntry {
  key: string;
  title: string;
  kind: 'task' | 'appointment' | 'unavailability' | 'completed';
}

const weeks = computed(() => monthWeeks(props.month, props.firstDayOfWeek));
const headings = computed(() => weekdayHeadings(props.locale, props.firstDayOfWeek));

/**
 * Everything on a day, in one list keyed by its local date.
 *
 * Built once for the month rather than filtered per cell: a month is up to 42
 * cells and four block lists, and forty-two passes over each of them is the
 * kind of quadratic nobody notices until a calendar with a year of history
 * takes a second to paint.
 */
const byDay = computed(() => {
  const map = new Map<string, DayEntry[]>();

  const add = (iso: string, entry: DayEntry): void => {
    const date = localDate(iso, props.timeZone);
    const key = `${date.year}-${date.month}-${date.day}`;
    const list = map.get(key);
    if (list === undefined) map.set(key, [entry]);
    else list.push(entry);
  };

  for (const block of props.blocks) {
    add(block.start, { key: `t-${block.occurrenceId}`, title: block.title, kind: 'task' });
  }
  for (const block of props.completedBlocks) {
    add(block.start, { key: `c-${block.occurrenceId}`, title: block.title, kind: 'completed' });
  }
  for (const block of props.fixedBlocks) {
    add(block.start, {
      key: `f-${block.appointmentId}-${block.start}`,
      title: block.isUnavailability ? 'Unavailable' : block.title,
      kind: block.isUnavailability ? 'unavailability' : 'appointment',
    });
  }

  return map;
});

function entriesOn(day: MonthDay): DayEntry[] {
  return byDay.value.get(`${day.date.year}-${day.date.month}-${day.date.day}`) ?? [];
}

function isToday(day: MonthDay): boolean {
  return props.today !== null && sameCivilDate(day.date, props.today);
}

/**
 * True once the day is past the point anything could be placed on it.
 *
 * Compared by date rather than by instant: the horizon ends at a moment inside
 * some day, and a cell is either drawn as schedulable or it is not.
 */
function pastHorizon(day: MonthDay): boolean {
  const end = props.horizonEnd;
  if (end === null) return false;
  const asNumber = (date: CivilDate) => date.year * 10000 + date.month * 100 + date.day;
  return asNumber(day.date) > asNumber(end);
}

function classesFor(kind: DayEntry['kind']): string {
  if (kind === 'task') return 'bg-primary/15 text-foreground';
  if (kind === 'completed') return 'bg-primary/[0.06] text-muted-foreground line-through';
  if (kind === 'unavailability') return 'bg-muted-foreground/15 text-muted-foreground';
  return 'bg-secondary text-secondary-foreground';
}

/** The label a cell announces, so the grid reads as a calendar to a screen reader. */
function dayLabel(day: MonthDay): string {
  return new Intl.DateTimeFormat(props.locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(day.date.year, day.date.month - 1, day.date.day)));
}
</script>

<template>
  <div class="overflow-hidden rounded-lg border" data-testid="month-grid">
    <div class="text-muted-foreground grid grid-cols-7 border-b text-xs">
      <div v-for="heading in headings" :key="heading" class="px-2 py-1.5 font-medium">
        {{ heading }}
      </div>
    </div>

    <div
      v-for="(week, row) in weeks"
      :key="row"
      class="grid grid-cols-7 border-b last:border-b-0"
      data-testid="month-week"
    >
      <div
        v-for="day in week"
        :key="day.key"
        class="relative min-h-24 border-r p-1.5 last:border-r-0"
        :class="[
          day.inMonth ? '' : 'bg-muted/30',
          isToday(day) ? 'ring-primary/40 ring-inset ring-2' : '',
        ]"
        data-testid="month-day"
        :data-date="day.key"
        :data-in-month="day.inMonth ? 'true' : 'false'"
      >
        <!--
          The special week is a background rather than a badge. A fortnight away
          is one continuous stretch and the eye reads a run of shaded cells as
          one thing, which is exactly what it is — where a badge per day reads
          as fourteen unrelated notes.
        -->
        <div
          v-if="specialWeekOn(day.date, specialWeeks)"
          class="pointer-events-none absolute inset-0 bg-amber-100/70 dark:bg-amber-900/25"
          data-testid="special-week-shade"
          :data-name="specialWeekOn(day.date, specialWeeks)!.name"
        />

        <div class="relative flex items-start justify-between gap-1">
          <button
            type="button"
            class="hover:underline"
            :class="[
              day.inMonth ? '' : 'text-muted-foreground',
              isToday(day) ? 'text-primary font-semibold' : '',
            ]"
            :aria-label="`Show the week of ${dayLabel(day)}`"
            data-testid="open-day"
            @click="emit('openDay', day.date)"
          >
            <span class="text-sm tabular-nums">{{ day.date.day }}</span>
          </button>

          <button
            v-if="editable"
            type="button"
            class="text-muted-foreground hover:text-foreground px-0.5 leading-none"
            :aria-label="`Block out ${dayLabel(day)}`"
            title="Mark the whole day unavailable — anything scheduled moves"
            data-testid="block-day"
            @click="emit('blockDay', day.date)"
          >
            ⊘
          </button>
        </div>

        <p
          v-if="specialWeekOn(day.date, specialWeeks)"
          class="relative truncate text-[0.65rem] text-amber-900 dark:text-amber-200"
          data-testid="special-week-name"
        >
          {{ specialWeekOn(day.date, specialWeeks)!.name }}
        </p>

        <ul class="relative mt-0.5 space-y-0.5">
          <li
            v-for="entry in entriesOn(day).slice(0, SHOWN_PER_DAY)"
            :key="entry.key"
            class="truncate rounded px-1 py-0.5 text-[0.7rem]"
            :class="classesFor(entry.kind)"
            :data-testid="`month-block-${entry.kind}`"
            :title="entry.title"
          >
            {{ entry.title }}
          </li>
          <li
            v-if="entriesOn(day).length > SHOWN_PER_DAY"
            class="text-muted-foreground px-1 text-[0.7rem]"
            data-testid="month-day-more"
          >
            +{{ entriesOn(day).length - SHOWN_PER_DAY }} more
          </li>
        </ul>

        <!--
          Said once per cell rather than as one note under the grid, because the
          boundary falls mid-month and which side a given day is on is the only
          thing anybody needs to know about it.
        -->
        <span v-if="pastHorizon(day)" class="sr-only" data-testid="past-horizon">
          Beyond the scheduling horizon; work for this day is still in the backlog.
        </span>
      </div>
    </div>
  </div>
</template>

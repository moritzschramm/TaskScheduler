<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '@/i18n';
import type { CivilDate } from '@ambitime/scheduler';
import type {
  CalendarConfiguration,
  CompletedBlock,
  FixedBlock,
  ScheduledBlock,
  WeekTypeOverrideEntry,
} from '@ambitime/shared';
import { monthWeeks, specialWeekOn, weekdayHeadings } from '@/lib/month';
import { formatFullDate, localDate, sameCivilDate } from '@/lib/time';

const { t } = useI18n();

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
    /** Read for one thing only: which colour each activity type draws in. */
    categories?: CalendarConfiguration['categories'];
    specialWeeks?: readonly WeekTypeOverrideEntry[];
    today?: CivilDate | null;
    /** The last day anything can be scheduled on; past it, empty means nothing. */
    horizonEnd?: CivilDate | null;
  }>(),
  {
    locale: 'en-GB',
    blocks: () => [],
    fixedBlocks: () => [],
    completedBlocks: () => [],
    categories: () => [],
    specialWeeks: () => [],
    today: null,
    horizonEnd: null,
  },
);

const emit = defineEmits<{
  /** Jump to the week view on this day. */
  openDay: [day: CivilDate];
}>();

/** How many titles a cell lists before it starts counting instead. */
const SHOWN_PER_DAY = 3;

interface DayEntry {
  key: string;
  title: string;
  kind: 'task' | 'appointment' | 'unavailability' | 'completed';
  /** The palette slot to tint it with, or `null` for the neutral fill. */
  color: string | null;
}

const headings = computed(() => weekdayHeadings(props.locale, props.firstDayOfWeek));

const categoryById = computed(
  () => new Map(props.categories.map((category) => [category.id, category])),
);

function colorOf(categoryId: string | null): string | null {
  return categoryId === null ? null : (categoryById.value.get(categoryId)?.color ?? null);
}

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
    add(block.start, {
      key: `t-${block.occurrenceId}`,
      title: block.title,
      kind: 'task',
      color: colorOf(block.categoryId),
    });
  }
  for (const block of props.completedBlocks) {
    add(block.start, {
      key: `c-${block.occurrenceId}`,
      title: block.title,
      kind: 'completed',
      color: colorOf(block.categoryId),
    });
  }
  for (const block of props.fixedBlocks) {
    add(block.start, {
      key: `f-${block.appointmentId}-${block.start}`,
      title: block.isUnavailability && block.title === '' ? t('common.unavailable') : block.title,
      kind: block.isUnavailability ? 'unavailability' : 'appointment',
      // §4.5: a fixed block has no activity type, so there is no hue to take.
      color: null,
    });
  }

  return map;
});

/** A day number a comparison can use directly. */
function ordinal(date: CivilDate): number {
  return date.year * 10000 + date.month * 100 + date.day;
}

/**
 * Everything a cell renders, worked out once per cell.
 *
 * The template used to ask for each of these as it drew: four calls to
 * `specialWeekOn` — a linear scan re-parsing every date range — three to
 * `entriesOn`, and two formatter constructions for the labels, on each of up
 * to forty-two cells. All nine answers depend only on the day, so they are
 * computed together and the template reads fields.
 */
interface Cell {
  key: string;
  date: CivilDate;
  inMonth: boolean;
  isToday: boolean;
  /** Past the point anything could be placed (§6.1); compared by date, not instant. */
  pastHorizon: boolean;
  specialWeek: string | null;
  label: string;
  /** Everything on the day, for the cell that has been opened. */
  entries: DayEntry[];
  shown: DayEntry[];
  hidden: number;
}

const weeks = computed<Cell[][]>(() => {
  const today = props.today;
  const horizon = props.horizonEnd === null ? null : ordinal(props.horizonEnd);

  return monthWeeks(props.month, props.firstDayOfWeek).map((week) =>
    week.map((day) => {
      const entries = byDay.value.get(`${day.date.year}-${day.date.month}-${day.date.day}`) ?? [];

      return {
        key: day.key,
        date: day.date,
        inMonth: day.inMonth,
        isToday: today !== null && sameCivilDate(day.date, today),
        pastHorizon: horizon !== null && ordinal(day.date) > horizon,
        specialWeek: specialWeekOn(day.date, props.specialWeeks)?.name ?? null,
        label: formatFullDate(day.date, props.locale),
        entries,
        shown: entries.slice(0, SHOWN_PER_DAY),
        hidden: Math.max(entries.length - SHOWN_PER_DAY, 0),
      };
    }),
  );
});

/**
 * The cell being pointed at, or holding the keyboard's attention.
 *
 * "+3 more" is a count of things a reader wants to read, and the only way to
 * read them was to leave the month — which is the screen they chose because it
 * shows the shape of several weeks at once. Pointing at the day is a cheaper
 * question than navigating to it and back.
 */
const attended = ref<string | null>(null);

/** True for the one cell that is showing everything it has. */
function opened(cell: Cell): boolean {
  return attended.value === cell.key && cell.hidden > 0;
}

/**
 * The full list, as a panel over the weeks below rather than a taller cell.
 *
 * In flow it would grow its row, which moves every cell under it — so reaching
 * for the fourth item on the 21st would shove the 21st itself down the page.
 * Floating it leaves the grid exactly where it was.
 *
 * It opens *upward* from the last two rows, because the grid clips what leaves
 * it and a panel hanging off the bottom row would be cut in half. Decided from
 * the row index rather than by measuring: the answer is the same every time and
 * a measurement would have to happen after a paint the reader is already
 * looking at.
 */
function panelClassesFor(row: number): string {
  const side = row >= weeks.value.length - 2 ? 'bottom-1' : 'top-7';
  return `bg-popover absolute inset-x-1 z-20 max-h-40 overflow-y-auto rounded-md border p-1 shadow-lg ${side}`;
}

function classesFor(entry: DayEntry): string {
  if (entry.kind === 'task') return entry.color === null ? 'bg-primary/15 text-foreground' : '';
  if (entry.kind === 'completed')
    return entry.color === null
      ? 'bg-primary/[0.06] text-muted-foreground line-through'
      : 'text-muted-foreground line-through';
  // The same hatch the week draws it with — one texture for one fact (§7.2).
  if (entry.kind === 'unavailability')
    return 'bg-muted-foreground/15 hatched text-muted-foreground';
  return 'bg-secondary text-secondary-foreground';
}

/**
 * A tint here, where the week view fills solid.
 *
 * Same hue, deliberately quieter. A month cell is three lines of 0.7rem text in
 * a box an inch tall, forty-two of them on screen at once: filled the way the
 * week fills them, this becomes a quilt, and the thing this view exists to show
 * — which days are full and which are empty — is the first casualty. The tint
 * is enough to say *what kind of work*, which is all that is being asked at
 * this size, and the ink stays the page's own so a 0.7rem line is never
 * carrying text on a colour.
 */
function styleFor(entry: DayEntry): Record<string, string> {
  if (entry.color === null) return {};
  const hue = `var(--category-block-${entry.color})`;
  const strength = entry.kind === 'completed' ? '8%' : '20%';
  return { backgroundColor: `color-mix(in oklab, ${hue} ${strength}, transparent)` };
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
      <!--
        The whole cell opens the day, and there is no `role` on it.

        The same accelerator the week grid puts on a column: a person looking at
        a Thursday and wanting its hours points at the Thursday, not at the four
        characters of its date. The keyboard path is the day number below, which
        is a real button and keeps its own label — announcing an inch-tall box
        of text as one control would take that away rather than add to it.
      -->
      <div
        v-for="day in week"
        :key="day.key"
        class="relative min-h-24 cursor-pointer border-r p-1.5 last:border-r-0"
        :class="[
          day.inMonth ? '' : 'bg-muted/30',
          day.isToday ? 'ring-primary/40 ring-inset ring-2' : '',
          opened(day) ? 'z-20' : '',
        ]"
        data-testid="month-day"
        :data-date="day.key"
        :data-in-month="day.inMonth ? 'true' : 'false'"
        :data-opened="opened(day) ? 'true' : undefined"
        @click="emit('openDay', day.date)"
        @pointerenter="attended = day.key"
        @pointerleave="attended === day.key && (attended = null)"
        @focusin="attended = day.key"
        @focusout="attended === day.key && (attended = null)"
      >
        <!--
          The special week is a background rather than a badge. A fortnight away
          is one continuous stretch and the eye reads a run of shaded cells as
          one thing, which is exactly what it is — where a badge per day reads
          as fourteen unrelated notes.
        -->
        <div
          v-if="day.specialWeek !== null"
          class="pointer-events-none absolute inset-0 bg-amber-100/70 dark:bg-amber-900/25"
          data-testid="special-week-shade"
          :data-name="day.specialWeek"
        />

        <div class="relative flex items-start gap-1">
          <button
            type="button"
            class="hover:underline"
            :class="[
              day.inMonth ? '' : 'text-muted-foreground',
              day.isToday ? 'text-primary font-semibold' : '',
            ]"
            :aria-label="t('calendar.showWeekOf', { day: day.label })"
            data-testid="open-day"
            @click.stop="emit('openDay', day.date)"
          >
            <span class="text-sm tabular-nums">{{ day.date.day }}</span>
          </button>
        </div>

        <p
          v-if="day.specialWeek !== null"
          class="relative truncate text-[0.65rem] text-amber-900 dark:text-amber-200"
          data-testid="special-week-name"
        >
          {{ day.specialWeek }}
        </p>

        <ul
          class="space-y-0.5"
          :class="opened(day) ? panelClassesFor(row) : 'relative mt-0.5'"
          data-testid="month-day-list"
        >
          <li
            v-for="entry in opened(day) ? day.entries : day.shown"
            :key="entry.key"
            class="truncate rounded px-1 py-0.5 text-[0.7rem]"
            :class="classesFor(entry)"
            :style="styleFor(entry)"
            :data-testid="`month-block-${entry.kind}`"
            :data-color="entry.color ?? undefined"
            :title="entry.title"
          >
            {{ entry.title }}
          </li>
          <!--
            The count stays a count rather than becoming a control. What opens
            the list is pointing at the day, which is a bigger target than one
            line of 0.7rem text and is the gesture somebody makes anyway while
            reading down a month.
          -->
          <li
            v-if="!opened(day) && day.hidden > 0"
            class="text-muted-foreground px-1 text-[0.7rem]"
            data-testid="month-day-more"
          >
            {{ t('calendar.more', { count: day.hidden }) }}
          </li>
        </ul>

        <!--
          Said once per cell rather than as one note under the grid, because the
          boundary falls mid-month and which side a given day is on is the only
          thing anybody needs to know about it.
        -->
        <span v-if="day.pastHorizon" class="sr-only" data-testid="past-horizon">
          {{ t('calendar.pastHorizon') }}
        </span>
      </div>
    </div>
  </div>
</template>

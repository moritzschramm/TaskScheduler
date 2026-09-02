<script setup lang="ts">
import { computed, ref } from 'vue';
import type { CompletedBlock, FixedBlock, ScheduledBlock } from '@ambitime/shared';
import type { CivilDate, ResolvedWindow } from '@ambitime/scheduler';
import {
  blocksForDay,
  clipBand,
  dragOffsetMinutes,
  movedStartMin,
  openBandsForDay,
  SCALE,
  SNAP_MINUTES,
  type DayBand,
  type GridBlock,
} from '@/lib/grid';
import { formatDayLabel, formatMinuteOfDay, sameCivilDate } from '@/lib/time';

const props = withDefaults(
  defineProps<{
    days: CivilDate[];
    timeZone: string;
    blocks: ScheduledBlock[];
    fixedBlocks: FixedBlock[];
    /**
     * What was finished, drawn where it was finished (§3.4, §7.3).
     *
     * Separate from `blocks` because the engine cannot produce them: a
     * completed occurrence is not demand, so a solve that included them would
     * be answering a different question — and the optimistic client-side solve
     * would disagree with the server on every single read.
     */
    completedBlocks?: CompletedBlock[];
    /**
     * The hours something may be scheduled in, resolved by the engine (§4.3).
     *
     * Drawn as the lit part of each column. Empty is meaningful and is left to
     * render as a wholly closed week: a calendar with no availability windows
     * genuinely cannot have anything placed in it, and a grid that hid that
     * would be the same blank week as one that simply had nothing to do.
     */
    windows?: readonly ResolvedWindow[];
    today?: CivilDate | null;
    /** Visible span, in local minutes. Outside it there is nothing to show. */
    dayStartMin?: number;
    dayEndMin?: number;
    locale?: string;
    /** M11: the grid becomes a way in to the editors, not only a picture. */
    editable?: boolean;
    /**
     * Whether a day offers "postpone the rest of it" (§7.2).
     *
     * A bulk action on *tasks*, so it belongs on the screen that draws tasks.
     * On Commitments it was an arrow that appeared to do nothing, because
     * nothing it could move was on screen.
     */
    postponable?: boolean;
  }>(),
  {
    windows: () => [],
    completedBlocks: () => [],
    today: null,
    dayStartMin: 6 * 60,
    dayEndMin: 22 * 60,
    locale: 'en-GB',
    editable: false,
    postponable: false,
  },
);

const emit = defineEmits<{
  selectBlock: [block: GridBlock];
  /** Marks a scheduled task done without leaving the week (§7.3). */
  completeBlock: [block: GridBlock];
  /** A task dropped, or nudged, onto a new local start (spec §7.3, §13). */
  moveBlock: [payload: { block: GridBlock; day: CivilDate; startMin: number }];
  postponeDay: [day: CivilDate];
}>();

/**
 * A move in progress: which block, and how far it has been moved so far.
 *
 * Held here rather than committed on every pointer move because a drag is one
 * intent, not fifty. The block follows the pointer; only the drop emits a
 * command.
 */
const pending = ref<{ key: string; day: CivilDate; offsetMin: number } | null>(null);

/** Where the pointer went down, in pixels — the origin every delta is from. */
let dragOriginY: number | null = null;

/** Announced to assistive technology as a move progresses (WCAG 4.1.3). */
const announcement = ref('');

function isMoving(block: GridBlock): boolean {
  return pending.value?.key === block.key;
}

/** The top a block is drawn at, including any move in progress. */
function startMinOf(block: GridBlock): number {
  return isMoving(block)
    ? movedStartMin(block, pending.value!.offsetMin, props.dayStartMin)
    : block.startMin;
}

function beginDrag(block: GridBlock, day: CivilDate, event: PointerEvent): void {
  // Only task blocks move. An appointment is a fixed block by definition
  // (§6.2 rule 2); dragging one would be editing it, which the editor does, and
  // a completed one is a record of the past, which nothing should move.
  if (!props.editable || block.kind !== 'task') return;

  dragOriginY = event.clientY;
  pending.value = { key: block.key, day, offsetMin: 0 };
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

function duringDrag(event: PointerEvent): void {
  if (pending.value === null || dragOriginY === null) return;
  pending.value = {
    ...pending.value,
    offsetMin: dragOffsetMinutes(event.clientY - dragOriginY),
  };
}

function endDrag(block: GridBlock): void {
  const move = pending.value;
  dragOriginY = null;
  pending.value = null;
  if (move === null || move.key !== block.key) return;

  // A drag that ended where it started is a click, not a move. Emitting a
  // command for it would put a floor on a task the user only wanted to look at.
  if (move.offsetMin === 0) {
    emit('selectBlock', block);
    return;
  }

  announcement.value = `${block.title} moved to ${formatMinuteOfDay(movedStartMin(block, move.offsetMin, props.dayStartMin))}.`;
  emit('moveBlock', {
    block,
    day: move.day,
    startMin: movedStartMin(block, move.offsetMin, props.dayStartMin),
  });
}

/**
 * The keyboard equivalent §14 requires, in the shape WCAG expects.
 *
 * **Pick up, move, drop.** Enter or Space on a focused task picks it up;
 * arrows then move it by the same fifteen minutes the pointer snaps to; Enter
 * drops it and Escape puts it back. That is the same three-part gesture a drag
 * is, rather than a different feature wearing its name — and `aria-grabbed`
 * says which state it is in.
 *
 * M12a bound the arrows directly, which was simpler and wrong: arrows are how
 * you *navigate* a grid, so a user could not reach the second block of a day
 * without moving the first. Picking up first is what frees them.
 */
function grab(block: GridBlock, day: CivilDate): void {
  if (!props.editable || block.kind !== 'task') return;

  pending.value = { key: block.key, day, offsetMin: 0 };
  announcement.value = `${block.title} picked up. Use the arrow keys to move it, Enter to drop it, Escape to cancel.`;
}

function nudge(block: GridBlock, day: CivilDate, steps: number): void {
  if (!isMoving(block)) return;

  const offsetMin = pending.value!.offsetMin + steps * SNAP_MINUTES;
  pending.value = { key: block.key, day, offsetMin };
  announcement.value = formatMinuteOfDay(movedStartMin(block, offsetMin, props.dayStartMin));
}

/** Enter and Space do whichever half of the gesture is next. */
function toggleGrab(block: GridBlock, day: CivilDate): void {
  if (isMoving(block)) {
    if (pending.value!.offsetMin === 0) {
      pending.value = null;
      announcement.value = `${block.title} put back.`;
      return;
    }
    endDrag(block);
    return;
  }

  // A block that cannot be moved is still selectable: Enter opens it.
  if (!props.editable || block.kind !== 'task') {
    emit('selectBlock', block);
    return;
  }

  grab(block, day);
}

function abandonNudge(): void {
  if (pending.value !== null) announcement.value = 'Move cancelled.';
  pending.value = null;
  dragOriginY = null;
}

/**
 * Arrow keys navigate unless something is picked up (WCAG 2.1.1, 2.4.3).
 *
 * A grid whose arrows always moved things would be a grid you could not read
 * with a keyboard, and reading is the commoner act by a wide margin.
 */
function onArrow(block: GridBlock, day: CivilDate, steps: number, event: KeyboardEvent): void {
  if (isMoving(block)) {
    nudge(block, day, steps);
    return;
  }
  moveFocus(event.currentTarget as HTMLElement, steps > 0 ? 1 : -1);
}

/** Left and right cross to the neighbouring day at the same position. */
function onHorizontal(event: KeyboardEvent, direction: 1 | -1): void {
  moveFocusByColumn(event.currentTarget as HTMLElement, direction);
}

function focusables(): HTMLElement[] {
  const root: Document | HTMLElement = grid.value ?? document;
  return [...root.querySelectorAll<HTMLElement>('[data-grid-block]')];
}

function moveFocus(from: HTMLElement, delta: number): void {
  const all = focusables();
  const index = all.indexOf(from);
  all[Math.min(Math.max(index + delta, 0), all.length - 1)]?.focus();
}

function moveFocusByColumn(from: HTMLElement, direction: 1 | -1): void {
  const columns = [...(grid.value?.querySelectorAll('[data-testid="day-column"]') ?? [])];
  const current = columns.findIndex((column) => column.contains(from));
  if (current === -1) return;

  // Walk to the next day that has anything to focus, so an empty Wednesday
  // does not swallow the keypress.
  for (let index = current + direction; index >= 0 && index < columns.length; index += direction) {
    const first = columns[index]?.querySelector<HTMLElement>('[data-grid-block]');
    if (first) {
      first.focus();
      return;
    }
  }
}

const grid = ref<HTMLElement | null>(null);

// `SCALE` lives in `lib/grid` beside the drag arithmetic that depends on it.

const visibleMinutes = computed(() => props.dayEndMin - props.dayStartMin);
const gridHeight = computed(() => visibleMinutes.value * SCALE);

const hourMarks = computed(() => {
  const marks: number[] = [];
  const first = Math.ceil(props.dayStartMin / 60) * 60;
  for (let minute = first; minute <= props.dayEndMin; minute += 60) marks.push(minute);
  return marks;
});

const columns = computed(() =>
  props.days.map((day) => ({
    day,
    label: formatDayLabel(day, props.locale),
    isToday: props.today !== null && sameCivilDate(day, props.today),
    blocks: blocksForDay(
      day,
      props.timeZone,
      props.blocks,
      props.fixedBlocks,
      props.completedBlocks,
    ),
    open: openBandsForDay(day, props.timeZone, props.windows)
      .map((band) => clipBand(band, props.dayStartMin, props.dayEndMin))
      .filter((band): band is DayBand => band !== null),
  })),
);

function offsetOf(minute: number): number {
  return (minute - props.dayStartMin) * SCALE;
}

function heightOfBand(band: DayBand): number {
  return (band.endMin - band.startMin) * SCALE;
}

/**
 * A block's height, floored so a very short one stays legible.
 *
 * A 15-minute task at this scale is 16 pixels, which is readable; anything
 * shorter would render as a line the user could not tell from a border.
 */
function heightOf(block: GridBlock): number {
  return Math.max((block.endMin - block.startMin) * SCALE, 14);
}

/**
 * What a screen reader says about a block (WCAG 4.1.2).
 *
 * The visible text is a title and a time range, which read as two unrelated
 * fragments out of context. The label puts them in one sentence with the day
 * and the kind of thing it is — and, for a task, what pressing Enter will do,
 * because an affordance nobody can see needs saying.
 */
function labelFor(block: GridBlock, dayLabel: string): string {
  const when = `${dayLabel}, ${formatMinuteOfDay(block.startMin)} to ${formatMinuteOfDay(block.endMin)}`;
  const kind = block.kind === 'unavailability' ? 'Unavailable' : block.title;

  // Said, not only shown: the strike-through and the fade are invisible to a
  // screen reader, and "done" is the whole of what distinguishes this block.
  if (block.kind === 'completed') return `${kind}. Completed. ${when}.`;

  if (!props.editable) return `${kind}. ${when}.`;
  if (block.kind !== 'task') return `${kind}. ${when}. Press Enter to open.`;

  return isMoving(block)
    ? `${kind}. Moving. Now ${formatMinuteOfDay(startMinOf(block))}. Arrow keys to move, Enter to drop, Escape to cancel.`
    : `${kind}. ${when}. Press Enter to pick up and move.`;
}

function classesFor(block: GridBlock): string {
  if (block.kind === 'task') return 'bg-primary/15 border-primary/40 text-foreground';
  // Done: drawn faintly, dashed, and struck through in the title. Three signals
  // rather than one, because colour alone would carry it (WCAG 1.4.1) and
  // because a faded block on a faded background is easy to miss entirely.
  if (block.kind === 'completed')
    return 'border-dashed border-primary/30 bg-primary/[0.06] text-muted-foreground';
  if (block.kind === 'unavailability')
    return 'bg-muted border-muted-foreground/30 text-muted-foreground';
  return 'bg-secondary border-secondary-foreground/30 text-secondary-foreground';
}
</script>

<template>
  <!--
    `overflow-y-hidden` is load-bearing, not tidiness. A box with `overflow-x`
    set and `overflow-y` visible computes the second to `auto`, so this used to
    grow its own vertical scrollbar over the eight pixels of the last hour label
    that hang below the grid — a second scrollbar inside the page's own. The
    padding leaves that overhang somewhere to be rather than clipping it.
  -->
  <div
    ref="grid"
    class="flex w-full overflow-x-auto overflow-y-hidden pb-2"
    role="group"
    :aria-label="`Week grid, times in ${timeZone}`"
    data-testid="week-grid"
  >
    <!--
      What a move is doing, for anyone who cannot see it happen (WCAG 4.1.3).
      Polite rather than assertive: a nudge is not an interruption, and the
      running commentary of a long move would be one if it were.
    -->
    <p class="sr-only" role="status" aria-live="polite" data-testid="grid-announcement">
      {{ announcement }}
    </p>
    <!-- Hour axis. Labelled once, so every column reads against the same one. -->
    <div class="w-14 shrink-0 pt-8" aria-hidden="true">
      <div class="relative" :style="{ height: `${gridHeight}px` }">
        <div
          v-for="mark in hourMarks"
          :key="mark"
          class="text-muted-foreground absolute -translate-y-1/2 pr-2 text-right text-xs tabular-nums"
          :style="{ top: `${offsetOf(mark)}px`, width: '100%' }"
        >
          {{ formatMinuteOfDay(mark) }}
        </div>
      </div>
    </div>

    <div class="grid min-w-[52rem] flex-1 grid-cols-7 gap-px">
      <div
        v-for="column in columns"
        :key="`${column.day.year}-${column.day.month}-${column.day.day}`"
        class="flex flex-col"
        :data-testid="`day-column`"
        :data-day="`${column.day.year}-${String(column.day.month).padStart(2, '0')}-${String(column.day.day).padStart(2, '0')}`"
      >
        <div
          class="flex h-8 items-center justify-between gap-1 border-b px-2 text-xs font-medium"
          :class="column.isToday ? 'text-primary' : 'text-muted-foreground'"
        >
          <span>{{ column.label }}</span>
          <!--
            One affordance per day heading, not two. The `+` that used to sit
            here is a header button now: a day column is four pixels of chrome,
            and hiding "make something new" inside it made the commonest act on
            the page the hardest one to find.
          -->
          <button
            v-if="editable && postponable"
            type="button"
            class="hover:text-foreground px-1 leading-none"
            :aria-label="`Postpone the rest of ${column.label}`"
            title="Move the rest of this day's tasks into later days"
            data-testid="postpone-day"
            @click="emit('postponeDay', column.day)"
          >
            ⤓
          </button>
        </div>

        <div class="bg-muted relative border-l" :style="{ height: `${gridHeight}px` }">
          <!--
            The hours something may actually be placed in (§4.3, §9.1).

            Drawn as the lit part of a column that is otherwise closed, rather
            than the other way round, because "closed" is the default a calendar
            with no windows configured should fall back to — and that calendar
            is exactly the one whose emptiness needs explaining.
          -->
          <div
            v-for="band in column.open"
            :key="`open-${band.startMin}`"
            class="absolute inset-x-0"
            :class="column.isToday ? 'bg-primary/[0.06]' : 'bg-card'"
            :style="{ top: `${offsetOf(band.startMin)}px`, height: `${heightOfBand(band)}px` }"
            data-testid="open-band"
            :data-start-min="band.startMin"
            :data-end-min="band.endMin"
            aria-hidden="true"
          />

          <div
            v-for="mark in hourMarks"
            :key="`line-${mark}`"
            class="border-border/60 absolute inset-x-0 border-t"
            :style="{ top: `${offsetOf(mark)}px` }"
            aria-hidden="true"
          />

          <component
            :is="editable ? 'button' : 'article'"
            v-for="block in column.blocks"
            :key="block.key"
            :type="editable ? 'button' : undefined"
            data-grid-block
            class="focus-visible:ring-ring absolute inset-x-1 touch-none overflow-hidden rounded-sm border px-1.5 py-0.5 text-left text-xs leading-tight focus-visible:z-20 focus-visible:ring-2 focus-visible:outline-none"
            :class="[classesFor(block), isMoving(block) ? 'ring-primary z-10 ring-2' : '']"
            :style="{ top: `${offsetOf(startMinOf(block))}px`, height: `${heightOf(block)}px` }"
            :data-testid="`block-${block.kind}`"
            :data-title="block.title"
            :data-start-min="startMinOf(block)"
            :data-end-min="block.endMin"
            :data-moving="isMoving(block) ? 'true' : undefined"
            :aria-label="labelFor(block, column.label)"
            :aria-grabbed="editable && block.kind === 'task' ? isMoving(block) : undefined"
            @pointerdown="beginDrag(block, column.day, $event)"
            @pointermove="duringDrag"
            @pointerup="endDrag(block)"
            @keydown.up.prevent="onArrow(block, column.day, -1, $event)"
            @keydown.down.prevent="onArrow(block, column.day, 1, $event)"
            @keydown.left.prevent="onHorizontal($event, -1)"
            @keydown.right.prevent="onHorizontal($event, 1)"
            @keydown.enter.prevent="toggleGrab(block, column.day)"
            @keydown.space.prevent="toggleGrab(block, column.day)"
            @keydown.esc.prevent="abandonNudge"
            @click="!isMoving(block) && editable && emit('selectBlock', block)"
          >
            <p
              class="truncate font-medium"
              :class="block.kind === 'completed' ? 'line-through' : ''"
            >
              <span v-if="block.continuesBefore" aria-hidden="true">↑ </span>{{ block.title
              }}<span v-if="block.continuesAfter" aria-hidden="true"> ↓</span>
            </p>
            <p class="tabular-nums opacity-70">{{ block.label }}</p>
          </component>

          <!--
            Done, without leaving the week (§7.3).

            A separate button rather than a gesture on the block, because the
            block already means three things — open it, pick it up, drop it —
            and completing is the one of the four you cannot take back by
            putting it down again. Sibling rather than child: a button inside a
            button is invalid, and the block is a button when editable.
          -->
          <button
            v-for="block in column.blocks.filter((entry) => editable && entry.kind === 'task')"
            :key="`done-${block.key}`"
            type="button"
            class="hover:bg-primary/20 focus-visible:ring-ring absolute z-10 rounded-sm px-1 text-[11px] leading-none focus-visible:ring-2 focus-visible:outline-none"
            :style="{ top: `${offsetOf(startMinOf(block)) + 2}px`, right: '6px' }"
            :aria-label="`Complete ${block.title}`"
            :title="`Complete ${block.title}`"
            data-testid="complete-block"
            :data-task-id="block.taskId"
            @click.stop="emit('completeBlock', block)"
          >
            ✓
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

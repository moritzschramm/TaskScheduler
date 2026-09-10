<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '@/i18n';
import type { Category, CompletedBlock, FixedBlock, ScheduledBlock } from '@ambitime/shared';
import type { CivilDate, ResolvedWindow } from '@ambitime/scheduler';
import {
  assignLanes,
  blocksForDay,
  DEFAULT_SCALE,
  categoryLanesForDay,
  clipBand,
  dragOffsetMinutes,
  movedStartMin,
  openBandsForDay,
  SNAP_MINUTES,
  type DayBand,
  type GridBlock,
  type PlacedBlock,
} from '@/lib/grid';
import { formatDayLabel, formatMinuteOfDay, sameCivilDate } from '@/lib/time';
import { Check } from 'lucide-vue-next';

const { t } = useI18n();

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
    /**
     * The activity types the open hours belong to (§4.3).
     *
     * Supplies each lane's name and colour. Empty falls back to the single
     * neutral band the grid drew before colours existed, which is also what a
     * screen with no categories should show.
     */
    categories?: readonly Category[];
    today?: CivilDate | null;
    /** Visible span, in local minutes. Outside it there is nothing to show. */
    dayStartMin?: number;
    dayEndMin?: number;
    /** Pixels per minute; see `lib/grid`. Passed in so a change re-renders. */
    scale?: number;
    locale?: string;
    /** M11: the grid becomes a way in to the editors, not only a picture. */
    editable?: boolean;
  }>(),
  {
    windows: () => [],
    categories: () => [],
    completedBlocks: () => [],
    today: null,
    dayStartMin: 6 * 60,
    dayEndMin: 22 * 60,
    scale: DEFAULT_SCALE,
    locale: 'en-GB',
    editable: false,
  },
);

const emit = defineEmits<{
  selectBlock: [block: GridBlock];
  /** Marks a scheduled task done without leaving the week (§7.3). */
  completeBlock: [block: GridBlock];
  /** A task dropped, or nudged, onto a new local start (spec §7.3, §13). */
  moveBlock: [payload: { block: GridBlock; day: CivilDate; startMin: number }];
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

/**
 * Set when a drag actually moved something; cleared by the next gesture.
 *
 * A pointer gesture ends as `pointerup` *and then* `click`. `endDrag` runs on
 * the first and clears `pending`, so by the time the click arrives `isMoving`
 * is already false and the guard on the handler passes — which is why dropping
 * a task on a new hour also opened its editor. The block cannot tell the two
 * apart from the click alone; it has to remember what just happened.
 */
let draggedJustNow = false;

/**
 * True once a drag has been committed and before the answer has come back.
 *
 * The block is still drawn at the dropped position — `pending` still holds the
 * offset — but nothing may move it any further, and it is no longer "grabbed".
 */
const settling = ref(false);

/**
 * Releases the held block when new blocks arrive.
 *
 * The authoritative answer replaces `props.blocks` wholesale, so any change to
 * it — the server's, or the optimistic solve's — is the moment the grid can
 * stop drawing the drop by hand. Watching the data rather than timing it means
 * the hand-off happens exactly when there is something new to hand off to, on
 * a fast network and a slow one alike.
 */
watch(
  () => props.blocks,
  () => {
    if (settling.value) {
      settling.value = false;
      pending.value = null;
    }
  },
);

/** Announced to assistive technology as a move progresses (WCAG 4.1.3). */
const announcement = ref('');

/** Held under the pointer: mid-drag, or dropped and waiting for the answer. */
function isHeld(block: GridBlock): boolean {
  return pending.value?.key === block.key;
}

/** Mid-gesture — the part that shows a ring and responds to the pointer. */
function isMoving(block: GridBlock): boolean {
  return isHeld(block) && !settling.value;
}

/** The top a block is drawn at, including any move in progress. */
function startMinOf(block: GridBlock): number {
  return isHeld(block)
    ? movedStartMin(block, pending.value!.offsetMin, props.dayStartMin)
    : block.startMin;
}

function beginDrag(block: GridBlock, day: CivilDate, event: PointerEvent): void {
  settling.value = false;
  // Cleared at the *start* of every gesture rather than only by the click that
  // consumes it. A drag long enough to move a block often fires no `click` at
  // all, so a flag that waited to be consumed would survive into the next,
  // genuine click — which is how the fix for "the editor opens after a drag"
  // became "the editor never opens".
  draggedJustNow = false;

  // Only task blocks move. An appointment is a fixed block by definition
  // (§6.2 rule 2); dragging one would be editing it, which the editor does, and
  // a completed one is a record of the past, which nothing should move.
  if (!props.editable || block.kind !== 'task') return;

  dragOriginY = event.clientY;
  pending.value = { key: block.key, day, offsetMin: 0 };
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
}

function duringDrag(event: PointerEvent): void {
  if (pending.value === null || dragOriginY === null || settling.value) return;
  pending.value = {
    ...pending.value,
    offsetMin: dragOffsetMinutes(event.clientY - dragOriginY),
  };
}

function endDrag(block: GridBlock): void {
  const move = pending.value;
  dragOriginY = null;
  if (move === null || move.key !== block.key) {
    pending.value = null;
    return;
  }

  // A drag that ended where it started is a click, not a move. Emitting a
  // command for it would put a floor on a task the user only wanted to look at.
  if (move.offsetMin === 0) {
    pending.value = null;
    emit('selectBlock', block);
    return;
  }

  draggedJustNow = true;

  // **The move is held, not released.** Clearing it here put the block back at
  // its old hour for the few hundred milliseconds the command took, so a drop
  // showed the block snapping home and then jumping to where it had been put.
  // It stays under the pointer until the answer arrives; `settling` says the
  // gesture is over, so the drag handlers stop and the ring comes off.
  settling.value = true;

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

/**
 * Opening the editor, unless a drag just put the block somewhere.
 *
 * The flag is consumed whether or not it was set, so it can never survive into
 * a later, genuine click.
 */
function onClick(block: GridBlock): void {
  const afterDrag = draggedJustNow;
  draggedJustNow = false;
  if (afterDrag || isMoving(block) || !props.editable) return;

  emit('selectBlock', block);
}

function abandonNudge(): void {
  if (pending.value !== null) announcement.value = t('calendar.moveCancelled');
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

// The scale lives in `lib/grid` beside the drag arithmetic that depends on it.

/**
 * The narrowest a day column may be, in rem.
 *
 * Below this a day heading and a block title stop fitting, so the grid scrolls
 * sideways rather than squeezing. Seven of these is the 52rem the whole grid
 * used to be pinned to; expressing it per column is what lets the minimum
 * shrink when there are fewer days to draw.
 */
const MIN_COLUMN_REM = 7.5;

const visibleMinutes = computed(() => props.dayEndMin - props.dayStartMin);
const gridHeight = computed(() => visibleMinutes.value * props.scale);

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
    blocks: assignLanes(
      blocksForDay(
        day,
        props.timeZone,
        props.blocks,
        props.fixedBlocks,
        props.completedBlocks,
        t('common.unavailable'),
      ),
    ),
    open: openBandsForDay(day, props.timeZone, props.windows)
      .map((band) => clipBand(band, props.dayStartMin, props.dayEndMin))
      .filter((band): band is DayBand => band !== null),
    lanes: categoryLanesForDay(day, props.timeZone, props.windows)
      .map((lane) => {
        const clipped = clipBand(lane, props.dayStartMin, props.dayEndMin);
        return clipped === null ? null : { ...lane, ...clipped };
      })
      .filter((lane) => lane !== null),
  })),
);

/** Name and colour for a lane, by the id the window carried. */
const categoryById = computed(
  () => new Map(props.categories.map((category) => [category.id, category])),
);

function nameOf(categoryId: string): string {
  return categoryById.value.get(categoryId)?.name ?? '';
}

/**
 * A lane's hue, or `null` for an activity type that has no slot.
 *
 * Resolved through `color-mix` against the surface rather than as a flat tint,
 * so the fill stays a wash the block on top of it can be read against, while
 * the left edge below carries the hue at the chroma it was selected at.
 */
function hueOf(categoryId: string): string | null {
  const color = categoryById.value.get(categoryId)?.color ?? null;
  return color === null ? null : `var(--category-${color})`;
}

function offsetOf(minute: number): number {
  return (minute - props.dayStartMin) * props.scale;
}

function heightOfBand(band: DayBand): number {
  return (band.endMin - band.startMin) * props.scale;
}

/**
 * A block's height, floored so a very short one stays legible.
 *
 * A 15-minute task at this scale is 16 pixels, which is readable; anything
 * shorter would render as a line the user could not tell from a border.
 */
function heightOf(block: GridBlock): number {
  return Math.max((block.endMin - block.startMin) * props.scale, 14);
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
  // Titled or not, the block's own title is already the right words: an
  // untitled unavailability was given this same label when it was positioned.
  const kind = block.title;

  // Said, not only shown: the strike-through and the fade are invisible to a
  // screen reader, and "done" is the whole of what distinguishes this block.
  if (block.kind === 'completed') return `${kind}. Completed. ${when}.`;

  if (!props.editable) return `${kind}. ${when}.`;
  if (block.kind !== 'task') return `${kind}. ${when}. Press Enter to open.`;

  return isMoving(block)
    ? `${kind}. Moving. Now ${formatMinuteOfDay(startMinOf(block))}. Arrow keys to move, Enter to drop, Escape to cancel.`
    : `${kind}. ${when}. Press Enter to pick up and move.`;
}

/**
 * How a block is filled.
 *
 * **A task is opaque and a fixed block is not.** Everything else on the column
 * — the open band, the activity-type lanes — is a wash saying what *could*
 * happen there, and a task is the one thing that says what *will*. It used to
 * be a 15% tint of the same colour family, which read as one more wash; once
 * the lanes underneath had colours of their own it stopped reading as a
 * foreground object at all. Solid fill, inverted text and a shadow put it back
 * on top, and the ring on the moving one still shows over it.
 */
function classesFor(block: GridBlock): string {
  if (block.kind === 'task')
    return 'bg-primary text-primary-foreground border-primary shadow-sm font-medium';
  // Done: drawn faintly, dashed, and struck through in the title. Three signals
  // rather than one, because colour alone would carry it (WCAG 1.4.1) and
  // because a faded block on a faded background is easy to miss entirely.
  if (block.kind === 'completed')
    return 'border-dashed border-primary/40 bg-primary/20 text-foreground';
  if (block.kind === 'unavailability')
    return 'bg-muted border-muted-foreground/30 text-muted-foreground';
  return 'bg-secondary border-secondary-foreground/30 text-secondary-foreground';
}

/** Which blocks carry a done control: a placed task, on a grid that edits. */
function completable(block: GridBlock): boolean {
  return props.editable && block.kind === 'task';
}

/**
 * The horizontal box a block occupies, as its share of the column.
 *
 * Expressed in `calc` rather than in pixels because the share is a fraction of
 * a column whose width is the grid's business — it changes with the window, and
 * with how many days are being drawn. `EDGE` is the gap either side that the
 * old `inset-x-1` gave every block; it is subtracted from the width so two
 * neighbours have eight pixels between them rather than none.
 */
const EDGE = 4;

function leftOf(block: PlacedBlock): string {
  return `calc(${(block.lane / block.lanes) * 100}% + ${EDGE}px)`;
}

function widthOf(block: PlacedBlock): string {
  return `calc(${(1 / block.lanes) * 100}% - ${EDGE * 2}px)`;
}

/** How far a block's right edge sits from the column's, for the done strip. */
function rightOf(block: PlacedBlock): number {
  return (1 - (block.lane + 1) / block.lanes) * 100;
}

/**
 * The done control's width, and how far its right edge sits from the column's.
 *
 * Read by the block as well as by the strip: what the strip covers is what the
 * title gives up, so the two cannot end up overlapping as the column narrows.
 */
const DONE_WIDTH = 24;
const DONE_INSET = 6;
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

    <!--
      One track per day *drawn*, not per day in a week.
      `grid-cols-7` was right while the grid always drew seven; with the days a
      user can now hide, five columns filled five sevenths and left two
      sevenths blank. The minimum width scales the same way, so hiding the
      weekend narrows the grid rather than leaving it needing a scrollbar it no
      longer earns.
    -->
    <div
      class="grid flex-1 gap-px"
      :style="{
        gridTemplateColumns: `repeat(${Math.max(columns.length, 1)}, minmax(0, 1fr))`,
        minWidth: `${Math.max(columns.length, 1) * MIN_COLUMN_REM}rem`,
      }"
    >
      <div
        v-for="column in columns"
        :key="`${column.day.year}-${column.day.month}-${column.day.day}`"
        class="flex flex-col"
        :data-testid="`day-column`"
        :data-day="`${column.day.year}-${String(column.day.month).padStart(2, '0')}-${String(column.day.day).padStart(2, '0')}`"
      >
        <!--
          The day heading says which day, and nothing else.

          It used to carry a `+`, and after that a `⊘` for "I'm not available
          this day". Both were the same mistake in different clothes: a day
          column is four pixels of chrome, and an action hidden in it is one
          glyph with no word beside it, repeated seven times for a gesture
          somebody makes once. Blocking out a day is a header button now —
          one of them, big enough to read.
        -->
        <div
          class="flex h-8 items-center border-b px-2 text-xs font-medium"
          :class="column.isToday ? 'text-primary' : 'text-muted-foreground'"
        >
          <span>{{ column.label }}</span>
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

          <!--
            One lane per activity type that may be scheduled in this slice.
            Drawn over the neutral band rather than instead of it, so a type
            with no colour still reads as open time.

            **The name is on the lane, not only the colour.** Eight hues cannot
            all be told apart by every reader — the palette's own validator says
            so — and the answer is not a different eight but to stop making
            colour the thing that carries identity. The colour groups; the word
            names. Where the lane is too narrow for the word, the title does it.
          -->
          <div
            v-for="lane in column.lanes"
            :key="`lane-${lane.categoryId}-${lane.startMin}`"
            class="absolute overflow-hidden"
            :class="hueOf(lane.categoryId) === null ? 'bg-muted-foreground/[0.06]' : ''"
            :style="{
              top: `${offsetOf(lane.startMin)}px`,
              height: `${heightOfBand(lane)}px`,
              left: `${lane.offset * 100}%`,
              width: `${lane.width * 100}%`,
              ...(hueOf(lane.categoryId) === null
                ? {}
                : {
                    backgroundColor: `color-mix(in oklab, ${hueOf(lane.categoryId)} 14%, transparent)`,
                    borderLeft: `3px solid ${hueOf(lane.categoryId)}`,
                  }),
            }"
            data-testid="category-lane"
            :data-category-id="lane.categoryId"
            :data-start-min="lane.startMin"
            :title="nameOf(lane.categoryId)"
          >
            <span class="text-muted-foreground truncate px-1 text-[0.65rem] leading-4">
              {{ nameOf(lane.categoryId) }}
            </span>
          </div>

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
            class="focus-visible:ring-ring absolute touch-none overflow-hidden rounded-sm border px-1.5 py-0.5 text-left text-xs leading-tight focus-visible:z-20 focus-visible:ring-2 focus-visible:outline-none"
            :class="[classesFor(block), isMoving(block) ? 'ring-primary z-10 ring-2' : '']"
            :style="{
              top: `${offsetOf(startMinOf(block))}px`,
              height: `${heightOf(block)}px`,
              left: leftOf(block),
              width: widthOf(block),
              ...(completable(block) ? { paddingRight: `${DONE_WIDTH + DONE_INSET}px` } : {}),
            }"
            :data-lane="block.lanes > 1 ? `${block.lane}/${block.lanes}` : undefined"
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
            @click="onClick(block)"
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

            **A strip down the block's edge, not a glyph on top of it.** It was
            a bare ✓ with no fill of its own, which meant it inherited the
            column's ink and drew it over a solid block — the mark was there
            and nobody could see it — on eleven pixels of hit target. Full
            height is what makes the target grow with the block instead of
            hanging off a short one, and the tint is the block's own foreground
            so the strip reads as part of the thing it finishes rather than as
            another colour on the week.
          -->
          <button
            v-for="block in column.blocks.filter(completable)"
            :key="`done-${block.key}`"
            type="button"
            class="text-primary-foreground bg-primary-foreground/20 hover:bg-primary-foreground/35 focus-visible:ring-ring absolute z-10 flex items-center justify-center overflow-hidden rounded-sm focus-visible:z-20 focus-visible:ring-2 focus-visible:outline-none"
            :style="{
              top: `${offsetOf(startMinOf(block))}px`,
              height: `${heightOf(block)}px`,
              right: `calc(${rightOf(block)}% + ${DONE_INSET}px)`,
              width: `${DONE_WIDTH}px`,
            }"
            :aria-label="t('calendar.completeBlock', { title: block.title })"
            :title="t('calendar.completeBlock', { title: block.title })"
            data-testid="complete-block"
            :data-task-id="block.taskId"
            @click.stop="emit('completeBlock', block)"
          >
            <Check class="size-4 shrink-0" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

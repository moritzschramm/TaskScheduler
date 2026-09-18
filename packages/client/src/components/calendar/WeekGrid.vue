<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '@/i18n';
import type {
  ActivityType,
  CompletedBlock,
  FixedBlock,
  ScheduledBlock,
  WeekTypeOverrideEntry,
} from '@ambitime/shared';
import type { CivilDate, ResolvedWindow } from '@ambitime/scheduler';
import {
  assignLanes,
  blocksForDay,
  DEFAULT_SCALE,
  activityTypeLanesForDay,
  clipBand,
  dragOffsetMinutes,
  movedStartMin,
  openBandsForDay,
  slotAtOffset,
  SNAP_MINUTES,
  type DayBand,
  type GridBlock,
  type PlacedBlock,
} from '@/lib/grid';
import { formatDayLabel, formatMinuteOfDay, sameCivilDate } from '@/lib/time';
import { specialWeekOn } from '@/lib/month';
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
     * screen with no activity types should show.
     */
    activityTypes?: readonly ActivityType[];
    /**
     * The date ranges whose rules replace the default set (§4.3).
     *
     * Named on the day rather than only felt through it. A special week's whole
     * effect on this screen is that the open hours are different — often
     * absent — so a holiday and a calendar nobody has configured yet look
     * exactly alike, and the difference is the difference between "nothing can
     * be scheduled here" and "you decided nothing would be". The month view has
     * said which is which since it learned to shade them; this is the same fact
     * on the screen where the hours are.
     */
    specialWeeks?: readonly WeekTypeOverrideEntry[];
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
    activityTypes: () => [],
    completedBlocks: () => [],
    specialWeeks: () => [],
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
  /**
   * An empty stretch of a day, clicked (spec §7.3, §7.4).
   *
   * The grid is where a person is already looking when they decide something
   * should happen on Thursday afternoon, and until now the answer was to press
   * a button at the top of the page and then type Thursday afternoon into a
   * form. What the screen means by the gesture differs — Schedule makes a task
   * that prefers the hour, Appointments makes a block that occupies it — so the
   * grid reports the slot and says nothing about what to do with it.
   */
  selectSlot: [payload: { day: CivilDate; startMin: number }];
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

/**
 * A click on the part of a column with nothing in it.
 *
 * Measured from the column's own box rather than from `offsetY`, because the
 * click may land on an availability band or an activity-type lane — both
 * absolutely positioned children — and `offsetY` would then be measured from
 * whichever one of those happened to be under the pointer.
 *
 * Blocks stop their own clicks, so this only ever hears about empty time.
 */
function clickSlot(day: CivilDate, event: MouseEvent): void {
  if (!props.editable) return;

  const top = (event.currentTarget as HTMLElement).getBoundingClientRect().top;
  emit('selectSlot', {
    day,
    startMin: slotAtOffset(event.clientY - top, props.dayStartMin, props.dayEndMin, props.scale),
  });
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
    specialWeek: specialWeekOn(day, props.specialWeeks)?.name ?? null,
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
    lanes: activityTypeLanesForDay(day, props.timeZone, props.windows)
      .map((lane) => {
        const clipped = clipBand(lane, props.dayStartMin, props.dayEndMin);
        return clipped === null ? null : { ...lane, ...clipped };
      })
      .filter((lane) => lane !== null),
  })),
);

/** Name and colour for a lane, by the id the window carried. */
const activityTypeById = computed(
  () => new Map(props.activityTypes.map((activityType) => [activityType.id, activityType])),
);

function nameOf(activityTypeId: string): string {
  return activityTypeById.value.get(activityTypeId)?.name ?? '';
}

/**
 * A lane's hue, or `null` for an activity type that has no slot.
 *
 * Resolved through `color-mix` against the surface rather than as a flat tint,
 * so the fill stays a wash the block on top of it can be read against, while
 * the left edge below carries the hue at the chroma it was selected at.
 */
function hueOf(activityTypeId: string): string | null {
  const color = activityTypeById.value.get(activityTypeId)?.color ?? null;
  return color === null ? null : `var(--activity-type-${color})`;
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
const MIN_BLOCK_HEIGHT = 14;

function heightOf(block: GridBlock): number {
  return Math.max((block.endMin - block.startMin) * props.scale, MIN_BLOCK_HEIGHT);
}

/**
 * What the two lines of a block need: a title and a time range.
 *
 * Two lines of `text-xs leading-tight` at 16 pixels each, plus the two-pixel
 * padding either side. Below this the box clips its own second line, which is
 * the one that says when the thing is.
 */
const FULL_HEIGHT = 36;

/** The block under the pointer, or the one with the keyboard's attention. */
const attended = ref<string | null>(null);

/**
 * True for a block too short to show what it says.
 *
 * At the default scale that is anything under about half an hour, and at the
 * smallest scale a whole hour — which is the case that makes this worth doing:
 * the slider is how a week gets small enough to read at a glance, and it is
 * exactly then that every block stops saying anything.
 */
function cramped(block: GridBlock): boolean {
  return heightOf(block) < FULL_HEIGHT;
}

/**
 * Reading a cramped block by pointing at it.
 *
 * Height only. Widening a block that is sharing its column would cover the
 * thing it is sharing with, which trades one unreadable block for two — and
 * the title is truncated horizontally with an ellipsis, which at least says
 * that there is more, where a clipped second line says nothing at all.
 *
 * Not while it is being dragged: a block that grew under the pointer mid-move
 * would change the very geometry the drop is being aimed at.
 */
function expanded(block: GridBlock): boolean {
  return attended.value === block.key && cramped(block) && !isMoving(block);
}

function drawnHeight(block: GridBlock): number {
  return expanded(block) ? FULL_HEIGHT : heightOf(block);
}

/**
 * The box a block is drawn in, clipped to the first hour on screen.
 *
 * **A block that starts before the visible band was drawn above it**, and the
 * two lines it carries with it. Blocking out a whole day writes 00:00–24:00;
 * against a grid that opens at six that is a box beginning 178 pixels over the
 * top edge — measured — so the column filled with a shape that said nothing,
 * and the word "Unavailable" was clipped away with the hours nobody asked to
 * see. Pushing the top down to the band and taking the same amount off the
 * height leaves the bottom edge exactly where it was and brings the label back
 * into the part of the block a reader is looking at.
 *
 * Used by the done strip too, so the control stays on the block it belongs to.
 */
function boxOf(block: GridBlock): { top: string; height: string } {
  const offset = offsetOf(startMinOf(block));

  return {
    top: `${Math.max(offset, 0)}px`,
    height: `${Math.max(drawnHeight(block) + Math.min(offset, 0), MIN_BLOCK_HEIGHT)}px`,
  };
}

function attend(block: GridBlock): void {
  attended.value = block.key;
}

function release(block: GridBlock): void {
  if (attended.value === block.key) attended.value = null;
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
 *
 * **And it is filled in its own activity type's colour**, from the block column
 * of the palette rather than the lane column — a step derived to be the same
 * hue as the hours underneath and dark enough (light enough, on the dark
 * surface) that the two lines of text on it clear 5:1. Measured against the
 * wash it sits on, that is ΔE 32–51: the block is unmistakably the object and
 * the lane is unmistakably the background, which was the one thing a single
 * near-black fill could not say about eight different kinds of work.
 *
 * Structure here, colour in `styleFor`. A hue cannot be a Tailwind class
 * without eight of them per role compiled in advance for a set the user edits.
 */
function classesFor(block: GridBlock): string {
  if (block.kind === 'task')
    return blockHueOf(block) === null
      ? // The neutral block takes its edge from its own ink rather than from
        // `--block-edge`: `--primary` on the light surface *is* that deep
        // neutral already, so darkening it further would draw nothing.
        'bg-primary text-primary-foreground border-primary-foreground/30 shadow-sm font-medium'
      : 'shadow-sm font-medium';
  // Done: drawn faintly, dashed, and struck through in the title. Three signals
  // rather than one, because colour alone would carry it (WCAG 1.4.1) and
  // because a faded block on a faded background is easy to miss entirely.
  if (block.kind === 'completed')
    return blockHueOf(block) === null
      ? 'border-dashed border-primary/40 bg-primary/20 text-foreground'
      : 'border-dashed text-foreground';
  // Hatched, because the fill alone is the day body's own colour — see the
  // `.hatched` note in `main.css`. The border is firmer than the appointment's
  // for the same reason: this is the one block with nothing inside it to look
  // at, so its outline is the whole of its shape.
  if (block.kind === 'unavailability')
    return 'bg-muted hatched border-muted-foreground/40 text-muted-foreground';
  return 'bg-secondary border-secondary-foreground/30 text-secondary-foreground';
}

/**
 * The block-column step for a block's activity type, or `null`.
 *
 * Null covers three different situations that all want the old neutral fill: a
 * fixed block, which has no activity type at all; a task whose type was deleted
 * out from under it; and a type still carrying no colour from before migration
 * 0018. None of them is worth a fourth appearance on the grid.
 */
function slotOf(block: GridBlock): string | null {
  if (block.activityTypeId === null) return null;
  return activityTypeById.value.get(block.activityTypeId)?.color ?? null;
}

function blockHueOf(block: GridBlock): string | null {
  const slot = slotOf(block);
  return slot === null ? null : `var(--activity-type-block-${slot})`;
}

/**
 * The ink on a block, published as a variable rather than applied as a colour.
 *
 * The done strip is a *sibling* of the block it belongs to — a button inside a
 * button is invalid — so it cannot inherit the block's foreground, and it was
 * reading `--primary-foreground` directly. On a hued block that is the wrong
 * white. One name, set on both, and the strip goes on being the block's own ink
 * at 20% without either of them knowing which case it is in.
 */
function inkOf(block: GridBlock): string {
  const slot = slotOf(block);
  return slot === null ? 'var(--primary-foreground)' : `var(--activity-type-ink-${slot})`;
}

/** The hue half of a block's appearance; `{}` where `classesFor` covers it. */
function styleFor(block: GridBlock): Record<string, string> {
  const hue = blockHueOf(block);
  if (hue === null) return {};

  // Faint, so the strike-through and the dashed edge are what carry "done" and
  // a finished afternoon does not shout as loudly as the one still to come.
  if (block.kind === 'completed') {
    return {
      backgroundColor: `color-mix(in oklab, ${hue} 22%, transparent)`,
      borderColor: `color-mix(in oklab, ${hue} 55%, transparent)`,
    };
  }

  return {
    backgroundColor: hue,
    // Not `hue`. A border the colour of what it surrounds is not a border, and
    // two blocks of one activity type that meet read as a single long one.
    borderColor: `color-mix(in oklab, ${hue} 60%, var(--block-edge))`,
    color: inkOf(block),
  };
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
          class="flex h-8 items-center gap-1.5 overflow-hidden border-b px-2 text-xs font-medium"
          :class="column.isToday ? 'text-primary' : 'text-muted-foreground'"
        >
          <span class="shrink-0">{{ column.label }}</span>
          <!--
            The name of the special week this day belongs to, in the amber the
            month view shades them with — one vocabulary for one fact, across
            two screens. Truncated with the full name on the title, because a
            column is seven and a half rem wide at its narrowest and "Christmas
            and New Year" is not.
          -->
          <span
            v-if="column.specialWeek !== null"
            class="truncate font-normal text-amber-700 dark:text-amber-300"
            :title="column.specialWeek"
            data-testid="special-week-day"
            :data-name="column.specialWeek"
          >
            {{ column.specialWeek }}
          </span>
        </div>

        <!--
          `editable` is what makes the column clickable, and there is no `role`
          on it: the same act has a button of its own in the toolbar, so this is
          an accelerator over a keyboard path that already exists rather than
          the only way to reach it. A `role="button"` on a sixteen-hour box
          would announce the whole day as one control.
        -->
        <div
          class="bg-muted relative border-l"
          :class="editable ? 'cursor-copy' : ''"
          :style="{ height: `${gridHeight}px` }"
          data-testid="day-body"
          @click="clickSlot(column.day, $event)"
        >
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
            :key="`lane-${lane.activityTypeId}-${lane.startMin}`"
            class="absolute overflow-hidden"
            :class="hueOf(lane.activityTypeId) === null ? 'bg-muted-foreground/[0.06]' : ''"
            :style="{
              top: `${offsetOf(lane.startMin)}px`,
              height: `${heightOfBand(lane)}px`,
              left: `${lane.offset * 100}%`,
              width: `${lane.width * 100}%`,
              ...(hueOf(lane.activityTypeId) === null
                ? {}
                : {
                    backgroundColor: `color-mix(in oklab, ${hueOf(lane.activityTypeId)} 14%, transparent)`,
                    borderLeft: `3px solid ${hueOf(lane.activityTypeId)}`,
                  }),
            }"
            data-testid="activity-type-lane"
            :data-activity-type-id="lane.activityTypeId"
            :data-start-min="lane.startMin"
            :title="nameOf(lane.activityTypeId)"
          >
            <span class="truncate px-1 text-[0.65rem] leading-4 text-(--ink-subtle)">
              {{ nameOf(lane.activityTypeId) }}
            </span>
          </div>

          <div
            v-for="mark in hourMarks"
            :key="`line-${mark}`"
            class="border-border/60 absolute inset-x-0 border-t"
            :style="{ top: `${offsetOf(mark)}px` }"
            aria-hidden="true"
          />

          <!--
            `flex-col` is not decoration: a `button` centres its content
            vertically, so a six-hour appointment drew its title halfway down
            the block with three hours of empty box above it. Every other block
            was too short for anyone to notice.
          -->
          <component
            :is="editable ? 'button' : 'article'"
            v-for="block in column.blocks"
            :key="block.key"
            :type="editable ? 'button' : undefined"
            data-grid-block
            class="focus-visible:ring-ring absolute flex touch-none flex-col items-stretch justify-start overflow-hidden rounded-sm border px-1.5 py-0.5 text-left text-xs leading-tight focus-visible:z-20 focus-visible:ring-2 focus-visible:outline-none"
            :class="[
              classesFor(block),
              isMoving(block) ? 'ring-primary z-10 ring-2' : '',
              expanded(block) ? 'z-10 shadow-md' : '',
            ]"
            :style="{
              ...boxOf(block),
              left: leftOf(block),
              width: widthOf(block),
              ...styleFor(block),
              ...(completable(block) ? { paddingRight: `${DONE_WIDTH + DONE_INSET}px` } : {}),
            }"
            :data-lane="block.lanes > 1 ? `${block.lane}/${block.lanes}` : undefined"
            :data-testid="`block-${block.kind}`"
            :data-activity-type-id="block.activityTypeId ?? undefined"
            :data-title="block.title"
            :data-start-min="startMinOf(block)"
            :data-end-min="block.endMin"
            :data-moving="isMoving(block) ? 'true' : undefined"
            :data-expanded="expanded(block) ? 'true' : undefined"
            :aria-label="labelFor(block, column.label)"
            :aria-grabbed="editable && block.kind === 'task' ? isMoving(block) : undefined"
            @pointerdown="beginDrag(block, column.day, $event)"
            @pointermove="duringDrag"
            @pointerup="endDrag(block)"
            @pointerenter="attend(block)"
            @pointerleave="release(block)"
            @focus="attend(block)"
            @blur="release(block)"
            @keydown.up.prevent="onArrow(block, column.day, -1, $event)"
            @keydown.down.prevent="onArrow(block, column.day, 1, $event)"
            @keydown.left.prevent="onHorizontal($event, -1)"
            @keydown.right.prevent="onHorizontal($event, 1)"
            @keydown.enter.prevent="toggleGrab(block, column.day)"
            @keydown.space.prevent="toggleGrab(block, column.day)"
            @keydown.esc.prevent="abandonNudge"
            @click.stop="onClick(block)"
          >
            <p
              class="truncate font-medium"
              :class="block.kind === 'completed' ? 'line-through' : ''"
            >
              <span v-if="block.continuesBefore" aria-hidden="true">↑ </span>{{ block.title
              }}<span v-if="block.continuesAfter" aria-hidden="true"> ↓</span>
            </p>
            <!--
              Weight, not opacity.

              The second line used to be the block's ink at 70%, which was a
              fine way to make it quieter while every block was one near-black.
              On a hued fill it is a contrast failure: the steps clear 5:1 at
              full strength, so *any* fade drops them under 4.5 — measured, the
              best a fade can do is 4.35 at 90%, and at the 70% this was it is
              3.23. The title is `font-medium` and this is not, which says the
              same thing about which line matters and says it legibly.
            -->
            <p class="font-normal tabular-nums">{{ block.label }}</p>
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
            class="text-(--block-ink) focus-visible:ring-ring absolute z-10 flex items-center justify-center overflow-hidden rounded-sm bg-[color-mix(in_oklab,var(--block-ink)_20%,transparent)] hover:bg-[color-mix(in_oklab,var(--block-ink)_35%,transparent)] focus-visible:z-20 focus-visible:ring-2 focus-visible:outline-none"
            :style="{
              '--block-ink': inkOf(block),
              ...boxOf(block),
              right: `calc(${rightOf(block)}% + ${DONE_INSET}px)`,
              width: `${DONE_WIDTH}px`,
            }"
            :aria-label="t('calendar.completeBlock', { title: block.title })"
            :title="t('calendar.completeBlock', { title: block.title })"
            data-testid="complete-block"
            :data-task-id="block.taskId"
            @click.stop="emit('completeBlock', block)"
            @pointerenter="attend(block)"
            @pointerleave="release(block)"
            @focus="attend(block)"
            @blur="release(block)"
          >
            <!--
              The strip joins in the block's attention rather than interrupting
              it: it covers the block's own right edge, so crossing onto it
              fires the block's `pointerleave`, and a control that collapsed
              the thing it belongs to is a control that moves as you reach it.
            -->
            <Check class="size-4 shrink-0" aria-hidden="true" />
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

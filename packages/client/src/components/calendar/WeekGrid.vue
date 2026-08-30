<script setup lang="ts">
import { computed, ref } from 'vue';
import type { FixedBlock, ScheduledBlock } from '@ambitime/shared';
import type { CivilDate } from '@ambitime/scheduler';
import {
  blocksForDay,
  dragOffsetMinutes,
  movedStartMin,
  SCALE,
  SNAP_MINUTES,
  type GridBlock,
} from '@/lib/grid';
import { formatDayLabel, formatMinuteOfDay, sameCivilDate } from '@/lib/time';

const props = withDefaults(
  defineProps<{
    days: CivilDate[];
    timeZone: string;
    blocks: ScheduledBlock[];
    fixedBlocks: FixedBlock[];
    today?: CivilDate | null;
    /** Visible span, in local minutes. Outside it there is nothing to show. */
    dayStartMin?: number;
    dayEndMin?: number;
    locale?: string;
    /** M11: the grid becomes a way in to the editors, not only a picture. */
    editable?: boolean;
  }>(),
  { today: null, dayStartMin: 6 * 60, dayEndMin: 22 * 60, locale: 'en-GB', editable: false },
);

const emit = defineEmits<{
  selectBlock: [block: GridBlock];
  addBlock: [day: CivilDate];
  /** A task dropped, or nudged, onto a new local start (spec §7.3, §13). */
  moveBlock: [payload: { block: GridBlock; day: CivilDate; startMin: number }];
  postponeDay: [day: CivilDate];
}>();

/**
 * A move in progress: which block, and how far it has been dragged so far.
 *
 * Held here rather than committed on every pointer move because a drag is one
 * intent, not fifty. The block follows the pointer; only the drop emits a
 * command.
 */
const pending = ref<{ key: string; day: CivilDate; offsetMin: number } | null>(null);

/** Where the pointer went down, in pixels — the origin every delta is from. */
let dragOriginY: number | null = null;

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
  // (§6.2 rule 2); dragging one would be editing it, which the editor does.
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

  emit('moveBlock', {
    block,
    day: move.day,
    startMin: movedStartMin(block, move.offsetMin, props.dayStartMin),
  });
}

/**
 * The keyboard equivalent §14 requires: "every drag-and-drop action needs a
 * keyboard-accessible equivalent".
 *
 * Arrows nudge by the same 15 minutes the pointer snaps to and move the block
 * on screen; Enter commits, Escape abandons. That is the same three-part
 * gesture a drag is — pick up, move, drop — rather than a different feature
 * wearing its name.
 */
function nudge(block: GridBlock, day: CivilDate, steps: number): void {
  if (!props.editable || block.kind !== 'task') return;
  const offsetMin = (isMoving(block) ? pending.value!.offsetMin : 0) + steps * SNAP_MINUTES;
  pending.value = { key: block.key, day, offsetMin };
}

function commitNudge(block: GridBlock): void {
  if (!isMoving(block)) return;
  endDrag(block);
}

function abandonNudge(): void {
  pending.value = null;
  dragOriginY = null;
}

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
    blocks: blocksForDay(day, props.timeZone, props.blocks, props.fixedBlocks),
  })),
);

function offsetOf(minute: number): number {
  return (minute - props.dayStartMin) * SCALE;
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

function classesFor(block: GridBlock): string {
  if (block.kind === 'task') return 'bg-primary/15 border-primary/40 text-foreground';
  if (block.kind === 'unavailability')
    return 'bg-muted border-muted-foreground/30 text-muted-foreground';
  return 'bg-secondary border-secondary-foreground/30 text-secondary-foreground';
}
</script>

<template>
  <div class="flex w-full overflow-x-auto" data-testid="week-grid">
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
          <span v-if="editable" class="flex items-center gap-1">
            <button
              type="button"
              class="hover:text-foreground px-1 leading-none"
              :aria-label="`Postpone the rest of ${column.label}`"
              title="Move the rest of this day's tasks into later days"
              data-testid="postpone-day"
              @click="emit('postponeDay', column.day)"
            >
              ⤓
            </button>
            <button
              type="button"
              class="hover:text-foreground px-1 leading-none"
              :aria-label="`Add a fixed block on ${column.label}`"
              data-testid="add-block"
              @click="emit('addBlock', column.day)"
            >
              +
            </button>
          </span>
        </div>

        <div
          class="bg-card relative border-l"
          :class="column.isToday ? 'bg-primary/[0.03]' : ''"
          :style="{ height: `${gridHeight}px` }"
        >
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
            class="absolute inset-x-1 touch-none overflow-hidden rounded-sm border px-1.5 py-0.5 text-left text-xs leading-tight"
            :class="[classesFor(block), isMoving(block) ? 'ring-primary z-10 ring-2' : '']"
            :style="{ top: `${offsetOf(startMinOf(block))}px`, height: `${heightOf(block)}px` }"
            :data-testid="`block-${block.kind}`"
            :data-title="block.title"
            :data-start-min="startMinOf(block)"
            :data-end-min="block.endMin"
            :data-moving="isMoving(block) ? 'true' : undefined"
            :aria-grabbed="editable && block.kind === 'task' ? isMoving(block) : undefined"
            @pointerdown="beginDrag(block, column.day, $event)"
            @pointermove="duringDrag"
            @pointerup="endDrag(block)"
            @keydown.up.prevent="nudge(block, column.day, -1)"
            @keydown.down.prevent="nudge(block, column.day, 1)"
            @keydown.enter.prevent="commitNudge(block)"
            @keydown.esc.prevent="abandonNudge"
            @click="!isMoving(block) && editable && emit('selectBlock', block)"
          >
            <p class="truncate font-medium">
              <span v-if="block.continuesBefore" aria-hidden="true">↑ </span>{{ block.title
              }}<span v-if="block.continuesAfter" aria-hidden="true"> ↓</span>
            </p>
            <p class="tabular-nums opacity-70">{{ block.label }}</p>
          </component>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { FixedBlock, ScheduledBlock } from '@ambitime/shared';
import type { CivilDate } from '@ambitime/scheduler';
import { blocksForDay, type GridBlock } from '@/lib/grid';
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
}>();

/** Pixels per minute. One number, so the axis and the blocks cannot disagree. */
const SCALE = 1.1;

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
          <button
            v-if="editable"
            type="button"
            class="hover:text-foreground px-1 leading-none"
            :aria-label="`Add a fixed block on ${column.label}`"
            data-testid="add-block"
            @click="emit('addBlock', column.day)"
          >
            +
          </button>
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
            class="absolute inset-x-1 overflow-hidden rounded-sm border px-1.5 py-0.5 text-left text-xs leading-tight"
            :class="classesFor(block)"
            :style="{ top: `${offsetOf(block.startMin)}px`, height: `${heightOf(block)}px` }"
            :data-testid="`block-${block.kind}`"
            :data-title="block.title"
            :data-start-min="block.startMin"
            :data-end-min="block.endMin"
            @click="editable && emit('selectBlock', block)"
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

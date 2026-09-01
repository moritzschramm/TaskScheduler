<script setup lang="ts">
import { computed } from 'vue';
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui';
import { formatMinuteOfDay } from '@/lib/time';
import { useWorkspace } from '@/lib/workspace';

/**
 * How much of a day the grid draws — one track, two handles.
 *
 * Two separate `input[range]`s were the cheap version and read as two unrelated
 * controls: nothing on screen said the second could not pass the first, and the
 * span they described had no visible extent. A range is one quantity, so it
 * gets one track, and `minStepsBetweenThumbs` makes the constraint a property
 * of the control rather than a repair applied afterwards.
 *
 * Reka rather than hand-rolled for the same reason as the dialog: two thumbs
 * means two roving `slider` roles, arrow and Home/End handling on each, and a
 * live value on both — all of which §14 requires and none of which is visible
 * when it is missing.
 *
 * Hour granularity, because this decides how tall a column is and nobody needs
 * their day to begin at 06:23.
 */
const { dayStartMin, dayEndMin, setDayRange } = useWorkspace();

const hours = computed<number[]>({
  get: () => [dayStartMin.value / 60, dayEndMin.value / 60],
  set: ([start, end]) => setDayRange((start ?? 0) * 60, (end ?? 24) * 60),
});
</script>

<template>
  <div class="flex items-center gap-2" data-testid="day-range">
    <span class="text-muted-foreground text-xs tabular-nums" data-testid="day-range-label">
      {{ formatMinuteOfDay(dayStartMin) }}–{{ formatMinuteOfDay(dayEndMin) }}
    </span>

    <SliderRoot
      v-model="hours"
      class="relative flex h-4 w-32 touch-none items-center select-none"
      :min="0"
      :max="24"
      :step="1"
      :min-steps-between-thumbs="1"
      data-testid="day-range-slider"
    >
      <SliderTrack class="bg-muted relative h-1 grow rounded-full">
        <SliderRange class="bg-primary absolute h-full rounded-full" />
      </SliderTrack>
      <SliderThumb
        class="border-primary bg-background focus-visible:ring-ring block size-3 rounded-full border-2 focus-visible:ring-2 focus-visible:outline-none"
        aria-label="First hour shown"
        :aria-valuetext="formatMinuteOfDay(dayStartMin)"
        data-testid="day-range-start"
      />
      <SliderThumb
        class="border-primary bg-background focus-visible:ring-ring block size-3 rounded-full border-2 focus-visible:ring-2 focus-visible:outline-none"
        aria-label="Last hour shown"
        :aria-valuetext="formatMinuteOfDay(dayEndMin)"
        data-testid="day-range-end"
      />
    </SliderRoot>
  </div>
</template>

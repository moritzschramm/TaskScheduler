<script setup lang="ts">
import { computed } from 'vue';
import { formatMinuteOfDay } from '@/lib/time';
import { useWorkspace } from '@/lib/workspace';

/**
 * How much of a day the grid draws.
 *
 * Two sliders rather than one two-handled track. A double-ended range control
 * has no native element, so building one means owning the keyboard behaviour,
 * the focus order and the announcements for both handles — and `input[range]`
 * already has all of that, twice. WCAG 2.1.1 comes free; what it costs is a
 * seam between the two, which the shared clamp below closes.
 *
 * Hour granularity, because this decides how tall a column is and nobody needs
 * their day to begin at 06:23.
 */
const { dayStartMin, dayEndMin, setDayRange } = useWorkspace();

const startHour = computed({
  get: () => dayStartMin.value / 60,
  set: (hour: number) => setDayRange(hour * 60, dayEndMin.value),
});

const endHour = computed({
  get: () => dayEndMin.value / 60,
  set: (hour: number) => setDayRange(dayStartMin.value, hour * 60),
});
</script>

<template>
  <div class="flex items-center gap-2" data-testid="day-range">
    <span class="text-muted-foreground text-xs tabular-nums" data-testid="day-range-label">
      {{ formatMinuteOfDay(dayStartMin) }}–{{ formatMinuteOfDay(dayEndMin) }}
    </span>

    <input
      v-model.number="startHour"
      type="range"
      min="0"
      max="23"
      step="1"
      class="accent-primary h-1 w-16"
      aria-label="First hour shown"
      :aria-valuetext="formatMinuteOfDay(dayStartMin)"
      data-testid="day-range-start"
    />
    <input
      v-model.number="endHour"
      type="range"
      min="1"
      max="24"
      step="1"
      class="accent-primary h-1 w-16"
      aria-label="Last hour shown"
      :aria-valuetext="formatMinuteOfDay(dayEndMin)"
      data-testid="day-range-end"
    />
  </div>
</template>

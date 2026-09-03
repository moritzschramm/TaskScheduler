<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '@/i18n';
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

/**
 * Which end the user took hold of, for as long as they are holding it.
 *
 * Reka reassigns the thumb it is dragging the moment the two cross — it sorts
 * the pair and follows the value, not the handle — so after one swap the rest
 * of the gesture moves the *other* end. Refusing the swapped pair is not
 * enough, because by then the drag has changed its mind about what it is
 * dragging. Remembering the answer from the start is.
 */
const grabbed = ref<'start' | 'end' | null>(null);

const hours = computed<number[]>({
  get: () => [dayStartMin.value / 60, dayEndMin.value / 60],
  set: (next) => apply(next),
});

function grab(end: 'start' | 'end'): void {
  grabbed.value = end;
  // Pointer capture lives on the thumb, so the release may land anywhere.
  globalThis.addEventListener?.('pointerup', release, { once: true });
  globalThis.addEventListener?.('keyup', release, { once: true });
}

function release(): void {
  grabbed.value = null;
}

/**
 * Takes a new pair, holding whichever end is not being dragged.
 *
 * `SliderRoot` sorts its values on every move, so dragging the right handle
 * past the left does not stop it — it re-labels them, and "shrink the day from
 * the evening" silently becomes "move the morning to midnight".
 * `minStepsBetweenThumbs` keeps them from touching; it does not keep them in
 * their lanes.
 *
 * So the stationary end is not taken from the pair at all: it is kept, and
 * `setDayRange` clamps the moving one against it. A drag that runs past the
 * other handle stops there instead of dragging it along.
 */
function apply(next: readonly number[]): void {
  const [low = 0, high = 24] = next;
  const start = dayStartMin.value / 60;
  const end = dayEndMin.value / 60;

  // Clamped against the held end before the setter sees it: `setDayRange`
  // resolves a crowded pair by moving the *end*, which is right when the start
  // is what changed and wrong when the start is what is being held.
  if (grabbed.value === 'start') {
    return setDayRange(Math.min(Math.min(low, high), end - 1) * 60, end * 60);
  }
  if (grabbed.value === 'end') {
    return setDayRange(start * 60, Math.max(Math.max(low, high), start + 1) * 60);
  }

  setDayRange(low * 60, high * 60);
}

const { t } = useI18n();
</script>

<template>
  <div class="flex items-center gap-2" data-testid="day-range">
    <span class="text-muted-foreground text-xs tabular-nums" data-testid="day-range-label">
      {{ formatMinuteOfDay(dayStartMin) }}–{{ formatMinuteOfDay(dayEndMin) }}
    </span>

    <SliderRoot
      v-model="hours"
      class="relative flex h-4 w-52 touch-none items-center select-none"
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
        :aria-label="t('calendar.firstHour')"
        :aria-valuetext="formatMinuteOfDay(dayStartMin)"
        data-testid="day-range-start"
        @pointerdown="grab('start')"
        @keydown="grab('start')"
      />
      <SliderThumb
        class="border-primary bg-background focus-visible:ring-ring block size-3 rounded-full border-2 focus-visible:ring-2 focus-visible:outline-none"
        :aria-label="t('calendar.lastHour')"
        :aria-valuetext="formatMinuteOfDay(dayEndMin)"
        data-testid="day-range-end"
        @pointerdown="grab('end')"
        @keydown="grab('end')"
      />
    </SliderRoot>
  </div>
</template>

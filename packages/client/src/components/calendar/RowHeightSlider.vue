<script setup lang="ts">
import { computed } from 'vue';
import { SliderRange, SliderRoot, SliderThumb, SliderTrack } from 'reka-ui';
import { MAX_SCALE, MIN_SCALE } from '@/lib/grid';
import { useI18n } from '@/i18n';
import { useWorkspace } from '@/lib/workspace';

/**
 * How tall an hour is drawn.
 *
 * The same kind of preference as the day range — about looking, not about
 * scheduling — and it answers the case the day range cannot: a week whose
 * fifteen-minute tasks are unreadable slivers, and one whose eight open hours
 * will not fit on a laptop. Cropping the day and stretching the rows are the
 * two halves of making a week legible, so they sit together.
 *
 * Held in pixels per hour, because that is a size a person can picture. The
 * grid works in pixels per minute, and the conversion happens here rather than
 * in the store so there is one place that knows the unit on screen.
 */
const { rowScale, setRowScale } = useWorkspace();
const { t } = useI18n();

const MINUTES_PER_HOUR = 60;

const perHour = computed<number[]>({
  get: () => [Math.round(rowScale.value * MINUTES_PER_HOUR)],
  set: ([value = DEFAULT_PER_HOUR]) => setRowScale(value / MINUTES_PER_HOUR),
});

const DEFAULT_PER_HOUR = 66;
</script>

<template>
  <div class="space-y-1.5" data-testid="row-height">
    <!--
      No number beside the label. "66px" is not a height anybody chooses on
      purpose; the week behind this popover redraws as the thumb moves, and
      that is the readout — in the only unit that matters. It is still
      announced, because a screen reader has no grid to watch.
    -->
    <p class="text-sm font-medium">{{ t('calendar.rowHeight') }}</p>

    <SliderRoot
      v-model="perHour"
      class="relative flex h-4 w-full touch-none items-center select-none"
      :min="Math.round(MIN_SCALE * MINUTES_PER_HOUR)"
      :max="Math.round(MAX_SCALE * MINUTES_PER_HOUR)"
      :step="2"
      data-testid="row-height-slider"
    >
      <SliderTrack class="bg-muted relative h-1 grow rounded-full">
        <SliderRange class="bg-primary absolute h-full rounded-full" />
      </SliderTrack>
      <SliderThumb
        class="border-primary bg-background focus-visible:ring-ring block size-3 rounded-full border-2 focus-visible:ring-2 focus-visible:outline-none"
        :aria-label="t('calendar.rowHeight')"
        :aria-valuetext="`${perHour[0]}px`"
        data-testid="row-height-thumb"
      />
    </SliderRoot>
  </div>
</template>

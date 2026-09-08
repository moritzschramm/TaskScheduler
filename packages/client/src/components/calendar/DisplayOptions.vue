<script setup lang="ts">
import { PopoverContent, PopoverPortal, PopoverRoot, PopoverTrigger } from 'reka-ui';
import { Settings2 } from 'lucide-vue-next';
import DayRangeSlider from '@/components/calendar/DayRangeSlider.vue';
import RowHeightSlider from '@/components/calendar/RowHeightSlider.vue';
import { computed } from 'vue';
import { useI18n } from '@/i18n';
import { weekdayNames } from '@/lib/time';
import { useWorkspace } from '@/lib/workspace';

/**
 * The controls that change how the week is *drawn*, folded behind one button.
 *
 * The zone caption and the day-range slider used to sit open beside the title,
 * where they were three things to read before reaching the two — the week and
 * what is on it — that anybody came for. None of them changes what is
 * scheduled; they change how much of it fits on a screen, which is exactly the
 * kind of setting that belongs one click away rather than always present.
 *
 * A popover rather than a dropdown menu: these are sliders, not commands, and a
 * menu that closes on the first interaction would make the day range impossible
 * to set.
 */
const { calendar, zone, locale, visibleWeekdays, setVisibleWeekdays } = useWorkspace();
const { t } = useI18n();

/** The seven, in ISO order with short names in the reader's language. */
const WEEKDAYS = computed(() =>
  weekdayNames(locale.value, 'short').map((label, index) => ({ value: index + 1, label })),
);

/**
 * The last day standing cannot be turned off.
 *
 * A grid with no columns is not a smaller calendar; it is a broken one, and a
 * checkbox that produced it would be an affordance for breaking the screen.
 * Disabled rather than absent, so the reason is visible where the rule is.
 */
function onlyOneLeft(day: number): boolean {
  return visibleWeekdays.value.length === 1 && visibleWeekdays.value.includes(day);
}

function toggle(day: number): void {
  setVisibleWeekdays(
    visibleWeekdays.value.includes(day)
      ? visibleWeekdays.value.filter((entry) => entry !== day)
      : [...visibleWeekdays.value, day],
  );
}
</script>

<template>
  <PopoverRoot>
    <PopoverTrigger
      class="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-md p-1.5 focus-visible:ring-2 focus-visible:outline-none"
      :aria-label="t('common.display')"
      :title="t('common.display')"
      data-testid="display-options"
    >
      <Settings2 class="size-4" aria-hidden="true" />
    </PopoverTrigger>

    <PopoverPortal disabled>
      <PopoverContent
        class="bg-popover text-popover-foreground z-50 w-72 rounded-md border p-4 shadow-md"
        align="start"
        :side-offset="6"
        data-testid="display-options-panel"
      >
        <div class="space-y-4">
          <div class="space-y-1.5">
            <p class="text-sm font-medium">{{ t('settings.timeZone') }}</p>
            <p class="text-muted-foreground text-xs" data-testid="calendar-zone">
              {{ zone }}
              <template v-if="calendar && zone !== calendar.timezone">
                <!--
                  Said out loud when the two differ: the grid is in your zone,
                  but this calendar's availability windows are wall-clock rules
                  in its own (§5.1), so "09:00 Monday" means something different
                  to the scheduler than the row you are looking at.
                -->
                <span data-testid="zone-divergence">
                  {{ t('calendar.plannerZone', { zone: calendar.timezone }) }}
                </span>
              </template>
            </p>
          </div>

          <DayRangeSlider />
          <RowHeightSlider />

          <!--
            Which columns to draw. A crop, not a rule: a hidden Saturday is
            still in the horizon and still gets things placed on it, which is
            what the "scheduled outside this week" notice is for.
          -->
          <fieldset class="space-y-1.5" data-testid="visible-weekdays">
            <legend class="text-sm font-medium">{{ t('calendar.daysShown') }}</legend>
            <div class="flex flex-wrap gap-1">
              <label
                v-for="day in WEEKDAYS"
                :key="day.value"
                class="flex cursor-pointer items-center gap-1.5 rounded-md border px-2 py-1 text-xs"
                :class="visibleWeekdays.includes(day.value) ? 'bg-secondary border-secondary' : ''"
              >
                <input
                  type="checkbox"
                  class="size-3"
                  :checked="visibleWeekdays.includes(day.value)"
                  :disabled="onlyOneLeft(day.value)"
                  :data-testid="`weekday-toggle-${day.value}`"
                  @change="toggle(day.value)"
                />
                {{ day.label }}
              </label>
            </div>
          </fieldset>
        </div>
      </PopoverContent>
    </PopoverPortal>
  </PopoverRoot>
</template>

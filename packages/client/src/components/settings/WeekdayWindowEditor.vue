<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { FOCUS_LEVELS } from '@/lib/focus';
import { formatMinuteOfDay, parseMinuteOfDay, weekdayNames } from '@/lib/time';
import type { RuleOverlap } from '@/lib/overlaps';

const { t } = useI18n();

/**
 * A week of wall-clock ranges — the shape shared by §9.1's two calendar windows
 * and §4.3's per-activity-type availability.
 *
 * **A weekday holds several ranges, not one.** "09:00–12:00 and 13:00–17:00" is
 * an ordinary working day, and the scheduler already resolves a weekday's
 * ranges as a union. An editor with one row per weekday would have made that
 * inexpressible and quietly redefined lunch as working time.
 *
 * A weekday with no ranges is unavailable. That is the same statement the
 * commands make — an empty set is an instruction, not a no-op — so what the
 * screen shows and what the command means are one thing.
 *
 * Times are entered in the **calendar's** zone, not the viewer's. The caller
 * says which, and it is displayed, because 09:00 is a different moment
 * depending on the answer and a user configuring a Berlin calendar from Lisbon
 * should not have to work that out.
 */

export interface WindowRule {
  weekday: number;
  startMin: number;
  endMin: number;
  focusLevel?: number | undefined;
}

const props = withDefaults(
  defineProps<{
    /** Shown in the caption so the zone the times mean is never implicit. */
    timeZone: string;
    locale?: string;
    /** Availability windows carry a focus profile (§6.5); calendar windows do not. */
    withFocus?: boolean;
    /**
     * Clashes with other activity types, to mark on the ranges they belong to.
     *
     * Passed in rather than computed here: this editor is also used for the
     * calendar windows of §9.1, which have no activity types to clash with.
     */
    overlaps?: readonly RuleOverlap[];
    disabled?: boolean;
  }>(),
  { locale: 'en-GB', withFocus: false, overlaps: () => [], disabled: false },
);

const model = defineModel<WindowRule[]>({ required: true });

const names = computed(() => weekdayNames(props.locale));

/** The rules of each weekday, in start order, with their index in the model. */
const byWeekday = computed(() =>
  Array.from({ length: 7 }, (_, offset) => {
    const weekday = offset + 1;
    return model.value
      .map((rule, index) => ({ rule, index }))
      .filter((entry) => entry.rule.weekday === weekday)
      .sort((a, b) => a.rule.startMin - b.rule.startMin);
  }),
);

function addRange(weekday: number): void {
  const existing = byWeekday.value[weekday - 1] ?? [];
  const last = existing[existing.length - 1]?.rule;
  // A second range starts an hour after the last one ends, so the common case —
  // splitting a day around lunch — needs no typing to be valid.
  const startMin = last === undefined ? 9 * 60 : Math.min(last.endMin + 60, 23 * 60);

  model.value = [...model.value, { weekday, startMin, endMin: Math.min(startMin + 60, 1440) }];
}

function removeRange(index: number): void {
  model.value = model.value.filter((_, position) => position !== index);
}

function update(index: number, patch: Partial<WindowRule>): void {
  model.value = model.value.map((rule, position) =>
    position === index ? { ...rule, ...patch } : rule,
  );
}

function setTime(index: number, edge: 'startMin' | 'endMin', value: string): void {
  const minutes = parseMinuteOfDay(value);
  // A half-typed time is not a change. Rejecting it here keeps the model always
  // valid, so the Save button never has a broken range to send.
  if (minutes === null) return;
  update(index, { [edge]: minutes });
}

function setFocus(index: number, value: string): void {
  update(index, { focusLevel: value === '' ? undefined : Number(value) });
}

/**
 * The clashes on one range, matched by the range itself.
 *
 * By value rather than by index: the model is rebuilt on every edit, so an
 * index would point at a different row the moment somebody added one above.
 */
function overlapsOn(rule: WindowRule): RuleOverlap[] {
  return props.overlaps.filter(
    (overlap) =>
      overlap.weekday === rule.weekday &&
      overlap.startMin === rule.startMin &&
      overlap.endMin === rule.endMin,
  );
}

/** A range the command layer would refuse, flagged before it is sent. */
function isBackwards(rule: WindowRule): boolean {
  return rule.startMin >= rule.endMin;
}
</script>

<template>
  <div class="space-y-1" data-testid="weekday-window-editor">
    <p class="text-muted-foreground text-xs">{{ t('hours.localTo', { zone: timeZone }) }}</p>

    <div
      v-for="(entries, offset) in byWeekday"
      :key="offset"
      class="grid grid-cols-[8rem_1fr] items-start gap-3 border-b py-2 last:border-b-0"
      :data-testid="`weekday-${offset + 1}`"
    >
      <span class="pt-2 text-sm font-medium">{{ names[offset] }}</span>

      <div class="space-y-2">
        <div
          v-for="entry in entries"
          :key="entry.index"
          class="flex flex-wrap items-center gap-2"
          data-testid="window-range"
        >
          <input
            type="time"
            class="border-input bg-background focus-visible:ring-ring h-9 rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            :value="formatMinuteOfDay(entry.rule.startMin)"
            :disabled="disabled"
            :aria-label="t('hours.startOf', { day: names[offset] ?? '' })"
            @input="setTime(entry.index, 'startMin', ($event.target as HTMLInputElement).value)"
          />
          <span class="text-muted-foreground text-sm">to</span>
          <input
            type="time"
            class="border-input bg-background focus-visible:ring-ring h-9 rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            :value="formatMinuteOfDay(entry.rule.endMin)"
            :disabled="disabled"
            :aria-label="t('hours.endOf', { day: names[offset] ?? '' })"
            @input="setTime(entry.index, 'endMin', ($event.target as HTMLInputElement).value)"
          />

          <Select
            v-if="withFocus"
            class="h-9 w-32"
            :model-value="entry.rule.focusLevel === undefined ? '' : String(entry.rule.focusLevel)"
            :disabled="disabled"
            :aria-label="t('hours.focusOf', { day: names[offset] ?? '' })"
            @update:model-value="setFocus(entry.index, $event ?? '')"
          >
            <option value="">{{ t('hours.anyFocus') }}</option>
            <option v-for="level in FOCUS_LEVELS" :key="level.value" :value="String(level.value)">
              {{ t(level.label) }}
            </option>
          </Select>

          <Button
            variant="ghost"
            size="sm"
            :disabled="disabled"
            :aria-label="
              t('hours.removeRange', {
                day: names[offset] ?? '',
                time: formatMinuteOfDay(entry.rule.startMin),
              })
            "
            data-testid="remove-range"
            @click="removeRange(entry.index)"
          >
            {{ t('common.remove') }}
          </Button>

          <span v-if="isBackwards(entry.rule)" class="text-destructive text-xs">
            {{ t('hours.backwards') }}
          </span>

          <!--
            Beside the range it belongs to, naming the other type and the
            minutes actually contested — not a banner at the top saying
            something on this screen clashes with something else.
          -->
          <span
            v-for="overlap in overlapsOn(entry.rule)"
            :key="`${overlap.otherName}-${overlap.sharedStartMin}`"
            class="rounded-sm bg-amber-100 px-1.5 py-0.5 text-xs text-amber-900 dark:bg-amber-900/40 dark:text-amber-200"
            data-testid="range-overlap"
            :data-other="overlap.otherName"
          >
            {{
              t('hours.overlap', {
                name: overlap.otherName,
                from: formatMinuteOfDay(overlap.sharedStartMin),
                until: formatMinuteOfDay(overlap.sharedEndMin),
              })
            }}
          </span>
        </div>

        <div class="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            :disabled="disabled"
            :data-testid="`add-range-${offset + 1}`"
            @click="addRange(offset + 1)"
          >
            {{ t('hours.addRange') }}
          </Button>
          <span v-if="entries.length === 0" class="text-muted-foreground text-xs">
            {{ t('hours.unavailable') }}
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

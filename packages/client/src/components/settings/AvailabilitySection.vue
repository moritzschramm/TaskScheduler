<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import WeekdayWindowEditor, { type WindowRule } from './WeekdayWindowEditor.vue';
import type { CalendarConfiguration, CommandRequest } from '@ambitime/shared';

/**
 * When each category may be scheduled in this calendar (spec §4.3).
 *
 * Two selectors address one set: the **category**, and the **week type** — the
 * default set, or the replacement set belonging to one week-type override. That
 * is the shape of the data (a window points at an override, or at nothing), and
 * a screen that flattened it would have to invent an answer to "which week is
 * this Tuesday?".
 *
 * The override sets are also where the difference matters most: an override
 * *replaces* the default set for its dates, so a holiday week with no windows
 * of its own is a week with no availability at all. Making that a visible,
 * separately-edited set is what stops it being a surprise.
 */
const props = defineProps<{
  configuration: CalendarConfiguration;
  submit: (request: CommandRequest) => Promise<boolean>;
}>();

const busy = ref(false);
const categoryId = ref('');
/** `''` addresses the default set; otherwise a week-type override's id. */
const weekTypeId = ref('');
const rules = ref<WindowRule[]>([]);

const readOnly = computed(() => !props.configuration.calendar.isOwner);

watch(
  () => props.configuration.categories,
  (categories) => {
    const stillThere = categories.some((category) => category.id === categoryId.value);
    if (!stillThere) categoryId.value = categories[0]?.id ?? '';
  },
  { immediate: true },
);

watch(
  () => props.configuration.weekTypeOverrides,
  (overrides) => {
    const stillThere = overrides.some((override) => override.id === weekTypeId.value);
    if (!stillThere) weekTypeId.value = '';
  },
  { immediate: true },
);

// Re-seeded whenever the address or the server's answer changes, so the editor
// always shows the set it is about to replace rather than the last one opened.
watch(
  [() => props.configuration.availability, categoryId, weekTypeId],
  ([availability]) => {
    rules.value = availability
      .filter(
        (window) =>
          window.categoryId === categoryId.value &&
          (window.weekTypeOverrideId ?? '') === weekTypeId.value,
      )
      .map(({ weekday, startMin, endMin, focusLevel }) => ({
        weekday,
        startMin,
        endMin,
        focusLevel: focusLevel ?? undefined,
      }));
  },
  { immediate: true },
);

async function save(): Promise<void> {
  if (categoryId.value === '') return;

  busy.value = true;
  try {
    await props.submit({
      type: 'SetAvailabilityWindows',
      params: {
        calendarId: props.configuration.calendar.id,
        categoryId: categoryId.value,
        ...(weekTypeId.value === '' ? {} : { weekTypeOverrideId: weekTypeId.value }),
        windows: rules.value.map(({ weekday, startMin, endMin, focusLevel }) => ({
          weekday,
          startMin,
          endMin,
          ...(focusLevel === undefined ? {} : { focusLevel }),
        })),
      },
    });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="space-y-4" data-testid="availability-section">
    <header>
      <h2 class="text-lg font-semibold">Availability</h2>
      <p class="text-muted-foreground text-sm">
        When each category may be scheduled. A week type replaces the default set for its dates
        rather than adding to it.
      </p>
    </header>

    <p v-if="configuration.categories.length === 0" class="text-muted-foreground text-sm">
      Add a category first — availability belongs to one.
    </p>

    <template v-else>
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-1">
          <Label for="availability-category">Category</Label>
          <Select
            id="availability-category"
            v-model="categoryId"
            :disabled="readOnly"
            data-testid="availability-category"
          >
            <option
              v-for="category in configuration.categories"
              :key="category.id"
              :value="category.id"
            >
              {{ category.name }}
            </option>
          </Select>
        </div>

        <div class="space-y-1">
          <Label for="availability-week-type">Week type</Label>
          <Select
            id="availability-week-type"
            v-model="weekTypeId"
            :disabled="readOnly"
            data-testid="availability-week-type"
          >
            <option value="">Default weeks</option>
            <option
              v-for="override in configuration.weekTypeOverrides"
              :key="override.id"
              :value="override.id"
            >
              {{ override.name }} ({{ override.startDate }} to {{ override.endDate }})
            </option>
          </Select>
        </div>
      </div>

      <WeekdayWindowEditor
        v-model="rules"
        with-focus
        :time-zone="configuration.calendar.timezone"
        :disabled="readOnly"
        data-testid="availability-editor"
      />

      <div class="flex items-center gap-3">
        <Button :disabled="readOnly || busy" data-testid="save-availability" @click="save">
          Save availability
        </Button>
        <span v-if="rules.length === 0" class="text-muted-foreground text-xs">
          Saving an empty week means this category is never scheduled here.
        </span>
      </div>
    </template>
  </section>
</template>

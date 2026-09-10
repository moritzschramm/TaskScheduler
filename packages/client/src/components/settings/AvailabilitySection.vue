<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '@/i18n';
import { useAutosave } from '@/lib/autosave';
import { overlappingRules } from '@/lib/overlaps';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import WeekdayWindowEditor, { type WindowRule } from './WeekdayWindowEditor.vue';
import type { CalendarConfiguration, CommandRequest } from '@ambitime/shared';

const { t } = useI18n();

/**
 * When each category may be scheduled in this planner (spec §4.3).
 *
 * Two selectors address one set: the **activity type**, and the **special
 * week** — the default set, or the replacement set belonging to one of them.
 * That is the shape of the data (a window points at a special week, or at
 * nothing), and a screen that flattened it would have to invent an answer to
 * "which week is this Tuesday?".
 *
 * Special weeks are where the difference matters most: one *replaces* the
 * default set for its dates, so a holiday with no windows of its own is a
 * stretch with no availability at all. Making that a visible, separately-edited
 * set is what stops it being a surprise.
 *
 * **No Save button.** A range is written when it is added, removed or changed.
 * The button was the last thing standing between "I set my hours" and hours
 * that were actually set — and a form whose whole content is a week of times
 * has no natural moment at which a person decides they are done.
 */
const props = defineProps<{
  configuration: CalendarConfiguration;
  submit: (request: CommandRequest) => Promise<boolean>;
}>();

const categoryId = ref('');
/** `''` addresses the default set; otherwise a special week's id. */
const weekTypeId = ref('');
const rules = ref<WindowRule[]>([]);

const autosave = useAutosave();

/**
 * Which set the editor is currently showing, as one string.
 *
 * The re-seed below keys off this rather than off the data, because the data
 * changes as a *result* of editing: every save re-reads, so a watch on the
 * windows alone would put the server's copy back over an edit in progress, one
 * round trip behind the user.
 */
const address = computed(() => `${categoryId.value}|${weekTypeId.value}`);
/** True while `rules` is being filled from the server, not by a person. */
let seeding = false;
const seededAddress = ref<string | null>(null);
/** Set on every change, cleared once a save of that change has landed. */
const unsent = ref(false);

const readOnly = computed(() => !props.configuration.calendar.isOwner);

/** The special week being edited, for the sentence that explains the selector. */
const selectedWeekName = computed(
  () =>
    props.configuration.weekTypeOverrides.find((override) => override.id === weekTypeId.value)
      ?.name ?? '',
);

/** Where these hours meet another activity type's; see `lib/overlaps`. */
const overlaps = computed(() =>
  overlappingRules({
    rules: rules.value,
    availability: props.configuration.availability,
    categories: props.configuration.categories,
    categoryId: categoryId.value,
    weekTypeOverrideId: weekTypeId.value === '' ? null : weekTypeId.value,
  }),
);

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

watch(
  [() => props.configuration.availability, address],
  ([availability, key]) => {
    // A change of address always re-seeds — it is a different set. The same
    // address only re-seeds when there is nothing typed and unsent, so an
    // answer to an earlier keystroke cannot overwrite a later one.
    if (key === seededAddress.value && unsent.value) return;

    seeding = true;
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

    seededAddress.value = key;
    seeding = false;
  },
  { immediate: true },
);

// Sync, so a seed's own assignment is still inside `seeding` when this runs.
watch(rules, () => !seeding && edited(), { flush: 'sync' });

/**
 * Writes the set as it now stands.
 *
 * The whole week goes every time, because that is what the command means: §4.3
 * describes a category as owning "the set", and `SetAvailabilityWindows`
 * replaces it. So adding one range and removing another are the same call, and
 * there is no partial state in between for a failure to leave behind.
 *
 * Backwards ranges are held back rather than sent and refused. The editor
 * already flags one in red, and a user dragging an end time past a start would
 * otherwise get an error banner for a value they are halfway through changing.
 */
function edited(): void {
  unsent.value = true;

  autosave.save('availability', async () => {
    if (categoryId.value === '' || readOnly.value) return;
    if (rules.value.some((rule) => rule.startMin >= rule.endMin)) return;

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

    unsent.value = false;
  });
}
</script>

<template>
  <section class="space-y-4" data-testid="availability-section">
    <header>
      <!--
        "Availability" described the wrong side of the relationship: it reads as
        the hours a *person* is free, when what these rows decide is the hours
        the *scheduler* may use — the two differ every time somebody is free at
        22:00 and has no intention of working then.
      -->
      <h2 class="text-lg font-semibold">{{ t('hours.title') }}</h2>
      <p class="text-muted-foreground text-sm">
        {{ t('hours.lead') }}
      </p>
    </header>

    <p v-if="configuration.categories.length === 0" class="text-muted-foreground text-sm">
      {{ t('hours.needCategory') }}
    </p>

    <template v-else>
      <div class="grid gap-4 sm:grid-cols-2">
        <div class="space-y-1">
          <Label for="availability-category">{{ t('hours.activityType') }}</Label>
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
          <Label for="availability-week-type">{{ t('hours.specialWeek') }}</Label>
          <Select
            id="availability-week-type"
            v-model="weekTypeId"
            :disabled="readOnly"
            data-testid="availability-week-type"
          >
            <option value="">{{ t('hours.ordinaryWeeks') }}</option>
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

      <!--
        What the second selector is *for*, said on the screen it is on.

        It reads as a filter — "show me the holiday hours" — and it is an
        address: a window belongs either to the default set or to one special
        week's replacement set, and this says which set is being edited. The
        difference matters most in the direction people do not expect, so the
        sentence for a special week says what an empty set means there.
      -->
      <p class="text-muted-foreground max-w-prose text-sm" data-testid="week-type-note">
        {{
          weekTypeId === ''
            ? t('hours.ordinaryNote')
            : t('hours.specialNote', { name: selectedWeekName })
        }}
      </p>

      <WeekdayWindowEditor
        v-model="rules"
        with-focus
        :time-zone="configuration.calendar.timezone"
        :overlaps="overlaps"
        :disabled="readOnly"
        data-testid="availability-editor"
      />

      <p v-if="overlaps.length > 0" class="text-muted-foreground max-w-prose text-xs">
        {{ t('hours.overlapNote') }}
      </p>

      <p v-if="rules.length === 0" class="text-muted-foreground text-xs">
        {{ t('hours.emptyMeansNever') }}
      </p>
    </template>
  </section>
</template>

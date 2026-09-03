<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from '@/i18n';
import { useAutosave } from '@/lib/autosave';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CalendarConfiguration, CommandRequest } from '@ambitime/shared';

const { t } = useI18n();

/**
 * Special weeks — a holiday, a conference week, parental leave (spec §4.3).
 *
 * Called "week types" until it was pointed out that the name describes the
 * database rather than the thing: what a person has is a fortnight away, and
 * what they want to see is that fortnight shaded on a calendar. The month view
 * is where these became legible, and the name follows it.
 *
 * A range of dates whose availability is edited separately, on Activity types.
 * Creating one immediately empties its dates, because it *replaces* the default
 * window set and a new one has no windows yet; the caption says so, since
 * discovering it from a blank fortnight would be a poor way to learn it.
 *
 * Dates are half-open — the end date is the first day back — which is stated
 * rather than implied, because every other interval in the system is half-open
 * and a calendar UI is where people expect the exception.
 */
const props = defineProps<{
  configuration: CalendarConfiguration;
  submit: (request: CommandRequest) => Promise<boolean>;
}>();

interface Draft {
  name: string;
  startDate: string;
  endDate: string;
}

const busy = ref(false);
const drafts = reactive(new Map<string, Draft>());
const fresh = ref<Draft>({ name: '', startDate: '', endDate: '' });

const autosave = useAutosave();

const readOnly = computed(() => !props.configuration.calendar.isOwner);

/** Membership only; an existing draft is the user's, not the server's. */
watch(
  () => props.configuration.weekTypeOverrides,
  (overrides) => {
    const live = new Set(overrides.map((override) => override.id));
    for (const id of [...drafts.keys()]) if (!live.has(id)) drafts.delete(id);

    for (const override of overrides) {
      if (drafts.has(override.id)) continue;
      drafts.set(override.id, {
        name: override.name,
        startDate: override.startDate,
        endDate: override.endDate,
      });
    }
  },
  { immediate: true },
);

const canCreate = computed(
  () =>
    fresh.value.name.trim() !== '' &&
    fresh.value.startDate !== '' &&
    fresh.value.endDate !== '' &&
    fresh.value.startDate < fresh.value.endDate,
);

async function create(): Promise<void> {
  busy.value = true;
  try {
    const ok = await props.submit({
      type: 'CreateWeekTypeOverride',
      params: {
        calendarId: props.configuration.calendar.id,
        name: fresh.value.name,
        startDate: fresh.value.startDate,
        endDate: fresh.value.endDate,
      },
    });
    if (ok) fresh.value = { name: '', startDate: '', endDate: '' };
  } finally {
    busy.value = false;
  }
}

/**
 * Queues a save of one row, reading its version as the save runs (§5.4).
 *
 * A half-entered range is not sent. A `<input type=date>` reports an empty
 * value while it is being filled in, and a command with no start date would be
 * refused — noisily, in the middle of typing the one that follows it.
 */
function edited(id: string): void {
  autosave.save(id, async () => {
    const override = props.configuration.weekTypeOverrides.find((entry) => entry.id === id);
    const draft = drafts.get(id);
    if (override === undefined || draft === undefined) return;
    if (draft.name.trim() === '' || draft.startDate >= draft.endDate) return;

    await props.submit({
      type: 'EditWeekTypeOverride',
      expectedVersion: override.version,
      params: {
        weekTypeOverrideId: id,
        patch: { name: draft.name, startDate: draft.startDate, endDate: draft.endDate },
      },
    });
  });
}

async function remove(id: string, version: number): Promise<void> {
  busy.value = true;
  try {
    await props.submit({
      type: 'DeleteWeekTypeOverride',
      expectedVersion: version,
      params: { weekTypeOverrideId: id },
    });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="space-y-4" data-testid="overrides-section">
    <header>
      <h2 class="text-lg font-semibold">{{ t('specialWeeks.title') }}</h2>
      <p class="text-muted-foreground text-sm">
        {{ t('specialWeeks.lead') }}
      </p>
    </header>

    <table class="w-full text-sm">
      <thead class="text-muted-foreground text-left text-xs">
        <tr>
          <th class="pb-2 font-medium">{{ t('common.name') }}</th>
          <th class="pb-2 font-medium">{{ t('common.from') }}</th>
          <th class="pb-2 font-medium">{{ t('common.until') }}</th>
          <th class="pb-2">
            <span class="sr-only">{{ t('tasks.column.actions') }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="override in configuration.weekTypeOverrides"
          :key="override.id"
          class="border-t"
          data-testid="override-row"
        >
          <td class="py-2 pr-3">
            <Input
              v-if="drafts.get(override.id)"
              v-model="drafts.get(override.id)!.name"
              :disabled="readOnly"
              :aria-label="t('categories.nameOf', { name: override.name })"
              data-testid="override-name"
              @input="edited(override.id)"
            />
          </td>
          <td class="w-40 py-2 pr-3">
            <Input
              v-if="drafts.get(override.id)"
              v-model="drafts.get(override.id)!.startDate"
              type="date"
              :disabled="readOnly"
              :aria-label="t('specialWeeks.startOf', { name: override.name })"
              @input="edited(override.id)"
            />
          </td>
          <td class="w-40 py-2 pr-3">
            <Input
              v-if="drafts.get(override.id)"
              v-model="drafts.get(override.id)!.endDate"
              type="date"
              :disabled="readOnly"
              :aria-label="t('specialWeeks.endOf', { name: override.name })"
              @input="edited(override.id)"
            />
          </td>
          <td class="py-2">
            <div class="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                :disabled="readOnly || busy || autosave.busy.value"
                :aria-label="t('categories.deleteNamed', { name: override.name })"
                data-testid="delete-override"
                @click="remove(override.id, override.version)"
              >
                {{ t('common.delete') }}
              </Button>
            </div>
          </td>
        </tr>

        <tr class="border-t">
          <td class="py-2 pr-3">
            <Label for="new-override-name" class="sr-only">{{ t('specialWeeks.newName') }}</Label>
            <Input
              id="new-override-name"
              v-model="fresh.name"
              :placeholder="t('specialWeeks.namePlaceholder')"
              :disabled="readOnly"
              data-testid="new-override-name"
            />
          </td>
          <td class="py-2 pr-3">
            <Label for="new-override-start" class="sr-only">{{ t('specialWeeks.newStart') }}</Label>
            <Input
              id="new-override-start"
              v-model="fresh.startDate"
              type="date"
              :disabled="readOnly"
              data-testid="new-override-start"
            />
          </td>
          <td class="py-2 pr-3">
            <Label for="new-override-end" class="sr-only">{{ t('specialWeeks.newEnd') }}</Label>
            <Input
              id="new-override-end"
              v-model="fresh.endDate"
              type="date"
              :disabled="readOnly"
              data-testid="new-override-end"
            />
          </td>
          <td class="py-2 text-right">
            <Button
              size="sm"
              :disabled="readOnly || busy || !canCreate"
              data-testid="add-override"
              @click="create"
            >
              {{ t('common.add') }}
            </Button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

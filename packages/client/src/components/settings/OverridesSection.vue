<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CalendarConfiguration, CommandRequest } from '@ambitime/shared';

/**
 * Week-type overrides — holidays, a conference week, parental leave (spec §4.3).
 *
 * A range of dates whose availability is edited separately, in the section
 * above. Creating one immediately empties its dates, because an override
 * *replaces* the default window set and a new one has no windows yet; the
 * caption says so, since discovering it from a blank fortnight would be a poor
 * way to learn it.
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

const readOnly = computed(() => !props.configuration.calendar.isOwner);

watch(
  () => props.configuration.weekTypeOverrides,
  (overrides) => {
    drafts.clear();
    for (const override of overrides) {
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

async function save(id: string, version: number): Promise<void> {
  const draft = drafts.get(id);
  if (draft === undefined) return;

  busy.value = true;
  try {
    await props.submit({
      type: 'EditWeekTypeOverride',
      expectedVersion: version,
      params: {
        weekTypeOverrideId: id,
        patch: { name: draft.name, startDate: draft.startDate, endDate: draft.endDate },
      },
    });
  } finally {
    busy.value = false;
  }
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
      <h2 class="text-lg font-semibold">Week types</h2>
      <p class="text-muted-foreground text-sm">
        A date range whose availability replaces the default one. A new week type has no windows
        yet, so its dates are unavailable until you give it some. The end date is the first day
        back.
      </p>
    </header>

    <table class="w-full text-sm">
      <thead class="text-muted-foreground text-left text-xs">
        <tr>
          <th class="pb-2 font-medium">Name</th>
          <th class="pb-2 font-medium">From</th>
          <th class="pb-2 font-medium">Until</th>
          <th class="pb-2"><span class="sr-only">Actions</span></th>
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
              :aria-label="`Name of ${override.name}`"
              data-testid="override-name"
            />
          </td>
          <td class="w-40 py-2 pr-3">
            <Input
              v-if="drafts.get(override.id)"
              v-model="drafts.get(override.id)!.startDate"
              type="date"
              :disabled="readOnly"
              :aria-label="`Start of ${override.name}`"
            />
          </td>
          <td class="w-40 py-2 pr-3">
            <Input
              v-if="drafts.get(override.id)"
              v-model="drafts.get(override.id)!.endDate"
              type="date"
              :disabled="readOnly"
              :aria-label="`End of ${override.name}`"
            />
          </td>
          <td class="py-2">
            <div class="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                :disabled="readOnly || busy"
                data-testid="save-override"
                @click="save(override.id, override.version)"
              >
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                :disabled="readOnly || busy"
                :aria-label="`Delete ${override.name}`"
                data-testid="delete-override"
                @click="remove(override.id, override.version)"
              >
                Delete
              </Button>
            </div>
          </td>
        </tr>

        <tr class="border-t">
          <td class="py-2 pr-3">
            <Label for="new-override-name" class="sr-only">New week type name</Label>
            <Input
              id="new-override-name"
              v-model="fresh.name"
              placeholder="Conference"
              :disabled="readOnly"
              data-testid="new-override-name"
            />
          </td>
          <td class="py-2 pr-3">
            <Label for="new-override-start" class="sr-only">New week type start</Label>
            <Input
              id="new-override-start"
              v-model="fresh.startDate"
              type="date"
              :disabled="readOnly"
              data-testid="new-override-start"
            />
          </td>
          <td class="py-2 pr-3">
            <Label for="new-override-end" class="sr-only">New week type end</Label>
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
              Add
            </Button>
          </td>
        </tr>
      </tbody>
    </table>
  </section>
</template>

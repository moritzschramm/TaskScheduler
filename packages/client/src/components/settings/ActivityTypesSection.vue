<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { useI18n } from '@/i18n';
import { useAutosave } from '@/lib/autosave';
import { useOptimisticRemoval } from '@/lib/optimistic-removal';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  ACTIVITY_TYPE_COLORS,
  type CalendarConfiguration,
  type ActivityTypeColor,
  type CommandRequest,
} from '@ambitime/shared';

const { t } = useI18n();

/**
 * Activity types — the kinds of activity a task can be (spec §4.3).
 *
 * Tenant-scoped rather than per-calendar, which the caption says out loud: a
 * activity type created here appears in every calendar in the context, and someone
 * who thought otherwise would build the same four activity types four times.
 *
 * Edited in place rather than in a dialog. There are two fields, and a modal
 * for two fields costs a user more attention than it saves them.
 *
 * **No Save button.** A change to a name or a cooldown is saved once you stop
 * typing; see `useAutosave` for why that is safe to do on every keystroke.
 * Add and Delete keep their buttons, because both are discrete acts rather
 * than edits — one needs a moment to say the row is complete, and the other is
 * not something to do because a field lost focus.
 */
const props = defineProps<{
  configuration: CalendarConfiguration;
  submit: (request: CommandRequest) => Promise<boolean>;
}>();

interface Draft {
  name: string;
  defaultCooldownMin: number;
  /**
   * On the new-type row, `''` means "choose one for me" — the server takes the
   * next free slot, which is what makes the first three types legible without
   * anybody opening the picker (§4.3).
   *
   * On an existing row it is only ever a *legacy* value: a type created before
   * the palette started reusing slots, or one whose colour an undo restored to
   * null. The picker offers it as the current state and refuses to go back to
   * it, because a type with no colour draws as a grey lane and grey already
   * means "unavailable" everywhere else on the grid.
   */
  color: ActivityTypeColor | '';
}

const busy = ref(false);
const drafts = reactive(new Map<string, Draft>());
const fresh = ref<Draft>({ name: '', defaultCooldownMin: 0, color: '' });

const autosave = useAutosave();
const pending = useOptimisticRemoval();

/**
 * Reconciles which rows exist; never overwrites one that does.
 *
 * Every save re-reads, so this watch fires moments after each keystroke
 * settles. Re-seeding wholesale — which is what it used to do, correctly, for
 * a form with a Save button — would put the server's copy back into a field
 * somebody is still typing in, one round trip behind them.
 */
watch(
  () => props.configuration.activityTypes,
  (activityTypes) => {
    const live = new Set(activityTypes.map((activityType) => activityType.id));
    for (const id of [...drafts.keys()]) if (!live.has(id)) drafts.delete(id);

    for (const activityType of activityTypes) {
      if (drafts.has(activityType.id)) continue;
      drafts.set(activityType.id, {
        name: activityType.name,
        defaultCooldownMin: activityType.defaultCooldownMin,
        color: activityType.color ?? '',
      });
    }
  },
  { immediate: true },
);

async function create(): Promise<void> {
  busy.value = true;
  try {
    const ok = await props.submit({
      type: 'CreateActivityType',
      params: {
        name: fresh.value.name,
        defaultCooldownMin: Number(fresh.value.defaultCooldownMin),
        // Omitted rather than sent empty, so the server picks the next free
        // slot in order — the whole point of the default.
        ...(fresh.value.color === '' ? {} : { color: fresh.value.color }),
      },
    });
    if (ok) fresh.value = { name: '', defaultCooldownMin: 0, color: '' };
  } finally {
    busy.value = false;
  }
}

/**
 * Queues a save of one row.
 *
 * The version and the draft are read when the save *runs*, not when it is
 * queued: a debounced closure over the version the row had eight keystrokes ago
 * would be refused as a conflict with the user's own earlier save (§5.4).
 */
function edited(id: string): void {
  autosave.save(id, async () => {
    const activityType = props.configuration.activityTypes.find((entry) => entry.id === id);
    const draft = drafts.get(id);
    if (activityType === undefined || draft === undefined || draft.name.trim() === '') return;

    await props.submit({
      type: 'EditActivityType',
      expectedVersion: activityType.version,
      params: {
        activityTypeId: id,
        patch: {
          name: draft.name,
          defaultCooldownMin: Number(draft.defaultCooldownMin),
          // Absent, never null: a legacy colourless type keeps its state until
          // somebody picks a hue, and nothing here can put one back.
          ...(draft.color === '' ? {} : { color: draft.color }),
        },
      },
    });
  });
}

async function remove(id: string, version: number): Promise<void> {
  busy.value = true;
  try {
    await pending.removing(id, async () => {
      // The command refuses while tasks still use it, and says so; nothing is
      // asked here beforehand, because a confirmation dialog would be guessing
      // at an answer the server already knows — and a refusal puts the row back.
      return props.submit({
        type: 'DeleteActivityType',
        expectedVersion: version,
        params: { activityTypeId: id },
      });
    });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="space-y-4" data-testid="activity-types-section">
    <header>
      <h2 class="sr-only">{{ t('activityTypes.title') }}</h2>
      <p class="text-muted-foreground text-sm">
        {{ t('activityTypes.shared') }}
      </p>
    </header>

    <table class="w-full text-sm">
      <thead class="text-muted-foreground text-left text-xs">
        <tr>
          <th class="pb-2 font-medium">{{ t('common.name') }}</th>
          <th class="pb-2 font-medium">{{ t('activityTypes.cooldown') }}</th>
          <th class="pb-2 font-medium">{{ t('activityTypes.color') }}</th>
          <th class="pb-2">
            <span class="sr-only">{{ t('tasks.column.actions') }}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="activityType in configuration.activityTypes.filter(
            (row) => !pending.isRemoved(row.id),
          )"
          :key="activityType.id"
          class="border-t"
          data-testid="activity-type-row"
        >
          <td class="py-2 pr-3">
            <Input
              v-if="drafts.get(activityType.id)"
              v-model="drafts.get(activityType.id)!.name"
              :aria-label="t('activityTypes.nameOf', { name: activityType.name })"
              data-testid="activity-type-name"
              @input="edited(activityType.id)"
            />
          </td>
          <td class="w-32 py-2 pr-3">
            <Input
              v-if="drafts.get(activityType.id)"
              v-model.number="drafts.get(activityType.id)!.defaultCooldownMin"
              type="number"
              min="0"
              :aria-label="t('activityTypes.cooldownOf', { name: activityType.name })"
              data-testid="activity-type-cooldown"
              @input="edited(activityType.id)"
            />
          </td>
          <td class="w-44 py-2 pr-3">
            <div v-if="drafts.get(activityType.id)" class="flex items-center gap-2">
              <!--
                A swatch beside the name of the colour, never instead of it.
                Eight hues cannot all be told apart by every reader, so the
                select carries the word and this shows which one it means.
              -->
              <span
                class="size-4 shrink-0 rounded-sm border"
                :style="
                  drafts.get(activityType.id)!.color === ''
                    ? {}
                    : {
                        backgroundColor: `var(--activity-type-${drafts.get(activityType.id)!.color})`,
                      }
                "
                data-testid="activity-type-swatch"
                :data-color="drafts.get(activityType.id)!.color"
                aria-hidden="true"
              />
              <Select
                v-model="drafts.get(activityType.id)!.color"
                class="h-9"
                :aria-label="t('activityTypes.colorOf', { name: activityType.name })"
                data-testid="activity-type-color"
                @update:model-value="edited(activityType.id)"
              >
                <!--
                  Present only when it is already the answer, and disabled, so
                  the select can show the state of a type made before every one
                  of them had a colour without offering to put another there.
                -->
                <option v-if="drafts.get(activityType.id)!.color === ''" value="" disabled>
                  {{ t('activityTypes.noColor') }}
                </option>
                <option v-for="hue in ACTIVITY_TYPE_COLORS" :key="hue" :value="hue">
                  {{ t(`activityTypes.hue.${hue}`) }}
                </option>
              </Select>
            </div>
          </td>
          <td class="py-2">
            <div class="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                :disabled="busy || autosave.busy.value"
                :aria-label="t('activityTypes.deleteNamed', { name: activityType.name })"
                data-testid="delete-activity-type"
                @click="remove(activityType.id, activityType.version)"
              >
                {{ t('common.delete') }}
              </Button>
            </div>
          </td>
        </tr>

        <tr class="border-t">
          <td class="py-2 pr-3">
            <Label for="new-activity-type-name" class="sr-only">{{
              t('activityTypes.newName')
            }}</Label>
            <Input
              id="new-activity-type-name"
              v-model="fresh.name"
              :placeholder="t('activityTypes.namePlaceholder')"
              data-testid="new-activity-type-name"
            />
          </td>
          <td class="py-2 pr-3">
            <Label for="new-activity-type-cooldown" class="sr-only">{{
              t('activityTypes.newCooldown')
            }}</Label>
            <Input
              id="new-activity-type-cooldown"
              v-model.number="fresh.defaultCooldownMin"
              type="number"
              min="0"
              data-testid="new-activity-type-cooldown"
            />
          </td>
          <td class="py-2 pr-3">
            <Select
              v-model="fresh.color"
              class="h-9"
              :aria-label="t('activityTypes.color')"
              data-testid="new-activity-type-color"
            >
              <!--
                The default, and it does not mean "none": the server takes the
                next free slot, which is how the first three activity types end
                up in the three hues that separate for every reader.
              -->
              <option value="">{{ t('activityTypes.autoColor') }}</option>
              <option v-for="hue in ACTIVITY_TYPE_COLORS" :key="hue" :value="hue">
                {{ t(`activityTypes.hue.${hue}`) }}
              </option>
            </Select>
          </td>
          <td class="py-2 text-right">
            <Button
              size="sm"
              :disabled="busy || fresh.name.trim() === ''"
              data-testid="add-activity-type"
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

<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import { useAutosave } from '@/lib/autosave';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { CalendarConfiguration, CommandRequest } from '@ambitime/shared';

/**
 * Categories — the kinds of activity a task can be (spec §4.3).
 *
 * Tenant-scoped rather than per-calendar, which the caption says out loud: a
 * category created here appears in every calendar in the context, and someone
 * who thought otherwise would build the same four categories four times.
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
}

const busy = ref(false);
const drafts = reactive(new Map<string, Draft>());
const fresh = ref<Draft>({ name: '', defaultCooldownMin: 0 });

const autosave = useAutosave();

/**
 * Reconciles which rows exist; never overwrites one that does.
 *
 * Every save re-reads, so this watch fires moments after each keystroke
 * settles. Re-seeding wholesale — which is what it used to do, correctly, for
 * a form with a Save button — would put the server's copy back into a field
 * somebody is still typing in, one round trip behind them.
 */
watch(
  () => props.configuration.categories,
  (categories) => {
    const live = new Set(categories.map((category) => category.id));
    for (const id of [...drafts.keys()]) if (!live.has(id)) drafts.delete(id);

    for (const category of categories) {
      if (drafts.has(category.id)) continue;
      drafts.set(category.id, {
        name: category.name,
        defaultCooldownMin: category.defaultCooldownMin,
      });
    }
  },
  { immediate: true },
);

async function create(): Promise<void> {
  busy.value = true;
  try {
    const ok = await props.submit({
      type: 'CreateCategory',
      params: {
        name: fresh.value.name,
        defaultCooldownMin: Number(fresh.value.defaultCooldownMin),
      },
    });
    if (ok) fresh.value = { name: '', defaultCooldownMin: 0 };
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
    const category = props.configuration.categories.find((entry) => entry.id === id);
    const draft = drafts.get(id);
    if (category === undefined || draft === undefined || draft.name.trim() === '') return;

    await props.submit({
      type: 'EditCategory',
      expectedVersion: category.version,
      params: {
        categoryId: id,
        patch: { name: draft.name, defaultCooldownMin: Number(draft.defaultCooldownMin) },
      },
    });
  });
}

async function remove(id: string, version: number): Promise<void> {
  busy.value = true;
  try {
    // The command refuses while tasks still use it, and says so; nothing is
    // asked here beforehand, because a confirmation dialog would be guessing at
    // an answer the server already knows.
    await props.submit({
      type: 'DeleteCategory',
      expectedVersion: version,
      params: { categoryId: id },
    });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="space-y-4" data-testid="categories-section">
    <header>
      <h2 class="sr-only">Activity types</h2>
      <p class="text-muted-foreground text-sm">
        Shared across every planner you own. The cooldown is protected time after each task of the
        kind, and cannot be compressed. Changes save themselves.
      </p>
    </header>

    <table class="w-full text-sm">
      <thead class="text-muted-foreground text-left text-xs">
        <tr>
          <th class="pb-2 font-medium">Name</th>
          <th class="pb-2 font-medium">Cooldown (min)</th>
          <th class="pb-2"><span class="sr-only">Actions</span></th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="category in configuration.categories"
          :key="category.id"
          class="border-t"
          data-testid="category-row"
        >
          <td class="py-2 pr-3">
            <Input
              v-if="drafts.get(category.id)"
              v-model="drafts.get(category.id)!.name"
              :aria-label="`Name of ${category.name}`"
              data-testid="category-name"
              @input="edited(category.id)"
            />
          </td>
          <td class="w-32 py-2 pr-3">
            <Input
              v-if="drafts.get(category.id)"
              v-model.number="drafts.get(category.id)!.defaultCooldownMin"
              type="number"
              min="0"
              :aria-label="`Cooldown for ${category.name}`"
              data-testid="category-cooldown"
              @input="edited(category.id)"
            />
          </td>
          <td class="py-2">
            <div class="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                :disabled="busy || autosave.busy.value"
                :aria-label="`Delete ${category.name}`"
                data-testid="delete-category"
                @click="remove(category.id, category.version)"
              >
                Delete
              </Button>
            </div>
          </td>
        </tr>

        <tr class="border-t">
          <td class="py-2 pr-3">
            <Label for="new-category-name" class="sr-only">New category name</Label>
            <Input
              id="new-category-name"
              v-model="fresh.name"
              placeholder="Exercise"
              data-testid="new-category-name"
            />
          </td>
          <td class="py-2 pr-3">
            <Label for="new-category-cooldown" class="sr-only">New category cooldown</Label>
            <Input
              id="new-category-cooldown"
              v-model.number="fresh.defaultCooldownMin"
              type="number"
              min="0"
              data-testid="new-category-cooldown"
            />
          </td>
          <td class="py-2 text-right">
            <Button
              size="sm"
              :disabled="busy || fresh.name.trim() === ''"
              data-testid="add-category"
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

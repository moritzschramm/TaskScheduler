<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
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

watch(
  () => props.configuration.categories,
  (categories) => {
    drafts.clear();
    for (const category of categories) {
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

async function save(id: string, version: number): Promise<void> {
  const draft = drafts.get(id);
  if (draft === undefined) return;

  busy.value = true;
  try {
    await props.submit({
      type: 'EditCategory',
      expectedVersion: version,
      params: {
        categoryId: id,
        patch: { name: draft.name, defaultCooldownMin: Number(draft.defaultCooldownMin) },
      },
    });
  } finally {
    busy.value = false;
  }
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
      <h2 class="text-lg font-semibold">Activity types</h2>
      <p class="text-muted-foreground text-sm">
        Shared across every planner you own. The cooldown is protected time after each task of the
        kind, and cannot be compressed.
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
            />
          </td>
          <td class="py-2">
            <div class="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                :disabled="busy"
                data-testid="save-category"
                @click="save(category.id, category.version)"
              >
                Save
              </Button>
              <Button
                variant="ghost"
                size="sm"
                :disabled="busy"
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

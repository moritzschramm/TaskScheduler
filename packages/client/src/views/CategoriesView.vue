<script setup lang="ts">
import { onMounted } from 'vue';
import AvailabilitySection from '@/components/settings/AvailabilitySection.vue';
import CategoriesSection from '@/components/settings/CategoriesSection.vue';
import WorkspaceStatus from '@/components/WorkspaceStatus.vue';
import { useWorkspace } from '@/lib/workspace';

/**
 * The kinds of thing you do, and when you may do them (spec §4.3, §6.2 rule 1).
 *
 * Promoted out of settings because it is not a setting — it is the thing that
 * makes scheduling possible at all. "A task is placed within an availability
 * window of **its category**": no category, no window, nothing placed. Filed
 * under Settings it read as optional polish, next to the timezone picker, and
 * a screen you can skip is a screen that leaves the calendar empty.
 *
 * The two halves are here together because neither is any use alone. A category
 * with no hours schedules nothing; hours belong to a category and cannot be
 * entered without one.
 */
const { configuration, categories, ensureLoaded, submit } = useWorkspace();

onMounted(ensureLoaded);
</script>

<template>
  <div class="flex flex-col gap-8 p-6" data-testid="categories-view">
    <header class="max-w-prose space-y-1">
      <h1 class="text-xl font-semibold tracking-tight">Activity types</h1>
      <p class="text-muted-foreground text-sm">
        An activity type is a kind of thing you do — work, exercise, errands — and the hours you are
        willing to do it in. Every task belongs to one, and those hours are the only times it can be
        scheduled.
      </p>
    </header>

    <WorkspaceStatus />

    <template v-if="configuration">
      <CategoriesSection :configuration="configuration" :submit="submit" />

      <section v-if="categories.length === 0" class="max-w-prose" data-testid="no-categories-hint">
        <p class="text-muted-foreground text-sm">
          Add an activity type above, then give it the hours it may be scheduled in.
        </p>
      </section>
      <AvailabilitySection v-else :configuration="configuration" :submit="submit" />
    </template>
  </div>
</template>

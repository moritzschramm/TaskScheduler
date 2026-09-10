<script setup lang="ts">
import { onMounted } from 'vue';
import { useI18n } from '@/i18n';
import AvailabilitySection from '@/components/settings/AvailabilitySection.vue';
import CategoriesSection from '@/components/settings/CategoriesSection.vue';
import OverridesSection from '@/components/settings/OverridesSection.vue';
import WorkspaceStatus from '@/components/WorkspaceStatus.vue';
import { useWorkspace } from '@/lib/workspace';

const { t } = useI18n();

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
 *
 * **Special weeks are the third.** They were defined on the Appointments page
 * and filled in here, through a selector that named them — so a holiday was
 * declared on one screen and given its hours on another, and the fact that one
 * *replaces* the other had nowhere to be said. They are a rule about
 * availability, which is what this page is.
 */
const { configuration, categories, ensureLoaded, submit } = useWorkspace();

onMounted(ensureLoaded);
</script>

<template>
  <div class="flex flex-col gap-8 p-6" data-testid="categories-view">
    <header class="max-w-prose space-y-1">
      <h1 class="text-xl font-semibold tracking-tight">{{ t('categories.title') }}</h1>
      <p class="text-muted-foreground text-sm">
        {{ t('categories.lead') }}
      </p>
    </header>

    <WorkspaceStatus />

    <template v-if="configuration">
      <CategoriesSection :configuration="configuration" :submit="submit" />

      <section v-if="categories.length === 0" class="max-w-prose" data-testid="no-categories-hint">
        <p class="text-muted-foreground text-sm">
          {{ t('categories.emptyHint') }}
        </p>
      </section>
      <AvailabilitySection v-else :configuration="configuration" :submit="submit" />

      <div class="border-t pt-6">
        <OverridesSection :configuration="configuration" :submit="submit" />
      </div>
    </template>
  </div>
</template>

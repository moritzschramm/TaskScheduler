<script setup lang="ts">
import type { BacklogEntry } from '@ambitime/shared';
import { Badge } from '@/components/ui/badge';

defineProps<{ entries: BacklogEntry[] }>();

/**
 * §6.7's reasons, in words a person can act on. The codes are the engine's
 * vocabulary; a panel that printed `no_contiguous_span` would be showing the
 * user a variable name.
 */
const REASONS: Record<string, string> = {
  insufficient_remaining_capacity: 'No room left in the horizon',
  no_feasible_window: 'No availability window for its category',
  hard_due_date_unreachable: 'Its deadline falls before any free slot',
  manual_floor_beyond_horizon: 'Deferred past the horizon',
  no_contiguous_span: 'No single stretch long enough',
  sequence_members_incompatible: 'Its sequence cannot share one window',
};

function reasonOf(entry: BacklogEntry): string {
  return REASONS[entry.reason] ?? entry.reason;
}
</script>

<template>
  <section class="flex flex-col gap-3" data-testid="backlog-panel" aria-labelledby="backlog-title">
    <header class="flex items-baseline justify-between">
      <h2 id="backlog-title" class="text-sm font-semibold">Backlog</h2>
      <span class="text-muted-foreground text-xs">{{ entries.length }}</span>
    </header>

    <p v-if="entries.length === 0" class="text-muted-foreground text-sm">
      Everything fits inside the horizon.
    </p>

    <ul v-else class="flex flex-col gap-2">
      <li
        v-for="entry in entries"
        :key="entry.occurrenceId"
        class="bg-card flex flex-col gap-1 rounded-md border p-2"
        data-testid="backlog-entry"
        :data-task-id="entry.taskId"
      >
        <div class="flex items-start justify-between gap-2">
          <span class="text-sm font-medium">{{ entry.title }}</span>
          <!-- §6.1: past the horizon there are no datetimes, only weeks. -->
          <Badge v-if="entry.estimatedWeek" variant="secondary" data-testid="estimated-week">
            week of {{ entry.estimatedWeek }}
          </Badge>
          <Badge v-else variant="destructive" data-testid="estimated-week">no week</Badge>
        </div>
        <p class="text-muted-foreground text-xs">{{ reasonOf(entry) }}</p>
      </li>
    </ul>
  </section>
</template>

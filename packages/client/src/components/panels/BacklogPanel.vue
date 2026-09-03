<script setup lang="ts">
import type { BacklogEntry } from '@ambitime/shared';
import { useI18n, type MessageKey } from '@/i18n';
import { Badge } from '@/components/ui/badge';

defineProps<{ entries: BacklogEntry[] }>();

const { t } = useI18n();

/**
 * §6.7's reasons, in words a person can act on. The codes are the engine's
 * vocabulary; a panel that printed `no_contiguous_span` would be showing the
 * user a variable name.
 *
 * Looked up per call rather than built once into a map: the words depend on the
 * language, and a map built at setup would keep the language the panel was
 * mounted in.
 */
const REASONS: Record<string, MessageKey> = {
  insufficient_remaining_capacity: 'backlog.reason.capacity',
  no_feasible_window: 'backlog.reason.noWindow',
  hard_due_date_unreachable: 'backlog.reason.deadline',
  manual_floor_beyond_horizon: 'backlog.reason.deferred',
  no_contiguous_span: 'backlog.reason.noSpan',
  sequence_members_incompatible: 'backlog.reason.sequence',
};

function reasonOf(entry: BacklogEntry): string {
  const key = REASONS[entry.reason];
  return key === undefined ? entry.reason : t(key);
}
</script>

<template>
  <section class="flex flex-col gap-3" data-testid="backlog-panel" aria-labelledby="backlog-title">
    <header class="flex items-baseline justify-between">
      <h2 id="backlog-title" class="text-sm font-semibold">{{ t('backlog.title') }}</h2>
      <span class="text-muted-foreground text-xs">{{ entries.length }}</span>
    </header>

    <p v-if="entries.length === 0" class="text-muted-foreground text-sm">
      {{ t('backlog.empty') }}
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
            {{ t('backlog.weekOf', { week: entry.estimatedWeek ?? '' }) }}
          </Badge>
          <Badge v-else variant="destructive" data-testid="estimated-week">{{
            t('backlog.noWeek')
          }}</Badge>
        </div>
        <p class="text-muted-foreground text-xs">{{ reasonOf(entry) }}</p>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { fetchAudit } from '@/lib/commands';
import { displayLocale } from '@/lib/session';
import type { AuditEntry } from '@ambitime/shared';

/**
 * The audit view (spec §12).
 *
 * "One append-only command log serves all three: undo/redo, history, and
 * audit." This is the third, and it is a plain reading of the same rows undo
 * folds into stacks — which is the point: there is no separate audit trail to
 * fall out of step with what actually happened.
 *
 * Every entry is an *intent*: the command somebody issued and what it was
 * asked to do. Undo appears here too, because taking something back is itself
 * something you did (§7.5).
 */
const entries = ref<AuditEntry[]>([]);
const cursor = ref<string | null>(null);
const retentionDays = ref<number | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);

async function load(before?: string): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    const page = await fetchAudit(before);
    entries.value = before === undefined ? page.entries : [...entries.value, ...page.entries];
    cursor.value = page.nextCursor;
    retentionDays.value = page.retentionDays;
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : 'Could not load the history';
  } finally {
    loading.value = false;
  }
}

/** `MoveTask` → `Move task`, as the log's own vocabulary made readable. */
function readable(type: string): string {
  const words = type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function when(iso: string): string {
  return new Intl.DateTimeFormat(displayLocale(), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(iso));
}

onMounted(() => load());
</script>

<template>
  <div class="flex flex-col gap-4 p-6" data-testid="audit-view">
    <header class="flex flex-wrap items-baseline justify-between gap-3">
      <h1 class="text-xl font-semibold tracking-tight">History</h1>
      <RouterLink
        class="text-muted-foreground text-sm underline underline-offset-4"
        to="/"
        data-testid="back-to-schedule"
      >
        Back to the schedule
      </RouterLink>
    </header>

    <p class="text-muted-foreground text-sm" data-testid="retention-note">
      <template v-if="retentionDays === null">
        Everything that has ever been done here is kept.
      </template>
      <template v-else>
        Kept for {{ retentionDays }} days. Anything older has been removed, and cannot be undone.
      </template>
    </p>

    <p v-if="error" class="text-destructive text-sm" role="alert" data-testid="audit-error">
      {{ error }}
    </p>

    <p v-else-if="loading && entries.length === 0" class="text-muted-foreground text-sm">
      Loading…
    </p>

    <p v-else-if="entries.length === 0" class="text-muted-foreground text-sm">
      Nothing has been done here yet.
    </p>

    <table v-else class="w-full text-sm" data-testid="audit-table">
      <thead>
        <tr class="text-muted-foreground border-b text-left text-xs">
          <th scope="col" class="py-1.5 pr-3 font-medium">What</th>
          <th scope="col" class="py-1.5 pr-3 font-medium">Who</th>
          <th scope="col" class="py-1.5 pr-3 font-medium">When</th>
          <th scope="col" class="py-1.5 pr-3 font-medium">Rows changed</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="entry in entries"
          :key="entry.id"
          class="border-b last:border-0"
          data-testid="audit-row"
          :data-type="entry.type"
        >
          <td class="py-1.5 pr-3">
            {{ readable(entry.type) }}
            <Badge v-if="entry.groupId" variant="outline" class="ml-1">grouped</Badge>
          </td>
          <td class="text-muted-foreground py-1.5 pr-3">{{ entry.actorEmail ?? entry.actorId }}</td>
          <td class="py-1.5 pr-3 tabular-nums">{{ when(entry.issuedAt) }}</td>
          <td class="py-1.5 pr-3 tabular-nums">{{ entry.changed }}</td>
        </tr>
      </tbody>
    </table>

    <Button
      v-if="cursor !== null"
      variant="outline"
      :disabled="loading"
      data-testid="load-more"
      @click="load(cursor ?? undefined)"
    >
      Show older
    </Button>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n, type MessageKey } from '@/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/lib/api';
import { fetchAudit } from '@/lib/commands';
import { displayLocale } from '@/lib/session';
import { formatDateTime } from '@/lib/time';
import { useWorkspace } from '@/lib/workspace';
import type { AuditEntry } from '@ambitime/shared';

const { t } = useI18n();

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
    error.value = cause instanceof ApiError ? cause.message : t('history.loadError');
  } finally {
    loading.value = false;
  }
}

/**
 * `MoveTask` → what a person calls it, in their language.
 *
 * It used to be a regular expression that split the camel case and lower-cased
 * it, which is a fine way to make a *symbol* readable and no way at all to make
 * it translatable — it produced English whatever the interface was set to. The
 * catalogue names each command; the old prettifier stays as the fallback, so a
 * command added and not yet named still reads as something rather than as a
 * missing key.
 */
function readable(type: string): string {
  const key = `history.command.${type}` as MessageKey;
  const named = t(key);
  if (named !== key) return named;

  const words = type.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function when(iso: string): string {
  return formatDateTime(iso, displayLocale());
}

/**
 * The table follows the log it is a reading of (§7.5, §12).
 *
 * Undo and redo are in the header, so they are reachable from this very page —
 * and pressing one appended a row this table then declined to show. Nothing was
 * wrong underneath: a reload produced the `Undo` and the `Redo`, both of them
 * where they should be. But a history that does not move while you are watching
 * it is a history you stop believing, which is the one thing an audit trail
 * cannot afford (§12).
 *
 * The undo stacks are what changes, and they change on every command the
 * workspace applies, so watching them is watching "something was written".
 *
 * **Back to the first page, not appended to the last.** The new entries are at
 * the top and paging is a cursor into what was below them; splicing them into a
 * list somebody had already paged through would put two orderings in one table.
 * Anyone who had asked for older rows can ask again.
 */
const { history } = useWorkspace();

watch(history, (_next, previous) => {
  // Skipped once: the shell reads the stacks for itself as it mounts, and that
  // first arrival is this page's own `onMounted` read under another name.
  if (previous !== null) void load();
});

onMounted(() => load());
</script>

<template>
  <div class="flex flex-col gap-4 p-6" data-testid="audit-view">
    <header class="flex flex-wrap items-baseline justify-between gap-3">
      <h1 class="text-xl font-semibold tracking-tight">{{ t('history.title') }}</h1>
      <RouterLink
        class="text-muted-foreground text-sm underline underline-offset-4"
        to="/"
        data-testid="back-to-schedule"
      >
        {{ t('history.back') }}
      </RouterLink>
    </header>

    <p class="text-muted-foreground text-sm" data-testid="retention-note">
      <template v-if="retentionDays === null">
        {{ t('history.keptForever') }}
      </template>
      <template v-else>
        {{ t('history.keptFor', { days: retentionDays ?? 0 }) }}
      </template>
    </p>

    <p v-if="error" class="text-destructive text-sm" role="alert" data-testid="audit-error">
      {{ error }}
    </p>

    <p v-else-if="loading && entries.length === 0" class="text-muted-foreground text-sm">
      {{ t('app.loading') }}
    </p>

    <p v-else-if="entries.length === 0" class="text-muted-foreground text-sm">
      {{ t('history.empty') }}
    </p>

    <table v-else class="w-full text-sm" data-testid="audit-table">
      <thead>
        <tr class="text-muted-foreground border-b text-left text-xs">
          <th scope="col" class="py-1.5 pr-3 font-medium">{{ t('history.column.what') }}</th>
          <th scope="col" class="py-1.5 pr-3 font-medium">{{ t('history.column.who') }}</th>
          <th scope="col" class="py-1.5 pr-3 font-medium">{{ t('history.column.when') }}</th>
          <th scope="col" class="py-1.5 pr-3 font-medium">{{ t('history.column.affected') }}</th>
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
            <Badge v-if="entry.groupId" variant="outline" class="ml-1">{{
              t('history.grouped')
            }}</Badge>
          </td>
          <td class="text-muted-foreground py-1.5 pr-3">{{ entry.actorEmail ?? entry.actorId }}</td>
          <td class="py-1.5 pr-3 tabular-nums">{{ when(entry.issuedAt) }}</td>
          <!--
            What moved, not how many rows were written. The two are barely
            related: blocking out a day writes one appointment and reflows the
            afternoon, and "1" would have been a true answer to a question
            nobody was asking. An entry from before the log counted this says
            so, rather than claiming none.
          -->
          <td class="py-1.5 pr-3 tabular-nums" data-testid="audit-affected">
            <template v-if="entry.affectedTasks === null">
              <span class="text-muted-foreground" :title="t('history.notCounted')">—</span>
            </template>
            <template v-else>{{ entry.affectedTasks }}</template>
          </td>
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
      {{ t('history.showOlder') }}
    </Button>
  </div>
</template>

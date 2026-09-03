<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '@/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { CommandRequest, Notification } from '@ambitime/shared';

/**
 * The in-app notification centre (spec §11).
 *
 * **Severity is the organising idea, not decoration.** §6.5 and §6.7 draw a
 * line the whole surface depends on: a soft due date at risk is a *warning*, a
 * hard one is an *alert*, and a backlogged task is merely *informational*. A
 * centre that showed all three the same way would be a centre nobody reads, and
 * the distinction the engine took care to make would be thrown away at the last
 * step. So alerts sort first, and each severity looks different.
 *
 * Delivery elsewhere — in-app when online, email when offline, driven by
 * pg-boss — is M15's. This is the in-app half.
 */
const props = defineProps<{
  notifications: Notification[];
  submit: (request: CommandRequest) => Promise<boolean>;
}>();

/** Alerts demand attention now; information can wait until it is scrolled to. */
const RANK: Readonly<Record<string, number>> = { alert: 0, warning: 1, info: 2 };

const unread = computed(() => props.notifications.filter((entry) => entry.readAt === null));

const ordered = computed(() =>
  [...unread.value].sort(
    (a, b) =>
      (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3) || b.createdAt.localeCompare(a.createdAt),
  ),
);

const alertCount = computed(() => unread.value.filter((n) => n.severity === 'alert').length);

function messageOf(entry: Notification): string {
  const payload = entry.payload as { message?: unknown; title?: unknown } | null;
  if (payload !== null && typeof payload.message === 'string') return payload.message;
  return readableType(entry.type);
}

/** `hard_constraint_conflict` → `Hard constraint conflict`. */
function readableType(type: string): string {
  const words = type.replaceAll('_', ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function badgeVariant(severity: string): 'destructive' | 'secondary' | 'outline' {
  if (severity === 'alert') return 'destructive';
  if (severity === 'warning') return 'secondary';
  return 'outline';
}

async function dismiss(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  await props.submit({ type: 'MarkNotificationsRead', params: { notificationIds: ids } });
}

const { t } = useI18n();
</script>

<template>
  <section
    class="flex flex-col gap-3"
    data-testid="notification-centre"
    aria-labelledby="notifications-title"
  >
    <header class="flex items-baseline justify-between gap-3">
      <h2 id="notifications-title" class="text-sm font-semibold">
        {{ t('notifications.title') }}
        <span v-if="alertCount > 0" class="text-destructive ml-1 text-xs" data-testid="alert-count"
          >{{ alertCount }} needing attention</span
        >
      </h2>
      <Button
        v-if="ordered.length > 0"
        variant="ghost"
        size="sm"
        data-testid="dismiss-all"
        @click="dismiss(ordered.map((entry) => entry.id))"
      >
        {{ t('notifications.dismissAll') }}
      </Button>
    </header>

    <p v-if="ordered.length === 0" class="text-muted-foreground text-sm" data-testid="no-signals">
      {{ t('notifications.empty') }}
    </p>

    <ul v-else class="space-y-2">
      <li
        v-for="entry in ordered"
        :key="entry.id"
        class="flex items-start justify-between gap-3 rounded-md border p-2.5 text-sm"
        data-testid="notification"
        :data-severity="entry.severity"
        :data-type="entry.type"
      >
        <div class="space-y-1">
          <Badge :variant="badgeVariant(entry.severity)">{{ entry.severity }}</Badge>
          <p>{{ messageOf(entry) }}</p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          :aria-label="`${t('notifications.dismiss')}: ${messageOf(entry)}`"
          data-testid="dismiss-notification"
          @click="dismiss([entry.id])"
        >
          {{ t('notifications.dismiss') }}
        </Button>
      </li>
    </ul>
  </section>
</template>

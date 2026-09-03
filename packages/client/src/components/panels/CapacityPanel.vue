<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '@/i18n';
import { Badge } from '@/components/ui/badge';
import type { CapacityCell, Category } from '@ambitime/shared';

/**
 * The per-category utilization indicator of spec §6.6.
 *
 * §6.6 asks for capacity to be "surfaced as the backlog notification plus a
 * per-category utilization indicator" — two things, and this is the second. It
 * is deliberately *not* a notification: the enum of §11 has no capacity type,
 * because overcommitment is a standing condition rather than an event, and the
 * thing it produces that you can act on is the backlog entry, which already
 * notifies.
 *
 * The **contiguity check** gets its own line. A category can hold far more
 * minutes than a sequence needs and still have nowhere to put it, because the
 * minutes come in fragments — a bar at 60% that cannot fit the one thing you
 * care about is a misleading bar.
 */
const props = defineProps<{ cells: CapacityCell[]; categories: Category[] }>();

/**
 * The weeks in view, earliest first.
 *
 * §6.1 puts the hard horizon at the current week plus the next, so there are
 * two of them and their order is their meaning. "Week of 2026-08-31" made the
 * reader work out which one that was — from a date they would have to compare
 * against today, on a panel whose whole job is to be glanced at.
 */
const weeks = computed(() => [...new Set(props.cells.map((cell) => cell.weekStart))].sort());

const ORDINALS = ['capacity.thisWeek', 'capacity.nextWeek'] as const;

/** Falls back to the date, so a third week would still say something true. */
function weekLabel(weekStart: string): string {
  const index = weeks.value.indexOf(weekStart);
  const ordinal = ORDINALS[index];
  return ordinal === undefined ? t('capacity.weekOf', { week: weekStart }) : t(ordinal);
}

const named = computed(() =>
  props.cells.map((cell) => ({
    ...cell,
    categoryName:
      props.categories.find((category) => category.id === cell.categoryId)?.name ?? 'Unknown',
    percent: cell.utilization === null ? null : Math.round(cell.utilization * 100),
    weekLabel: weekLabel(cell.weekStart),
  })),
);

function variant(status: string): 'destructive' | 'secondary' | 'outline' {
  if (status === 'overcommitted') return 'destructive';
  if (status === 'tight') return 'secondary';
  return 'outline';
}

function barClass(status: string): string {
  if (status === 'overcommitted') return 'bg-destructive';
  if (status === 'tight') return 'bg-amber-500';
  return 'bg-primary/60';
}

const { t } = useI18n();
</script>

<template>
  <section
    class="flex flex-col gap-3"
    data-testid="capacity-panel"
    aria-labelledby="capacity-title"
  >
    <h2 id="capacity-title" class="text-sm font-semibold">{{ t('capacity.title') }}</h2>

    <p v-if="named.length === 0" class="text-muted-foreground text-sm">
      {{ t('capacity.empty') }}
    </p>

    <ul v-else class="space-y-2.5">
      <li
        v-for="cell in named"
        :key="`${cell.categoryId}-${cell.weekStart}`"
        class="space-y-1 text-sm"
        data-testid="capacity-cell"
        :data-status="cell.status"
        :data-category="cell.categoryId"
      >
        <div class="flex items-baseline justify-between gap-2">
          <span>{{ cell.categoryName }}</span>
          <span class="text-muted-foreground text-xs tabular-nums">
            {{ cell.weekLabel }}
          </span>
        </div>

        <div class="flex items-center gap-2">
          <div class="bg-muted h-1.5 grow overflow-hidden rounded-full">
            <div
              class="h-full rounded-full"
              :class="barClass(cell.status)"
              :style="{ width: `${Math.min(cell.percent ?? 0, 100)}%` }"
            />
          </div>
          <Badge :variant="variant(cell.status)" data-testid="capacity-status">
            {{ cell.percent === null ? 'no supply' : `${cell.percent}%` }}
          </Badge>
        </div>

        <p
          v-if="!cell.hasContiguousSpan && cell.longestSequenceMin > 0"
          class="text-destructive text-xs"
          data-testid="contiguity-warning"
        >
          {{ t('capacity.noContiguous') }}
        </p>
      </li>
    </ul>
  </section>
</template>

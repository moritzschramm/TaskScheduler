<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '@/i18n';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { fromLocalInput, toLocalInput } from '@/lib/time';
import type { CommandRequest, ScheduledBlock, TaskNode } from '@ambitime/shared';

const { t } = useI18n();

/**
 * The manual actions of spec §7.3, for one task.
 *
 * Each is a command and nothing more: none of them writes a placement. That is
 * the rule the whole architecture turns on — a manual edit changes a
 * *constraint* and the schedule is re-derived from it (§3.4) — and it is why
 * "defer to tomorrow" and "swap these two" can share a screen with no special
 * cases between them.
 *
 * **The floor is shown.** A task sitting at 14:00 looks identical whether it
 * chose to or was told to, so a reposition leaves an invisible mark: a soft
 * not-before that goes on constraining every future solve. §7.3 gives three
 * ways it clears, one of which is the user simply resetting it — which they
 * cannot do if they cannot see it.
 */
const props = defineProps<{
  task: TaskNode;
  /** This task's current placement, when it has one. */
  placement: ScheduledBlock | null;
  /** Other placed tasks, as swap candidates. */
  others: ScheduledBlock[];
  timeZone: string;
  submit: (request: CommandRequest) => Promise<boolean>;
}>();

const busy = ref(false);
const exactStart = ref('');
const swapWith = ref('');

watch(
  () => props.placement,
  (placement) => {
    exactStart.value = placement === null ? '' : toLocalInput(placement.start, props.timeZone);
  },
  { immediate: true },
);

const isPlaced = computed(() => props.placement !== null);

const floorLabel = computed(() =>
  props.task.manualFloor === null
    ? null
    : toLocalInput(props.task.manualFloor, props.timeZone).replace('T', ' at '),
);

async function run(request: CommandRequest): Promise<void> {
  busy.value = true;
  try {
    await props.submit(request);
  } finally {
    busy.value = false;
  }
}

/** §13's "text field allows exact minutes", beside the grid's 15-minute snap. */
async function moveToExact(): Promise<void> {
  const instant = fromLocalInput(exactStart.value, props.timeZone);
  if (instant === null) return;
  await run({ type: 'MoveTask', params: { taskId: props.task.id, datetime: instant } });
}

/**
 * The single-pointer alternative to dragging (WCAG 2.2 success criterion 2.5.7,
 * "Dragging Movements").
 *
 * 2.5.7 asks that anything achievable by dragging also be achievable with a
 * single pointer *without* dragging — which the keyboard equivalent does not
 * satisfy, since it is about pointing rather than about keyboards. Two buttons
 * and an exact-minute field are that path.
 */
async function nudgeBy(minutes: number): Promise<void> {
  if (props.placement === null) return;

  const moved = new Date(Date.parse(props.placement.start) + minutes * 60_000);
  await run({
    type: 'MoveTask',
    params: { taskId: props.task.id, datetime: moved.toISOString() },
  });
}

async function defer(target: 'tomorrow' | 'next_week' | 'backlog'): Promise<void> {
  await run({ type: 'DeferTask', params: { taskId: props.task.id, target } });
}

async function swap(): Promise<void> {
  if (swapWith.value === '') return;
  await run({
    type: 'SwapTasks',
    params: { taskAId: props.task.id, taskBId: swapWith.value },
  });
}
</script>

<template>
  <section class="space-y-4" data-testid="task-actions">
    <header class="flex flex-wrap items-center gap-2">
      <h3 class="text-sm font-semibold">{{ t('actions.title') }}</h3>
      <Badge v-if="floorLabel" variant="outline" data-testid="floor-badge">
        {{ t('actions.notBefore', { time: floorLabel ?? '' }) }}
      </Badge>
      <Button
        v-if="task.manualFloor"
        variant="ghost"
        size="sm"
        :disabled="busy"
        :title="t('actions.clearFloor')"
        data-testid="clear-floor"
        @click="run({ type: 'ClearFloor', params: { taskId: task.id } })"
      >
        {{ t('common.clear') }}
      </Button>
    </header>

    <p v-if="!isPlaced" class="text-muted-foreground text-sm" data-testid="not-placed">
      {{ t('actions.notPlaced') }}
    </p>

    <template v-else>
      <div class="space-y-1">
        <Label for="exact-start">{{ t('actions.exactStart') }}</Label>
        <div class="flex flex-wrap items-center gap-2">
          <input
            id="exact-start"
            v-model="exactStart"
            type="datetime-local"
            class="border-input bg-background focus-visible:ring-ring h-9 rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
            data-testid="exact-start"
          />
          <Button
            variant="outline"
            size="sm"
            :disabled="busy"
            data-testid="move-exact"
            @click="moveToExact"
          >
            {{ t('actions.move') }}
          </Button>
        </div>
        <div class="flex flex-wrap items-center gap-2">
          <span class="text-muted-foreground text-xs">{{ t('actions.nudge') }}</span>
          <Button
            variant="outline"
            size="sm"
            :disabled="busy"
            :aria-label="t('actions.earlier')"
            data-testid="nudge-earlier"
            @click="nudgeBy(-15)"
          >
            −15m
          </Button>
          <Button
            variant="outline"
            size="sm"
            :disabled="busy"
            :aria-label="t('actions.later')"
            data-testid="nudge-later"
            @click="nudgeBy(15)"
          >
            +15m
          </Button>
        </div>

        <p class="text-muted-foreground text-xs">
          {{ t('actions.dragNote') }}
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <span class="text-muted-foreground text-xs">{{ t('actions.notNow') }}</span>
        <Button
          variant="outline"
          size="sm"
          :disabled="busy"
          data-testid="defer-tomorrow"
          @click="defer('tomorrow')"
        >
          {{ t('actions.tomorrow') }}
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="busy"
          data-testid="defer-next-week"
          @click="defer('next_week')"
        >
          {{ t('actions.nextWeek') }}
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="busy"
          data-testid="defer-backlog"
          @click="defer('backlog')"
        >
          {{ t('actions.backlog') }}
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="busy"
          :title="t('actions.somethingElseHint')"
          data-testid="swap-forward"
          @click="run({ type: 'SwapForward', params: { taskId: task.id } })"
        >
          {{ t('actions.somethingElse') }}
        </Button>
      </div>

      <div v-if="others.length > 0" class="flex flex-wrap items-end gap-2">
        <div class="space-y-1">
          <Label for="swap-with">{{ t('actions.swapWith') }}</Label>
          <Select id="swap-with" v-model="swapWith" class="w-56" data-testid="swap-with">
            <option value="">{{ t('actions.chooseTask') }}</option>
            <option v-for="other in others" :key="other.taskId" :value="other.taskId">
              {{ other.title }}
            </option>
          </Select>
        </div>
        <Button
          variant="outline"
          size="sm"
          :disabled="busy || swapWith === ''"
          :title="t('actions.swapHint')"
          data-testid="swap-tasks"
          @click="swap"
        >
          {{ t('actions.swap') }}
        </Button>
      </div>
    </template>
  </section>
</template>

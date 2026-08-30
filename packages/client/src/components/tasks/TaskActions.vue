<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { fromLocalInput, toLocalInput } from '@/lib/time';
import type { CommandRequest, ScheduledBlock, TaskNode } from '@ambitime/shared';

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
const newEstimate = ref('');
const swapWith = ref('');

watch(
  [() => props.placement, () => props.task],
  ([placement, task]) => {
    exactStart.value = placement === null ? '' : toLocalInput(placement.start, props.timeZone);
    newEstimate.value = task.estimatedDurationMin === null ? '' : String(task.estimatedDurationMin);
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

async function defer(target: 'tomorrow' | 'next_week' | 'backlog'): Promise<void> {
  await run({ type: 'DeferTask', params: { taskId: props.task.id, target } });
}

async function extend(): Promise<void> {
  const estimate = Number(newEstimate.value);
  if (!Number.isInteger(estimate) || estimate <= 0) return;
  await run({
    type: 'ExtendTask',
    expectedVersion: props.task.version,
    params: { taskId: props.task.id, newEstimateMin: estimate },
  });
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
      <h3 class="text-sm font-semibold">Scheduling</h3>
      <Badge v-if="floorLabel" variant="outline" data-testid="floor-badge">
        Not before {{ floorLabel }}
      </Badge>
      <Button
        v-if="task.manualFloor"
        variant="ghost"
        size="sm"
        :disabled="busy"
        title="Forget the not-before this task picked up when it was moved"
        data-testid="clear-floor"
        @click="run({ type: 'ClearFloor', params: { taskId: task.id } })"
      >
        Clear
      </Button>
    </header>

    <p v-if="!isPlaced" class="text-muted-foreground text-sm" data-testid="not-placed">
      This task is not on the calendar in this horizon, so there is nothing to move yet.
    </p>

    <template v-else>
      <div class="space-y-1">
        <Label for="exact-start">Exact start</Label>
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
            Move
          </Button>
        </div>
        <p class="text-muted-foreground text-xs">
          Dragging snaps to 15 minutes; this field takes any minute. Either way the task is
          <em>delayed, not pinned</em> — it will not go earlier, but it may still go later.
        </p>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <span class="text-muted-foreground text-xs">Not now:</span>
        <Button
          variant="outline"
          size="sm"
          :disabled="busy"
          data-testid="defer-tomorrow"
          @click="defer('tomorrow')"
        >
          Tomorrow
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="busy"
          data-testid="defer-next-week"
          @click="defer('next_week')"
        >
          Next week
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="busy"
          data-testid="defer-backlog"
          @click="defer('backlog')"
        >
          Backlog
        </Button>
        <Button
          variant="outline"
          size="sm"
          :disabled="busy"
          title="Push this task to its next feasible slot and pull the next task forward"
          data-testid="swap-forward"
          @click="run({ type: 'SwapForward', params: { taskId: task.id } })"
        >
          Something else first
        </Button>
      </div>

      <div class="flex flex-wrap items-end gap-2">
        <div class="space-y-1">
          <Label for="new-estimate">New estimate (minutes)</Label>
          <Input
            id="new-estimate"
            v-model="newEstimate"
            type="number"
            min="1"
            class="w-32"
            data-testid="new-estimate"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          :disabled="busy"
          data-testid="extend-task"
          @click="extend"
        >
          It is taking longer
        </Button>
      </div>

      <div v-if="others.length > 0" class="flex flex-wrap items-end gap-2">
        <div class="space-y-1">
          <Label for="swap-with">Swap with</Label>
          <Select id="swap-with" v-model="swapWith" class="w-56" data-testid="swap-with">
            <option value="">Choose a task…</option>
            <option v-for="other in others" :key="other.taskId" :value="other.taskId">
              {{ other.title }}
            </option>
          </Select>
        </div>
        <Button
          variant="outline"
          size="sm"
          :disabled="busy || swapWith === ''"
          title="Exchange times if each fits the other's constraints; otherwise this task moves on"
          data-testid="swap-tasks"
          @click="swap"
        >
          Swap
        </Button>
      </div>
    </template>
  </section>
</template>

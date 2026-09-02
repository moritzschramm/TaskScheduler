<script setup lang="ts">
import { Button } from '@/components/ui/button';
import DayRangeSlider from '@/components/calendar/DayRangeSlider.vue';
import UndoRedo from '@/components/UndoRedo.vue';
import { useWorkspace } from '@/lib/workspace';

/**
 * The controls that belong to the week rather than to what is drawn on it.
 *
 * Schedule and Appointments both draw the same seven days, so both need the
 * same picker, the same zone caption and the same pair of arrows. They share
 * the workspace's anchor, which is what makes paging on one screen and
 * switching to the other land on the week you were looking at.
 */
defineProps<{ title: string }>();

const { calendars, selectedId, calendar, zone, history, submit, shiftWeek } = useWorkspace();
</script>

<template>
  <header class="flex flex-wrap items-center justify-between gap-4">
    <div class="flex items-center gap-3">
      <h1 class="text-xl font-semibold tracking-tight">{{ title }}</h1>
      <select
        v-if="calendars.length > 1"
        v-model="selectedId"
        class="border-input bg-background rounded-md border px-2 py-1 text-sm"
        data-testid="calendar-select"
      >
        <option v-for="entry in calendars" :key="entry.id" :value="entry.id">
          {{ entry.name }}
        </option>
      </select>
      <span v-if="calendar" class="text-muted-foreground text-xs" data-testid="calendar-zone">
        {{ zone }}
        <template v-if="zone !== calendar.timezone">
          <!--
            Said out loud when the two differ: the grid is in your zone, but
            this calendar's availability windows are wall-clock rules in its
            own (§5.1), so "09:00 Monday" means something different to the
            scheduler than the row you are looking at.
          -->
          <span data-testid="zone-divergence">(planner is {{ calendar.timezone }})</span>
        </template>
      </span>
      <DayRangeSlider v-if="calendar" />
    </div>

    <div class="flex items-center gap-2">
      <!-- Whatever this screen makes: a task, or a block of fixed time. -->
      <slot name="actions" />
      <UndoRedo :history="history" :submit="submit" />
      <Button variant="outline" size="sm" data-testid="week-back" @click="shiftWeek(-1)">
        Previous
      </Button>
      <Button variant="outline" size="sm" data-testid="week-forward" @click="shiftWeek(1)">
        Next
      </Button>
    </div>
  </header>
</template>

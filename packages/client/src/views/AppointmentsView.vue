<script setup lang="ts">
import { onMounted } from 'vue';
import AppointmentEditor from '@/components/calendar/AppointmentEditor.vue';
import WeekGrid from '@/components/calendar/WeekGrid.vue';
import WeekToolbar from '@/components/calendar/WeekToolbar.vue';
import OverridesSection from '@/components/settings/OverridesSection.vue';
import WorkspaceStatus from '@/components/WorkspaceStatus.vue';
import { useWorkspace } from '@/lib/workspace';
import type { GridBlock } from '@/lib/grid';

/**
 * The time that is already spoken for (spec §4.5, §7.4).
 *
 * The same week as Schedule with the placements taken out, because an
 * appointment is not scheduled *around* anything from here — it is the fixed
 * point everything else is scheduled around (§6.2 rule 2). Drawing the tasks
 * too would invite dragging one, and a drag on this screen means something
 * else.
 *
 * Week types share the screen for the same reason: a holiday is the other way
 * a week fills up, and both answers to "why is nothing being placed here" now
 * live on one page.
 */
const {
  view,
  calendar,
  zone,
  days,
  today,
  locale,
  configuration,
  editing,
  openWindows,
  ensureLoaded,
  submit,
  newBlockAt,
} = useWorkspace();

onMounted(ensureLoaded);

function editBlock(block: GridBlock): void {
  const found = view.value?.fixedBlocks.find(
    (candidate) => candidate.appointmentId === block.appointmentId,
  );
  if (found !== undefined) editing.value = { kind: 'block', block: found };
}
</script>

<template>
  <div class="flex flex-col gap-6 p-6" data-testid="appointments-view">
    <WeekToolbar title="Appointments" />
    <WorkspaceStatus />

    <template v-if="view && calendar">
      <p class="text-muted-foreground max-w-prose text-sm">
        Fixed time: meetings, and blocks you are simply not available for. Use
        <strong>+</strong> on a day to add one. Tasks are scheduled around these, and are drawn on
        the Schedule.
      </p>

      <WeekGrid
        :days="days"
        :time-zone="zone"
        :blocks="[]"
        :fixed-blocks="view.fixedBlocks"
        :windows="openWindows"
        :today="today"
        :locale="locale"
        editable
        @select-block="editBlock"
        @add-block="(day) => newBlockAt(day)"
      />

      <div
        v-if="editing.kind === 'block'"
        class="bg-card rounded-lg border p-5"
        data-testid="editor-panel"
      >
        <AppointmentEditor
          :key="editing.block?.appointmentId ?? 'new-block'"
          :block="editing.block"
          :calendar-id="calendar.id"
          :time-zone="zone"
          :default-start="editing.defaultStart"
          :submit="submit"
          @cancel="editing = { kind: 'none' }"
        />
      </div>

      <div v-if="configuration" class="border-t pt-6">
        <OverridesSection :configuration="configuration" :submit="submit" />
      </div>
    </template>
  </div>
</template>

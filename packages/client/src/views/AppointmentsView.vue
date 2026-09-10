<script setup lang="ts">
import { onMounted } from 'vue';
import { useI18n } from '@/i18n';
import AppointmentEditor from '@/components/calendar/AppointmentEditor.vue';
import MonthGrid from '@/components/calendar/MonthGrid.vue';
import WeekGrid from '@/components/calendar/WeekGrid.vue';
import WeekToolbar from '@/components/calendar/WeekToolbar.vue';
import OverridesSection from '@/components/settings/OverridesSection.vue';
import WorkspaceStatus from '@/components/WorkspaceStatus.vue';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { useWorkspace } from '@/lib/workspace';
import type { CivilDate } from '@ambitime/scheduler';
import type { GridBlock } from '@/lib/grid';
import { CalendarPlus } from 'lucide-vue-next';

const { t } = useI18n();

/**
 * The time that is already spoken for (spec §4.5, §7.4).
 *
 * The same week as Schedule with the placements taken out, because an
 * appointment is not scheduled *around* anything from here — it is the fixed
 * point everything else is scheduled around (§6.2 rule 2). Drawing the tasks
 * too would invite dragging one, and a drag on this screen means something
 * else.
 *
 * Special weeks share the screen for the same reason: a holiday is the other
 * way a week fills up, and both answers to "why is nothing being placed here"
 * now live on one page. The month view is where they are legible — a fortnight
 * away is one shaded band there and seven paging gestures here.
 */
const {
  view,
  calendar,
  zone,
  days,
  today,
  locale,
  configuration,
  categories,
  editing,
  blockDialogOpen,
  openWindows,
  dayStartMin,
  dayEndMin,
  rowScale,
  mode,
  month,
  firstDayOfWeek,
  horizonEnd,
  ensureLoaded,
  submit,
  newBlockAt,
  setMode,
  showWeekOf,
} = useWorkspace();

onMounted(ensureLoaded);

/**
 * A new block, starting on the first day of the week in view.
 *
 * The day used to come from which `+` was clicked. A date is a field on the
 * form either way, so the button opens it on a sensible day rather than making
 * the choice before there is anything to choose it for.
 */
function newBlock(): void {
  const day = today.value ?? days.value[0];
  if (day !== undefined) newBlockAt(day);
}

function editBlock(block: GridBlock): void {
  const found = view.value?.fixedBlocks.find(
    (candidate) => candidate.appointmentId === block.appointmentId,
  );
  if (found !== undefined) editing.value = { kind: 'block', block: found };
}

/** A day clicked in the month opens that week, which is where the hours are. */
function openDay(day: CivilDate): void {
  showWeekOf(day);
  setMode('week');
}
</script>

<template>
  <div class="flex flex-col gap-6 p-6" data-testid="appointments-view">
    <WeekToolbar :title="t('appointments.title')">
      <template #actions>
        <Button size="sm" data-testid="add-block" @click="newBlock">
          <CalendarPlus class="size-4" aria-hidden="true" />
          {{ t('appointments.newBlock') }}
        </Button>
      </template>
    </WeekToolbar>
    <WorkspaceStatus />

    <template v-if="view && calendar">
      <p class="text-muted-foreground max-w-prose text-sm">
        {{ t('appointments.lead') }}
      </p>

      <WeekGrid
        v-if="mode === 'week'"
        :days="days"
        :time-zone="zone"
        :blocks="[]"
        :fixed-blocks="view.fixedBlocks"
        :windows="openWindows"
        :categories="categories"
        :special-weeks="configuration?.weekTypeOverrides ?? []"
        :day-start-min="dayStartMin"
        :day-end-min="dayEndMin"
        :scale="rowScale"
        :today="today"
        :locale="locale"
        editable
        @select-block="editBlock"
      />

      <MonthGrid
        v-else
        :month="month"
        :time-zone="zone"
        :first-day-of-week="firstDayOfWeek"
        :locale="locale"
        :fixed-blocks="view.fixedBlocks"
        :special-weeks="configuration?.weekTypeOverrides ?? []"
        :today="today"
        :horizon-end="horizonEnd"
        @open-day="openDay"
      />

      <Dialog
        v-if="editing.kind === 'block'"
        v-model:open="blockDialogOpen"
        :title="editing.block === null ? t('appointments.editorNew') : t('appointments.editorEdit')"
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
          @saved="editing = { kind: 'none' }"
        />
      </Dialog>

      <div v-if="configuration" class="border-t pt-6">
        <OverridesSection :configuration="configuration" :submit="submit" />
      </div>
    </template>
  </div>
</template>

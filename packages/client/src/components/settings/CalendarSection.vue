<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import WeekdayWindowEditor, { type WindowRule } from './WeekdayWindowEditor.vue';
import type { CalendarConfiguration, CommandRequest } from '@ambitime/shared';

/**
 * The calendar itself, and the two windows of spec §9.1.
 *
 * The **working** window is when the scheduler may place tasks here; the
 * **shareable** window is what other users see as busy (§9.2). They are edited
 * side by side because the difference between them is the whole point, and a
 * screen that showed one at a time would invite setting them to the same thing.
 */
const props = defineProps<{
  configuration: CalendarConfiguration;
  submit: (request: CommandRequest) => Promise<boolean>;
}>();

const busy = ref(false);

const name = ref('');
const timezone = ref('');
const visibilityScope = ref<'private' | 'team' | 'group'>('private');
const working = ref<WindowRule[]>([]);
const shareable = ref<WindowRule[]>([]);

/**
 * The form is re-seeded from the server's answer after every save.
 *
 * Configuration is source state and the response is authoritative, so the
 * fields show what was stored rather than what was typed — which is how a
 * refusal the user has not noticed stops looking like a success.
 */
watch(
  () => props.configuration,
  (configuration) => {
    name.value = configuration.calendar.name;
    timezone.value = configuration.calendar.timezone;
    visibilityScope.value = configuration.calendar.visibilityScope;
    working.value = windowsOfKind(configuration, 'working');
    shareable.value = windowsOfKind(configuration, 'shareable');
  },
  { immediate: true },
);

function windowsOfKind(
  configuration: CalendarConfiguration,
  kind: 'working' | 'shareable',
): WindowRule[] {
  return configuration.windows
    .filter((window) => window.kind === kind)
    .map(({ weekday, startMin, endMin }) => ({ weekday, startMin, endMin }));
}

const readOnly = computed(() => !props.configuration.calendar.isOwner);

/** Every zone the browser knows, so a typo cannot reach the command. */
const timeZones = computed(() => {
  const known = Intl.supportedValuesOf('timeZone');
  return known.includes(timezone.value) ? known : [timezone.value, ...known];
});

async function saveCalendar(): Promise<void> {
  busy.value = true;
  try {
    await props.submit({
      type: 'ConfigureCalendar',
      // The lock the user actually read (§5.4): if a colleague renamed this
      // calendar since the page loaded, the save is refused rather than
      // silently overwriting them.
      expectedVersion: props.configuration.calendar.version,
      params: {
        calendarId: props.configuration.calendar.id,
        patch: {
          name: name.value,
          timezone: timezone.value,
          visibilityScope: visibilityScope.value,
        },
      },
    });
  } finally {
    busy.value = false;
  }
}

async function saveWindows(kind: 'working' | 'shareable'): Promise<void> {
  busy.value = true;
  try {
    // No `expectedVersion`: the set has no version of its own, and guarding it
    // with the calendar's would refuse a window edit because somebody renamed
    // the calendar — a conflict between two things that do not conflict.
    await props.submit({
      type: 'SetCalendarWindows',
      params: {
        calendarId: props.configuration.calendar.id,
        kind,
        windows: (kind === 'working' ? working.value : shareable.value).map(
          ({ weekday, startMin, endMin }) => ({ weekday, startMin, endMin }),
        ),
      },
    });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="space-y-4" data-testid="calendar-section">
    <header>
      <h2 class="text-lg font-semibold">Calendar</h2>
      <p v-if="readOnly" class="text-muted-foreground text-sm" data-testid="calendar-read-only">
        This calendar belongs to someone else, so its settings are read-only.
      </p>
    </header>

    <div class="grid gap-4 sm:grid-cols-3">
      <div class="space-y-1">
        <Label for="calendar-name">Name</Label>
        <Input id="calendar-name" v-model="name" :disabled="readOnly" data-testid="calendar-name" />
      </div>

      <div class="space-y-1">
        <Label for="calendar-timezone">Time zone</Label>
        <Select
          id="calendar-timezone"
          v-model="timezone"
          :disabled="readOnly"
          data-testid="calendar-timezone"
        >
          <option v-for="zone in timeZones" :key="zone" :value="zone">{{ zone }}</option>
        </Select>
      </div>

      <div class="space-y-1">
        <Label for="calendar-visibility">Visible to</Label>
        <Select
          id="calendar-visibility"
          v-model="visibilityScope"
          :disabled="readOnly"
          data-testid="calendar-visibility"
        >
          <option value="private">Only me</option>
          <option value="team">My team</option>
          <option value="group">My group</option>
        </Select>
      </div>
    </div>

    <Button :disabled="readOnly || busy" data-testid="save-calendar" @click="saveCalendar">
      Save calendar
    </Button>

    <div class="grid gap-6 lg:grid-cols-2">
      <div class="space-y-3">
        <div>
          <h3 class="text-sm font-semibold">Working window</h3>
          <p class="text-muted-foreground text-xs">When tasks may be scheduled here.</p>
        </div>
        <WeekdayWindowEditor
          v-model="working"
          :time-zone="configuration.calendar.timezone"
          :disabled="readOnly"
          data-testid="working-window"
        />
        <Button
          variant="outline"
          :disabled="readOnly || busy"
          data-testid="save-working-window"
          @click="saveWindows('working')"
        >
          Save working window
        </Button>
      </div>

      <div class="space-y-3">
        <div>
          <h3 class="text-sm font-semibold">Shareable window</h3>
          <p class="text-muted-foreground text-xs">
            What other people see as busy. Anything outside it stays private.
          </p>
        </div>
        <WeekdayWindowEditor
          v-model="shareable"
          :time-zone="configuration.calendar.timezone"
          :disabled="readOnly"
          data-testid="shareable-window"
        />
        <Button
          variant="outline"
          :disabled="readOnly || busy"
          data-testid="save-shareable-window"
          @click="saveWindows('shareable')"
        >
          Save shareable window
        </Button>
      </div>
    </div>
  </section>
</template>

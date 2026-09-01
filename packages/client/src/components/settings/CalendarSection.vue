<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import WeekdayWindowEditor, { type WindowRule } from './WeekdayWindowEditor.vue';
import type { CalendarConfiguration, CommandRequest } from '@ambitime/shared';

/**
 * The planner itself, and the two windows of spec §9.1.
 *
 * **"Planner", not "calendar", in every string a person reads.** The row is
 * still `calendars` and the API still says `calendarId` — but on screen the
 * word already meant the grid of days, so the same word for the container of
 * hours, categories and tasks was the collision. The rename is only in the
 * copy; nothing in the model moved.
 *
 * Both windows are folded away, and for the same reason: **neither is needed.**
 * The hours that actually schedule are the category's (§6.2 rule 1). The
 * working window is an optional ceiling over all of them, and absent means
 * unrestricted rather than closed — while the shareable window is read by
 * nothing at all until there is a second person to share with (§9.2). Left open
 * beside the fields that matter, they read as three settings you must fill in,
 * which is how a personal planner ends up with the same hours typed three
 * times.
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
      <h2 class="text-lg font-semibold">Planner</h2>
      <p class="text-muted-foreground max-w-prose text-sm">
        One self-contained world to schedule in — its own time zone, its own hours, its own
        categories and tasks. Most people need exactly one.
      </p>
      <p v-if="readOnly" class="text-muted-foreground text-sm" data-testid="calendar-read-only">
        This planner belongs to someone else, so its settings are read-only.
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
      Save planner
    </Button>

    <div class="grid gap-6 lg:grid-cols-2">
      <details class="rounded-lg border p-4" data-testid="working-window-details">
        <summary class="cursor-pointer text-sm font-semibold">Working window (optional)</summary>
        <div class="space-y-3 pt-3">
          <p class="text-muted-foreground text-xs">
            A ceiling over <em>every</em> category in this planner — set it only if there are hours
            you never want used whatever the category says. Leave it empty and nothing is
            restricted; the category hours decide on their own.
          </p>
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
      </details>

      <details class="rounded-lg border p-4" data-testid="shareable-window-details">
        <summary class="cursor-pointer text-sm font-semibold">Shareable window (optional)</summary>
        <div class="space-y-3 pt-3">
          <p class="text-muted-foreground text-xs">
            What other people would see as busy once this planner is shared. It has no effect on
            your own scheduling, and none at all while you are the only person here.
          </p>
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
      </details>
    </div>
  </section>
</template>

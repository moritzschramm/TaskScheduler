<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '@/i18n';
import { useAutosave } from '@/lib/autosave';
import { timeZonesIncluding } from '@/lib/zones';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import WeekdayWindowEditor, { type WindowRule } from './WeekdayWindowEditor.vue';
import type { CalendarConfiguration, CommandRequest } from '@ambitime/shared';

const { t } = useI18n();

/**
 * The planner itself, and the two windows of spec §9.1.
 *
 * **"Planner", not "calendar", in every string a person reads.** The row is
 * still `calendars` and the API still says `calendarId` — but on screen the
 * word already meant the grid of days, so the same word for the container of
 * hours, activity types and tasks was the collision. The rename is only in the
 * copy; nothing in the model moved.
 *
 * **No Save buttons.** Every field here writes itself once you stop changing
 * it, which is what removes the state where a planner looks renamed and is not.
 *
 * Both windows are folded away, and for the same reason: **neither is needed.**
 * The hours that actually schedule are the activity type's (§6.2 rule 1). The
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

const autosave = useAutosave();

const name = ref('');
const timezone = ref('');
const visibilityScope = ref<'private' | 'team' | 'group'>('private');
const working = ref<WindowRule[]>([]);
const shareable = ref<WindowRule[]>([]);

/**
 * Seeded when the planner changes, not on every answer from the server.
 *
 * It used to re-seed after each save, which was right for a form with a Save
 * button: the response is authoritative and showing it is how a silent refusal
 * stops looking like a success. Saving on every keystroke turns the same watch
 * into a race — the answer to the third character arrives while the sixth is
 * being typed — so identity is the trigger now, and a refusal is reported by
 * the error banner instead.
 */
/** True while the fields are being filled from the server, not by a person. */
let seeding = false;

watch(
  () => props.configuration.calendar.id,
  () => {
    seeding = true;
    const configuration = props.configuration;
    name.value = configuration.calendar.name;
    timezone.value = configuration.calendar.timezone;
    visibilityScope.value = configuration.calendar.visibilityScope;
    working.value = windowsOfKind(configuration, 'working');
    shareable.value = windowsOfKind(configuration, 'shareable');
    seeding = false;
  },
  { immediate: true },
);

// Sync, so the seed above is still in progress when these fire for its own
// assignments; see the same pattern in DisplaySection.
watch([name, timezone, visibilityScope], () => !seeding && editedCalendar(), { flush: 'sync' });
watch(working, () => !seeding && editedWindows('working'), { flush: 'sync' });
watch(shareable, () => !seeding && editedWindows('shareable'), { flush: 'sync' });

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
const zones = computed(() => timeZonesIncluding(timezone.value));

function editedCalendar(): void {
  autosave.save('calendar', async () => {
    if (readOnly.value || name.value.trim() === '') return;

    await props.submit({
      type: 'ConfigureCalendar',
      // The lock the user actually read (§5.4): if a colleague renamed this
      // calendar since the page loaded, the save is refused rather than
      // silently overwriting them. Read as the save runs, so the user's own
      // previous keystroke is never mistaken for somebody else's edit.
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
  });
}

function editedWindows(kind: 'working' | 'shareable'): void {
  autosave.save(kind, async () => {
    const windows = kind === 'working' ? working.value : shareable.value;
    if (readOnly.value || windows.some((rule) => rule.startMin >= rule.endMin)) return;

    // No `expectedVersion`: the set has no version of its own, and guarding it
    // with the calendar's would refuse a window edit because somebody renamed
    // the calendar — a conflict between two things that do not conflict.
    await props.submit({
      type: 'SetCalendarWindows',
      params: {
        calendarId: props.configuration.calendar.id,
        kind,
        windows: windows.map(({ weekday, startMin, endMin }) => ({ weekday, startMin, endMin })),
      },
    });
  });
}
</script>

<template>
  <section class="space-y-4" data-testid="calendar-section">
    <header>
      <h2 class="text-lg font-semibold">{{ t('settings.plannerHeading') }}</h2>
      <p class="text-muted-foreground max-w-prose text-sm">
        {{ t('settings.plannerLead') }}
      </p>
      <p v-if="readOnly" class="text-muted-foreground text-sm" data-testid="calendar-read-only">
        {{ t('settings.readOnly') }}
      </p>
    </header>

    <div class="grid gap-4 sm:grid-cols-3">
      <div class="space-y-1">
        <Label for="calendar-name">{{ t('common.name') }}</Label>
        <Input id="calendar-name" v-model="name" :disabled="readOnly" data-testid="calendar-name" />
      </div>

      <div class="space-y-1">
        <Label for="calendar-timezone">{{ t('settings.timeZone') }}</Label>
        <Select
          id="calendar-timezone"
          v-model="timezone"
          :disabled="readOnly"
          data-testid="calendar-timezone"
        >
          <option v-for="zone in zones" :key="zone" :value="zone">{{ zone }}</option>
        </Select>
      </div>

      <div class="space-y-1">
        <Label for="calendar-visibility">{{ t('settings.visibility') }}</Label>
        <Select
          id="calendar-visibility"
          v-model="visibilityScope"
          :disabled="readOnly"
          data-testid="calendar-visibility"
        >
          <option value="private">{{ t('settings.visibilityPrivate') }}</option>
          <option value="team">{{ t('settings.visibilityTeam') }}</option>
          <option value="group">{{ t('settings.visibilityGroup') }}</option>
        </Select>
      </div>
    </div>

    <div class="grid gap-6 lg:grid-cols-2">
      <details class="rounded-lg border p-4" data-testid="working-window-details">
        <summary class="cursor-pointer text-sm font-semibold">
          {{ t('settings.workingWindow') }}
        </summary>
        <div class="space-y-3 pt-3">
          <p class="text-muted-foreground text-xs">
            {{ t('settings.workingWindowLead') }}
          </p>
          <WeekdayWindowEditor
            v-model="working"
            :time-zone="configuration.calendar.timezone"
            :disabled="readOnly"
            data-testid="working-window"
          />
        </div>
      </details>

      <details class="rounded-lg border p-4" data-testid="shareable-window-details">
        <summary class="cursor-pointer text-sm font-semibold">
          {{ t('settings.shareableWindow') }}
        </summary>
        <div class="space-y-3 pt-3">
          <p class="text-muted-foreground text-xs">
            {{ t('settings.shareableWindowLead') }}
          </p>
          <WeekdayWindowEditor
            v-model="shareable"
            :time-zone="configuration.calendar.timezone"
            :disabled="readOnly"
            data-testid="shareable-window"
          />
        </div>
      </details>
    </div>
  </section>
</template>

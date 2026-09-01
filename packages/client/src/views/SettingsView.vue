<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import AvailabilitySection from '@/components/settings/AvailabilitySection.vue';
import CalendarSection from '@/components/settings/CalendarSection.vue';
import DisplaySection from '@/components/settings/DisplaySection.vue';
import CategoriesSection from '@/components/settings/CategoriesSection.vue';
import OverridesSection from '@/components/settings/OverridesSection.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiError } from '@/lib/api';
import { createdId, fetchConfiguration, runCommand } from '@/lib/commands';
import { fetchCalendars } from '@/lib/schedule';
import { loadSession } from '@/lib/session';
import { invalidateWorkspace } from '@/lib/workspace';
import type { CalendarConfiguration, CalendarSummary, CommandRequest } from '@ambitime/shared';

/**
 * The configuration screen (plan M11): calendars, categories, windows and week
 * types, all of it edited through commands.
 *
 * **Every write on this page is one command, and every command re-reads.** The
 * server's response is authoritative — it applied the change, re-derived what
 * followed, and knows things the form does not, such as which fields the
 * database normalised — so the page shows what came back rather than what was
 * typed. It costs one extra request and removes the entire class of bug where
 * a refused save still looks applied.
 */

const calendars = ref<CalendarSummary[]>([]);
const selectedId = ref<string | null>(null);
const configuration = ref<CalendarConfiguration | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);

const newCalendar = ref({ name: '', timezone: browserZone() });

const timeZones = computed(() => Intl.supportedValuesOf('timeZone'));

/** The viewer's own zone as the default for a new calendar — a good guess. */
function browserZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = null;

  try {
    calendars.value = await fetchCalendars();
    selectedId.value ??= calendars.value[0]?.id ?? null;

    const id = selectedId.value;
    configuration.value = id === null ? null : await fetchConfiguration(id);
  } catch (cause) {
    error.value = message(cause, 'Could not load the settings');
  } finally {
    loading.value = false;
  }
}

/**
 * Runs one command and re-reads. Returns whether it was applied, so a form can
 * clear itself on success and keep what the user typed on failure.
 */
async function submit(request: CommandRequest): Promise<boolean> {
  error.value = null;

  try {
    await runCommand(request);
    // The session carries §13's settings, so a settings change has to refresh
    // it as well as the configuration — otherwise the preview would update and
    // every other screen would not.
    await loadSession();
    await load();
    // Availability, categories and week types are all read by the three
    // schedule views. Leaving their copy alone would mean a window edited here
    // and a grid still drawn from the one before it.
    invalidateWorkspace();
    return true;
  } catch (cause) {
    error.value = message(cause, 'That change could not be applied');
    return false;
  }
}

async function createCalendar(): Promise<void> {
  error.value = null;

  try {
    const result = await runCommand({
      type: 'CreateCalendar',
      params: { name: newCalendar.value.name, timezone: newCalendar.value.timezone },
    });

    // Selected by the id the command reports rather than by re-reading and
    // matching on the name, which two calendars called "Work" would defeat.
    selectedId.value = createdId(result, 'calendar');
    newCalendar.value = { name: '', timezone: browserZone() };
    await load();
  } catch (cause) {
    error.value = message(cause, 'That calendar could not be created');
  }
}

function message(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : fallback;
}

onMounted(load);
watch(selectedId, load);
</script>

<template>
  <div class="flex flex-col gap-8 p-6" data-testid="settings-view">
    <header class="flex flex-wrap items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-semibold tracking-tight">Settings</h1>
        <Select
          v-if="calendars.length > 1"
          v-model="selectedId as string"
          class="w-auto"
          aria-label="Calendar"
          data-testid="settings-calendar-select"
        >
          <option v-for="entry in calendars" :key="entry.id" :value="entry.id">
            {{ entry.name }}
          </option>
        </Select>
      </div>

      <RouterLink
        class="text-muted-foreground text-sm underline underline-offset-4"
        to="/"
        data-testid="back-to-schedule"
      >
        Back to the schedule
      </RouterLink>
    </header>

    <p v-if="error" class="text-destructive text-sm" role="alert" data-testid="settings-error">
      {{ error }}
    </p>

    <p v-if="loading" class="text-muted-foreground text-sm">Loading the settings…</p>

    <!--
      A signed-up user has a tenant but no calendar: nothing creates one for
      them, and §4.3 says a user may own several, so which ones exist is their
      decision rather than a default somebody has to undo.
    -->
    <section
      v-else-if="configuration === null"
      class="max-w-md space-y-4"
      data-testid="no-calendar"
    >
      <header>
        <h2 class="text-lg font-semibold">Create a calendar</h2>
        <p class="text-muted-foreground text-sm">
          A calendar is a scheduling context. You can have several — work and personal keep their
          own windows and their own week.
        </p>
      </header>

      <div class="space-y-1">
        <Label for="first-calendar-name">Name</Label>
        <Input
          id="first-calendar-name"
          v-model="newCalendar.name"
          placeholder="Work"
          data-testid="first-calendar-name"
        />
      </div>

      <div class="space-y-1">
        <Label for="first-calendar-timezone">Time zone</Label>
        <Select
          id="first-calendar-timezone"
          v-model="newCalendar.timezone"
          data-testid="first-calendar-timezone"
        >
          <option v-for="zone in timeZones" :key="zone" :value="zone">{{ zone }}</option>
        </Select>
      </div>

      <Button
        :disabled="newCalendar.name.trim() === ''"
        data-testid="create-calendar"
        @click="createCalendar"
      >
        Create calendar
      </Button>
    </section>

    <template v-else>
      <DisplaySection :calendar-time-zone="configuration.calendar.timezone" :submit="submit" />
      <CalendarSection :configuration="configuration" :submit="submit" />
      <CategoriesSection :configuration="configuration" :submit="submit" />
      <AvailabilitySection :configuration="configuration" :submit="submit" />
      <OverridesSection :configuration="configuration" :submit="submit" />
    </template>
  </div>
</template>

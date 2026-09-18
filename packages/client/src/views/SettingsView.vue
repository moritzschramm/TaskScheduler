<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useI18n } from '@/i18n';
import AssistantSection from '@/components/settings/AssistantSection.vue';
import CalendarSection from '@/components/settings/CalendarSection.vue';
import DisplaySection from '@/components/settings/DisplaySection.vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiError } from '@/lib/api';
import { createdId, fetchConfiguration, runCommand } from '@/lib/commands';
import { fetchCalendars } from '@/lib/schedule';
import { loadSession } from '@/lib/session';
import { invalidateWorkspace } from '@/lib/workspace';
import { browserZone, timeZones } from '@/lib/zones';
import type { CalendarConfiguration, CalendarSummary, CommandRequest } from '@ambitime/shared';

const { t } = useI18n();

/**
 * The configuration screen (plan M11): the planner itself and how dates are
 * shown, both edited through commands.
 *
 * **Every write on this page is one command, and every command re-reads.** The
 * server's response is authoritative — it applied the change, re-derived what
 * followed, and knows things the form does not — so what the rest of the
 * application shows afterwards is what came back rather than what was typed.
 *
 * **The re-read is silent.** It used to raise the same `loading` flag as the
 * first read, which replaced the whole page with "Loading the settings…" every
 * time somebody changed a dropdown. Nothing about that was a lie, and it still
 * read as the page reloading under them — a form that blinks after every edit
 * is a form people stop trusting they have finished with. The flag now means
 * only what it originally meant: there is nothing on screen yet.
 */

const calendars = ref<CalendarSummary[]>([]);
const selectedId = ref<string | null>(null);
const configuration = ref<CalendarConfiguration | null>(null);
const error = ref<string | null>(null);
const loading = ref(true);

const newCalendar = ref({ name: '', timezone: browserZone() });

/**
 * Whether the add-a-planner picker has been opened.
 *
 * Its four hundred `<option>` elements are built only once somebody asks for
 * them. A `<details>` hides its content visually and still renders it, so a
 * folded-away zone picker was costing the settings page a third of its DOM for
 * a form most people never open.
 */
const addingPlanner = ref(false);

async function load({ silent = false } = {}): Promise<void> {
  // A refresh after a save is not a page load: there is already a correct
  // screen up, and blanking it to fetch a newer one is the reload this page
  // spent its whole life doing.
  loading.value = !silent;
  error.value = null;

  try {
    calendars.value = await fetchCalendars();
    selectedId.value ??= calendars.value[0]?.id ?? null;

    const id = selectedId.value;
    configuration.value = id === null ? null : await fetchConfiguration(id);
  } catch (cause) {
    error.value = message(cause, t('errors.settings'));
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
    await load({ silent: true });
    // Availability, activity types and week types are all read by the three
    // schedule views. Leaving their copy alone would mean a window edited here
    // and a grid still drawn from the one before it.
    invalidateWorkspace();
    return true;
  } catch (cause) {
    error.value = message(cause, t('errors.command'));
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
    error.value = message(cause, t('errors.calendar'));
  }
}

function message(cause: unknown, fallback: string): string {
  if (cause instanceof ApiError) return cause.message;
  return cause instanceof Error ? cause.message : fallback;
}

onMounted(() => load());
// A different planner is a different world, and reading it is a page load.
watch(selectedId, () => load());
</script>

<template>
  <div class="flex flex-col gap-8 p-6" data-testid="settings-view">
    <header class="flex flex-wrap items-center justify-between gap-4">
      <div class="flex items-center gap-3">
        <h1 class="text-xl font-semibold tracking-tight">{{ t('settings.title') }}</h1>
        <Select
          v-if="calendars.length > 1"
          v-model="selectedId as string"
          class="w-auto"
          :aria-label="t('settings.plannerLabel')"
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
        {{ t('settings.back') }}
      </RouterLink>
    </header>

    <p v-if="error" class="text-destructive text-sm" role="alert" data-testid="settings-error">
      {{ error }}
    </p>

    <p v-if="loading" class="text-muted-foreground text-sm">{{ t('settings.loading') }}</p>

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
        <h2 class="text-lg font-semibold">{{ t('settings.createTitle') }}</h2>
        <p class="text-muted-foreground text-sm">
          {{ t('settings.createLead') }}
        </p>
      </header>

      <div class="space-y-1">
        <Label for="first-calendar-name">{{ t('common.name') }}</Label>
        <Input
          id="first-calendar-name"
          v-model="newCalendar.name"
          :placeholder="t('gettingStarted.namePlaceholder')"
          data-testid="first-calendar-name"
        />
      </div>

      <div class="space-y-1">
        <Label for="first-calendar-timezone">{{ t('settings.timeZone') }}</Label>
        <Select
          id="first-calendar-timezone"
          v-model="newCalendar.timezone"
          data-testid="first-calendar-timezone"
        >
          <option v-for="zone in timeZones()" :key="zone" :value="zone">{{ zone }}</option>
        </Select>
      </div>

      <Button
        :disabled="newCalendar.name.trim() === ''"
        data-testid="create-calendar"
        @click="createCalendar"
      >
        {{ t('settings.create') }}
      </Button>
    </section>

    <template v-else>
      <DisplaySection :calendar-time-zone="configuration.calendar.timezone" :submit="submit" />
      <CalendarSection :configuration="configuration" :submit="submit" />

      <!--
        The assistant's key, which is the one thing on this page that is not a
        command — see the section's own note, and migration 0019.
      -->
      <div class="border-t pt-6">
        <AssistantSection />
      </div>

      <!--
        §4.3 has always allowed several planners — the picker above appears as
        soon as there are two, and the read models are per-calendar throughout.
        What was missing was any way to make the second one: the create form
        only rendered when there were none, so the first planner closed the door
        behind it. Folded away, because most people do need only one — and the
        caption says what a planner separates rather than how many you may have,
        which is what the old one was read as promising.
      -->
      <details
        class="rounded-lg border p-4"
        data-testid="add-planner-details"
        @toggle="addingPlanner = ($event.target as HTMLDetailsElement).open"
      >
        <summary class="cursor-pointer text-sm font-semibold">
          {{ t('settings.addAnother') }}
        </summary>
        <div v-if="addingPlanner" class="max-w-md space-y-3 pt-3">
          <p class="text-muted-foreground text-sm">
            {{ t('settings.addAnotherLead') }}
          </p>

          <div class="space-y-1">
            <Label for="another-calendar-name">{{ t('common.name') }}</Label>
            <Input
              id="another-calendar-name"
              v-model="newCalendar.name"
              :placeholder="t('gettingStarted.namePlaceholder')"
              data-testid="another-calendar-name"
            />
          </div>

          <div class="space-y-1">
            <Label for="another-calendar-timezone">{{ t('settings.timeZone') }}</Label>
            <Select
              id="another-calendar-timezone"
              v-model="newCalendar.timezone"
              data-testid="another-calendar-timezone"
            >
              <option v-for="zone in timeZones()" :key="zone" :value="zone">{{ zone }}</option>
            </Select>
          </div>

          <Button
            :disabled="newCalendar.name.trim() === ''"
            data-testid="create-another-calendar"
            @click="createCalendar"
          >
            {{ t('settings.create') }}
          </Button>
        </div>
      </details>
    </template>
  </div>
</template>

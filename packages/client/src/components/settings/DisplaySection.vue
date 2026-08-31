<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { session } from '@/lib/session';
import { weekdayNames } from '@/lib/time';
import type { CommandRequest } from '@ambitime/shared';

/**
 * Spec §13's user settings: locale, timezone and first-day-of-week.
 *
 * All three offer "follow the calendar" or "use my browser" as a real choice
 * rather than as an empty box, because unset is a meaningful state here — it
 * means "you decide", and a user who has never opened this screen is in it.
 *
 * A live preview sits underneath. Formatting settings are the kind whose effect
 * is obvious once seen and impossible to predict from a dropdown: "en-GB" and
 * "en-US" differ in exactly one visible way, and it is quicker to show it than
 * to explain it.
 */
const props = defineProps<{
  /** The calendar the preview is framed against, so "follow it" is concrete. */
  calendarTimeZone: string;
  submit: (request: CommandRequest) => Promise<boolean>;
}>();

const busy = ref(false);
const locale = ref('');
const timeZone = ref('');
const firstDayOfWeek = ref('');

watch(
  () => session.value,
  (active) => {
    locale.value = active?.settings.locale ?? '';
    timeZone.value = active?.settings.timeZone ?? '';
    firstDayOfWeek.value =
      active?.settings.firstDayOfWeek === null || active?.settings.firstDayOfWeek === undefined
        ? ''
        : String(active.settings.firstDayOfWeek);
  },
  { immediate: true },
);

const timeZones = computed(() => Intl.supportedValuesOf('timeZone'));

/** A handful of tags rather than every one the runtime knows: BCP-47 has
 * thousands, and a list nobody can scroll is worse than a short one. */
const LOCALES = ['en-GB', 'en-US', 'de-DE', 'fr-FR', 'es-ES', 'nl-NL', 'pt-PT', 'ja-JP'];

const previewLocale = computed(() => locale.value || navigator.language || 'en-GB');
const previewZone = computed(() => timeZone.value || props.calendarTimeZone);
const previewWeekday = computed(() => Number(firstDayOfWeek.value || '1'));

/** The same instant, shown the way every screen will show it. */
const preview = computed(() => {
  const instant = new Date('2026-03-29T13:05:00Z');

  return {
    date: new Intl.DateTimeFormat(previewLocale.value, {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: previewZone.value,
    }).format(instant),
    time: new Intl.DateTimeFormat(previewLocale.value, {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: previewZone.value,
    }).format(instant),
    weekStartsOn: weekdayNames(previewLocale.value)[previewWeekday.value - 1] ?? '',
  };
});

async function save(): Promise<void> {
  busy.value = true;
  try {
    await props.submit({
      type: 'UpdateSettings',
      params: {
        patch: {
          // Empty means unset, which is a value here rather than an omission:
          // it puts the user back to following whatever they are looking at.
          locale: locale.value === '' ? null : locale.value,
          timeZone: timeZone.value === '' ? null : timeZone.value,
          firstDayOfWeek: firstDayOfWeek.value === '' ? null : Number(firstDayOfWeek.value),
        },
      },
    });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="space-y-4" data-testid="display-section">
    <header>
      <h2 class="text-lg font-semibold">Dates and times</h2>
      <p class="text-muted-foreground text-sm">
        How things are shown to you. Scheduling itself follows each calendar's own zone, so changing
        these moves nothing.
      </p>
    </header>

    <div class="grid gap-4 sm:grid-cols-3">
      <div class="space-y-1">
        <Label for="settings-locale">Language and formats</Label>
        <Select id="settings-locale" v-model="locale" data-testid="settings-locale">
          <option value="">Use my browser's</option>
          <option v-for="tag in LOCALES" :key="tag" :value="tag">{{ tag }}</option>
        </Select>
      </div>

      <div class="space-y-1">
        <Label for="settings-timezone">Time zone</Label>
        <Select id="settings-timezone" v-model="timeZone" data-testid="settings-timezone">
          <option value="">Follow each calendar ({{ calendarTimeZone }})</option>
          <option v-for="zone in timeZones" :key="zone" :value="zone">{{ zone }}</option>
        </Select>
      </div>

      <div class="space-y-1">
        <Label for="settings-first-day">Weeks start on</Label>
        <Select id="settings-first-day" v-model="firstDayOfWeek" data-testid="settings-first-day">
          <option value="">Monday</option>
          <option
            v-for="(name, index) in weekdayNames(previewLocale)"
            :key="name"
            :value="String(index + 1)"
          >
            {{ name }}
          </option>
        </Select>
      </div>
    </div>

    <div class="bg-muted/40 rounded-md border p-3 text-sm" data-testid="settings-preview">
      <p class="text-muted-foreground mb-1 text-xs">Preview</p>
      <p>{{ preview.date }} at {{ preview.time }}</p>
      <p class="text-muted-foreground text-xs">Weeks start on {{ preview.weekStartsOn }}.</p>
    </div>

    <Button :disabled="busy" data-testid="save-display" @click="save">Save</Button>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '@/i18n';
import { useAutosave } from '@/lib/autosave';
import { timeZones } from '@/lib/zones';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { session } from '@/lib/session';
import { weekdayNames } from '@/lib/time';
import type { CommandRequest } from '@ambitime/shared';

const { t } = useI18n();

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

const autosave = useAutosave();

const locale = ref('');
const timeZone = ref('');
const firstDayOfWeek = ref('');

/** True while the fields are being filled from the server, not by a person. */
let seeding = false;

// Seeded once from the session. Not re-seeded on every answer: each save
// reloads the session, and a watch that fired on that would fight the select
// the user is still holding open.
watch(
  () => session.value?.user.id,
  () => {
    seeding = true;
    const active = session.value;
    locale.value = active?.settings.locale ?? '';
    timeZone.value = active?.settings.timeZone ?? '';
    firstDayOfWeek.value =
      active?.settings.firstDayOfWeek === null || active?.settings.firstDayOfWeek === undefined
        ? ''
        : String(active.settings.firstDayOfWeek);
    seeding = false;
  },
  { immediate: true },
);

/**
 * Any change a person made, saved.
 *
 * A watcher rather than three `@update:model-value` bindings: the fields are
 * what a save reads, so watching them is watching the thing itself — and a
 * listener has to be remembered on each new control, which is how one quietly
 * stops saving.
 *
 * `flush: 'sync'` so it runs while `seeding` still says who assigned the value.
 * A deferred watcher would fire after the seed had finished and report the
 * server's own answer back to it as an edit.
 */
watch([locale, timeZone, firstDayOfWeek], () => !seeding && edited(), { flush: 'sync' });

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

/**
 * Saved as chosen, with the preview above it already showing the answer.
 *
 * All three are selects, so there is no half-typed state to guard against —
 * every change is a complete value. The debounce is still worth having for
 * somebody arrowing through a list of six hundred time zones.
 */
function edited(): void {
  autosave.save('display', async () => {
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
  });
}
</script>

<template>
  <section class="space-y-4" data-testid="display-section">
    <header>
      <h2 class="text-lg font-semibold">{{ t('settings.display.title') }}</h2>
      <p class="text-muted-foreground text-sm">
        {{ t('settings.display.lead') }}
      </p>
    </header>

    <div class="grid gap-4 sm:grid-cols-3">
      <div class="space-y-1">
        <Label for="settings-locale">{{ t('settings.display.locale') }}</Label>
        <Select id="settings-locale" v-model="locale" data-testid="settings-locale">
          <option value="">{{ t('settings.display.useBrowser') }}</option>
          <option v-for="tag in LOCALES" :key="tag" :value="tag">{{ tag }}</option>
        </Select>
      </div>

      <div class="space-y-1">
        <Label for="settings-timezone">{{ t('settings.display.timeZone') }}</Label>
        <Select id="settings-timezone" v-model="timeZone" data-testid="settings-timezone">
          <option value="">
            {{ t('settings.display.followPlanner', { zone: calendarTimeZone }) }}
          </option>
          <option v-for="zone in timeZones()" :key="zone" :value="zone">{{ zone }}</option>
        </Select>
      </div>

      <div class="space-y-1">
        <Label for="settings-first-day">{{ t('settings.display.firstDay') }}</Label>
        <Select id="settings-first-day" v-model="firstDayOfWeek" data-testid="settings-first-day">
          <option value="">{{ weekdayNames(previewLocale)[0] }}</option>
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
      <p class="text-muted-foreground mb-1 text-xs">{{ t('settings.display.preview') }}</p>
      <p>{{ preview.date }} at {{ preview.time }}</p>
      <p class="text-muted-foreground text-xs">
        {{ t('settings.display.weekStartsOn', { day: preview.weekStartsOn }) }}
      </p>
      <p class="text-muted-foreground mt-1 text-xs" data-testid="language-note">
        {{ t('settings.display.languageNote') }}
      </p>
    </div>
  </section>
</template>

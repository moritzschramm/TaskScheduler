<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { fromLocalInput, toLocalInput } from '@/lib/time';
import type { CommandRequest, FixedBlock } from '@ambitime/shared';

const { t } = useI18n();

/**
 * Fixed blocks — spec §7.4's `AddAppointment` and `AddUnavailability`.
 *
 * Both are the same insert; the difference is whether the block has content.
 * An unavailability's title is **optional** where an appointment's is required:
 * the block means "this time is gone" whether or not anything is written on it,
 * and a week of unlabelled grey rectangles cannot answer the one question a
 * person asks it a fortnight later. Left empty it still stores nothing, and the
 * grid supplies its own word in its own language — which is the part that was
 * always right, and is why nothing is filled in on the user's behalf.
 *
 * Times are wall clock in the **calendar's** zone (§13), like everywhere else.
 */
const props = defineProps<{
  /** `null` when creating. */
  block: FixedBlock | null;
  calendarId: string;
  timeZone: string;
  /** Seeds a new block, so clicking an empty Tuesday does not open a Monday. */
  defaultStart?: string | undefined;
  submit: (request: CommandRequest) => Promise<boolean>;
}>();

const emit = defineEmits<{ cancel: []; saved: [] }>();

const busy = ref(false);
const kind = ref<'appointment' | 'unavailability'>('appointment');
const title = ref('');
const notes = ref('');
const start = ref('');
const end = ref('');
const cooldown = ref('0');
const repeats = ref(false);
const frequency = ref<'DAILY' | 'WEEKLY' | 'MONTHLY'>('WEEKLY');

/**
 * When the series stops (RFC 5545 `COUNT` / `UNTIL`).
 *
 * Both, not one, because they answer different questions and neither converts
 * into the other without knowing the calendar: "the next six" is a number the
 * user has, "until the end of term" is a date they have, and turning either
 * into the other is arithmetic they came here to avoid.
 *
 * `never` is the default and stays the common case — a standing meeting has no
 * end, and inventing one would quietly stop it.
 */
const ends = ref<'never' | 'after' | 'on'>('never');
const count = ref('10');
const untilDate = ref('');
/** Which occurrences an edit applies to (spec §8.1). */
const scope = ref<'series' | 'occurrence' | 'this_and_future'>('occurrence');

const isCreate = computed(() => props.block === null);
const isUnavailability = computed(() =>
  props.block === null ? kind.value === 'unavailability' : props.block.isUnavailability,
);

watch(
  [() => props.block, () => props.defaultStart],
  ([block, seed]) => {
    if (block === null) {
      const from = seed ?? new Date().toISOString();
      title.value = '';
      notes.value = '';
      cooldown.value = '0';
      start.value = toLocalInput(from, props.timeZone);
      end.value = toLocalInput(
        new Date(Date.parse(from) + 60 * 60_000).toISOString(),
        props.timeZone,
      );
      return;
    }

    title.value = block.title;
    notes.value = block.notes ?? '';
    cooldown.value = String(block.cooldownMin);
    start.value = toLocalInput(block.start, props.timeZone);
    end.value = toLocalInput(block.end, props.timeZone);
    repeats.value = false;
    // "This occurrence only" is the safe default: it changes the least, and a
    // user who meant the whole series will say so, while one who did not
    // cannot take back a change to every week.
    scope.value = 'occurrence';
  },
  { immediate: true },
);

const interval = computed(() => {
  const from = fromLocalInput(start.value, props.timeZone);
  const to = fromLocalInput(end.value, props.timeZone);
  if (from === null || to === null) return null;
  return Date.parse(from) < Date.parse(to) ? { start: from, end: to } : null;
});

const canSave = computed(
  () =>
    !busy.value && interval.value !== null && (isUnavailability.value || title.value.trim() !== ''),
);

/**
 * An hour, from wherever the start was just moved to.
 *
 * A start is almost always chosen before an end, and until it was the end sat
 * an hour after whatever the form opened on — usually before the new start, so
 * the commonest way to fill this in produced a block that ran backwards and a
 * red line saying so. Following the start with a default duration is what makes
 * the second field optional again rather than mandatory-in-practice.
 *
 * Read from the event rather than from `start`, so it can only be the user's
 * own typing that moves the end: the seed below sets both, and a watcher on the
 * ref would overwrite an existing block's real duration on the way in.
 */
const DEFAULT_DURATION_MIN = 60;

function startChanged(event: Event): void {
  const typed = (event.target as HTMLInputElement).value;
  const from = fromLocalInput(typed, props.timeZone);
  if (from === null) return;

  end.value = toLocalInput(
    new Date(Date.parse(from) + DEFAULT_DURATION_MIN * 60_000).toISOString(),
    props.timeZone,
  );
}

async function save(): Promise<void> {
  const times = interval.value;
  if (times === null) return;

  busy.value = true;
  try {
    // Nothing checks for an overlap, here or on the server: two blocks may
    // share an hour (§5.3, migration 0016).
    const applied = await props.submit(isCreate.value ? createRequest(times) : editRequest(times));
    if (!applied) return;

    if (isCreate.value) {
      title.value = '';
      notes.value = '';
    }
    // Closes the dialog. A modal left standing after a successful save keeps
    // its overlay across the page with nothing left to do behind it.
    emit('saved');
  } finally {
    busy.value = false;
  }
}

/**
 * The gap after the block, in minutes (§6.2 rule 3).
 *
 * Zero is sent as nothing at all rather than as `0`: the column defaults to it,
 * so an omitted value and a typed zero mean the same thing, and the log is
 * shorter for the overwhelming majority of blocks that reserve nothing.
 */
function cooldownMin(): number {
  const minutes = Number(cooldown.value);
  return Number.isInteger(minutes) && minutes > 0 ? minutes : 0;
}

function createRequest(times: { start: string; end: string }): CommandRequest {
  if (isUnavailability.value) {
    return {
      type: 'AddUnavailability',
      params: {
        calendarId: props.calendarId,
        // Omitted when blank, never sent as `''`: an absent title is what tells
        // every reader to label the block itself (§7.4).
        ...(title.value.trim() === '' ? {} : { title: title.value.trim() }),
        start: times.start,
        end: times.end,
        ...(cooldownMin() === 0 ? {} : { cooldownMin: cooldownMin() }),
        ...(repeats.value ? { recurrence: { rule: ruleText(), timeZone: props.timeZone } } : {}),
      },
    };
  }

  return {
    type: 'AddAppointment',
    params: {
      calendarId: props.calendarId,
      title: title.value,
      ...(notes.value === '' ? {} : { notes: notes.value }),
      start: times.start,
      end: times.end,
      ...(cooldownMin() === 0 ? {} : { cooldownMin: cooldownMin() }),
      // The rule carries its zone, because "every Monday at 09:00" is not a
      // statement about instants: it means a different moment either side of a
      // DST boundary (§5.1, §8.1).
      ...(repeats.value ? { recurrence: { rule: ruleText(), timeZone: props.timeZone } } : {}),
    },
  };
}

/** The subset of RFC 5545 the form offers, anchored on the chosen start. */
function ruleText(): string {
  const base =
    frequency.value === 'WEEKLY' ? `FREQ=WEEKLY;BYDAY=${weekdayCode()}` : `FREQ=${frequency.value}`;

  return `${base}${endsClause()}`;
}

/**
 * `;COUNT=n`, `;UNTIL=…`, or nothing.
 *
 * **`UNTIL` is written in the rule's own wall clock, not in UTC.** The server
 * expands these in floating mode — `DTSTART` is a UTC-labelled `Date` spelling
 * the local time, so DST comes from the scheduler's arithmetic rather than the
 * library's — and a bound in a different frame from the values it bounds is off
 * by the zone offset. Which is invisible in January and drops an instance in
 * July, the worst way for a date to be wrong.
 *
 * The last moment of the chosen day, so "until the 30th" includes the 30th.
 * People name the last day they mean, not the first they do not.
 */
function endsClause(): string {
  if (ends.value === 'after') {
    const times = Number(count.value);
    return Number.isInteger(times) && times > 0 ? `;COUNT=${times}` : '';
  }

  if (ends.value === 'on' && untilDate.value !== '') {
    return `;UNTIL=${untilDate.value.replaceAll('-', '')}T235900Z`;
  }

  return '';
}

const WEEKDAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;

function weekdayCode(): string {
  const iso = start.value === '' ? 1 : isoWeekdayOf(start.value);
  return WEEKDAY_CODES[iso - 1] ?? 'MO';
}

/** ISO weekday of a `YYYY-MM-DDTHH:MM` wall clock, 1 = Monday. */
function isoWeekdayOf(localInput: string): number {
  const [datePart] = localInput.split('T');
  const [year, month, day] = (datePart ?? '').split('-').map(Number);
  if (!year || !month || !day) return 1;

  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function editRequest(times: { start: string; end: string }): CommandRequest {
  return {
    type: 'EditAppointment',
    expectedVersion: props.block!.version,
    params: {
      appointmentId: props.block!.appointmentId,
      ...(props.block!.isRecurring && props.block!.occurrenceStart !== null
        ? { scope: scope.value, occurrenceStart: props.block!.occurrenceStart }
        : {}),
      patch: {
        // `null` clears it, which only an untitled unavailability can reach —
        // an appointment cannot be saved without one.
        title: title.value.trim() === '' ? null : title.value.trim(),
        notes: notes.value === '' ? null : notes.value,
        interval: times,
        // Always sent on an edit, zero included: this is the one place the
        // value can be taken back down again.
        cooldownMin: cooldownMin(),
      },
    },
  };
}

async function cancelBlock(): Promise<void> {
  if (props.block === null) return;

  busy.value = true;
  try {
    // Cancelled rather than deleted: the read filters cancelled blocks out, and
    // a counterparty who was told about it (§7.2) needs the row to still exist.
    // Deleting one instance of a series is the same act as editing one: a row
    // that replaces it and is itself cancelled (§8.1).
    await props.submit({
      type: 'EditAppointment',
      expectedVersion: props.block.version,
      params: {
        appointmentId: props.block.appointmentId,
        ...(props.block.isRecurring && props.block.occurrenceStart !== null
          ? { scope: scope.value, occurrenceStart: props.block.occurrenceStart }
          : {}),
        patch: { status: 'cancelled' },
      },
    });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="space-y-4" data-testid="appointment-editor">
    <header>
      <h2 class="text-lg font-semibold">
        {{
          isCreate
            ? t('appointments.editorNew')
            : isUnavailability
              ? t('appointments.editorEditUnavailability')
              : t('appointments.editorEdit')
        }}
      </h2>
      <p class="text-muted-foreground text-sm">
        {{ t('appointments.lead2') }}
      </p>
    </header>

    <fieldset v-if="isCreate" class="flex items-center gap-4">
      <legend class="sr-only">{{ t('appointments.kindLegend') }}</legend>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="kind" type="radio" value="appointment" data-testid="kind-appointment" />
        {{ t('appointments.kindAppointment') }}
      </label>
      <label class="flex items-center gap-2 text-sm">
        <input
          v-model="kind"
          type="radio"
          value="unavailability"
          data-testid="kind-unavailability"
        />
        {{ t('appointments.kindUnavailability') }}
      </label>
    </fieldset>

    <div class="space-y-1">
      <Label for="appointment-title">
        {{ isUnavailability ? t('appointments.titleOptional') : t('common.title') }}
      </Label>
      <Input
        id="appointment-title"
        v-model="title"
        :placeholder="isUnavailability ? t('common.unavailable') : ''"
        data-testid="appointment-title"
      />
      <p
        v-if="isUnavailability"
        class="text-muted-foreground text-xs"
        data-testid="unavailability-note"
      >
        {{ t('appointments.untitledNote') }}
      </p>
    </div>

    <div v-if="!isUnavailability" class="space-y-1">
      <Label for="appointment-notes">{{ t('common.notes') }}</Label>
      <textarea
        id="appointment-notes"
        v-model="notes"
        rows="3"
        class="border-input bg-background ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-16 w-full resize-y rounded-md border px-3 py-2 text-sm shadow-xs transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        data-testid="appointment-notes"
      />
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <div class="space-y-1">
        <Label for="appointment-start">{{ t('appointments.starts') }}</Label>
        <input
          id="appointment-start"
          v-model="start"
          type="datetime-local"
          class="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          data-testid="appointment-start"
          @input="startChanged"
        />
      </div>
      <div class="space-y-1">
        <Label for="appointment-end">{{ t('appointments.ends') }}</Label>
        <!-- Follows the start by an hour; see `startChanged`. Still editable. -->
        <input
          id="appointment-end"
          v-model="end"
          type="datetime-local"
          class="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          data-testid="appointment-end"
        />
      </div>
    </div>

    <div class="space-y-1">
      <Label for="appointment-cooldown">{{ t('appointments.cooldown') }}</Label>
      <Input
        id="appointment-cooldown"
        v-model="cooldown"
        type="number"
        min="0"
        class="w-32"
        data-testid="appointment-cooldown"
      />
      <!--
        Said in words, because the block's own end does not move and the effect
        is only visible in where *other* things land.
      -->
      <p class="text-muted-foreground text-xs">{{ t('appointments.cooldownNote') }}</p>
    </div>

    <fieldset v-if="isCreate" class="space-y-2" data-testid="recurrence-fieldset">
      <label class="flex items-center gap-2 text-sm">
        <input v-model="repeats" type="checkbox" data-testid="appointment-repeats" />
        {{ t('appointments.repeats') }}
      </label>
      <div v-if="repeats" class="flex flex-wrap items-center gap-2">
        <Select
          v-model="frequency"
          class="w-48"
          :aria-label="t('appointments.howOften')"
          data-testid="appointment-frequency"
        >
          <option value="DAILY">{{ t('appointments.daily') }}</option>
          <option value="WEEKLY">{{ t('appointments.weekly') }}</option>
          <option value="MONTHLY">{{ t('appointments.monthly') }}</option>
        </Select>

        <Select
          v-model="ends"
          class="w-40"
          :aria-label="t('appointments.whenItStops')"
          data-testid="appointment-ends"
        >
          <option value="never">{{ t('appointments.endsNever') }}</option>
          <option value="after">{{ t('appointments.endsAfter') }}</option>
          <option value="on">{{ t('appointments.endsOn') }}</option>
        </Select>

        <Input
          v-if="ends === 'after'"
          v-model="count"
          type="number"
          min="1"
          class="w-24"
          :aria-label="t('appointments.howManyTimes')"
          data-testid="appointment-count"
        />
        <input
          v-if="ends === 'on'"
          v-model="untilDate"
          type="date"
          class="border-input bg-background focus-visible:ring-ring h-9 rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          :aria-label="t('appointments.lastDay')"
          data-testid="appointment-until"
        />
      </div>

      <p v-if="repeats && ends === 'on'" class="text-muted-foreground text-xs">
        {{ t('appointments.inclusive') }}
      </p>
    </fieldset>

    <fieldset
      v-else-if="block?.isRecurring && block.occurrenceStart !== null"
      class="space-y-1"
      data-testid="scope-fieldset"
    >
      <legend class="text-sm font-medium">{{ t('appointments.scopeLegend') }}</legend>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="scope" type="radio" value="occurrence" data-testid="scope-occurrence" />
        {{ t('appointments.scopeOccurrence') }}
      </label>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="scope" type="radio" value="this_and_future" data-testid="scope-future" />
        {{ t('appointments.scopeFuture') }}
      </label>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="scope" type="radio" value="series" data-testid="scope-series" />
        {{ t('appointments.scopeSeries') }}
      </label>
    </fieldset>

    <p class="text-muted-foreground text-xs">{{ t('appointments.localTo', { zone: timeZone }) }}</p>
    <p v-if="interval === null" class="text-destructive text-sm" data-testid="interval-invalid">
      {{ t('appointments.backwards') }}
    </p>

    <div class="flex flex-wrap items-center gap-2">
      <Button :disabled="!canSave" data-testid="save-appointment" @click="save">
        {{ isCreate ? t('appointments.addBlock') : t('appointments.saveBlock') }}
      </Button>
      <Button
        variant="ghost"
        :disabled="busy"
        data-testid="cancel-appointment-edit"
        @click="emit('cancel')"
      >
        {{ t('common.cancel') }}
      </Button>
      <template v-if="block">
        <span class="grow" />
        <Button
          variant="ghost"
          :disabled="busy"
          data-testid="delete-appointment"
          @click="cancelBlock"
        >
          {{ t('appointments.removeBlock') }}
        </Button>
      </template>
    </div>
  </section>
</template>

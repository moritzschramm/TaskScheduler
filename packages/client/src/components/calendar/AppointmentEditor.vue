<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { fromLocalInput, toLocalInput } from '@/lib/time';
import type { CommandRequest, FixedBlock } from '@ambitime/shared';

/**
 * Fixed blocks — spec §7.4's `AddAppointment` and `AddUnavailability`.
 *
 * Both are the same insert; the difference is whether the block has content.
 * An unavailability is content-free *by definition* — "unavailable 14:00–16:00"
 * — so its title field is not merely optional here, it is absent, and the
 * command carries none. Putting words in a user's calendar that they never
 * wrote is the failure mode that matters: a shared view or an export would show
 * them as if they had.
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

const emit = defineEmits<{ cancel: [] }>();

const busy = ref(false);
const kind = ref<'appointment' | 'unavailability'>('appointment');
const title = ref('');
const notes = ref('');
const start = ref('');
const end = ref('');
const repeats = ref(false);
const frequency = ref<'DAILY' | 'WEEKLY' | 'MONTHLY'>('WEEKLY');
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
      start.value = toLocalInput(from, props.timeZone);
      end.value = toLocalInput(
        new Date(Date.parse(from) + 60 * 60_000).toISOString(),
        props.timeZone,
      );
      return;
    }

    title.value = block.title;
    notes.value = block.notes ?? '';
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

async function save(): Promise<void> {
  const times = interval.value;
  if (times === null) return;

  busy.value = true;
  try {
    // An overlap is refused by the database's exclusion constraint and comes
    // back as a sentence the caller can read (§5.3); nothing is checked here,
    // because a read-then-write check cannot hold against a concurrent insert
    // and would only be a second, weaker opinion.
    const applied = await props.submit(isCreate.value ? createRequest(times) : editRequest(times));
    if (applied && isCreate.value) {
      title.value = '';
      notes.value = '';
    }
  } finally {
    busy.value = false;
  }
}

function createRequest(times: { start: string; end: string }): CommandRequest {
  if (isUnavailability.value) {
    return {
      type: 'AddUnavailability',
      params: { calendarId: props.calendarId, start: times.start, end: times.end },
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
      // The rule carries its zone, because "every Monday at 09:00" is not a
      // statement about instants: it means a different moment either side of a
      // DST boundary (§5.1, §8.1).
      ...(repeats.value ? { recurrence: { rule: ruleText(), timeZone: props.timeZone } } : {}),
    },
  };
}

/** The subset of RFC 5545 the form offers, anchored on the chosen start. */
function ruleText(): string {
  return frequency.value === 'WEEKLY'
    ? `FREQ=WEEKLY;BYDAY=${weekdayCode()}`
    : `FREQ=${frequency.value}`;
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
        ...(isUnavailability.value ? {} : { title: title.value }),
        notes: notes.value === '' ? null : notes.value,
        interval: times,
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
            ? 'New fixed block'
            : isUnavailability
              ? 'Edit unavailability'
              : 'Edit appointment'
        }}
      </h2>
      <p class="text-muted-foreground text-sm">
        Tasks are scheduled around fixed blocks, never through them.
      </p>
    </header>

    <fieldset v-if="isCreate" class="flex items-center gap-4">
      <legend class="sr-only">Kind of block</legend>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="kind" type="radio" value="appointment" data-testid="kind-appointment" />
        Appointment
      </label>
      <label class="flex items-center gap-2 text-sm">
        <input
          v-model="kind"
          type="radio"
          value="unavailability"
          data-testid="kind-unavailability"
        />
        Unavailable
      </label>
    </fieldset>

    <div v-if="!isUnavailability" class="space-y-1">
      <Label for="appointment-title">Title</Label>
      <Input id="appointment-title" v-model="title" data-testid="appointment-title" />
    </div>
    <p v-else class="text-muted-foreground text-sm" data-testid="unavailability-note">
      An unavailable block carries no title — it only says the time is taken.
    </p>

    <div v-if="!isUnavailability" class="space-y-1">
      <Label for="appointment-notes">Notes</Label>
      <Input id="appointment-notes" v-model="notes" data-testid="appointment-notes" />
    </div>

    <div class="grid gap-3 sm:grid-cols-2">
      <div class="space-y-1">
        <Label for="appointment-start">Starts</Label>
        <input
          id="appointment-start"
          v-model="start"
          type="datetime-local"
          class="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          data-testid="appointment-start"
        />
      </div>
      <div class="space-y-1">
        <Label for="appointment-end">Ends</Label>
        <input
          id="appointment-end"
          v-model="end"
          type="datetime-local"
          class="border-input bg-background focus-visible:ring-ring h-9 w-full rounded-md border px-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
          data-testid="appointment-end"
        />
      </div>
    </div>

    <fieldset v-if="isCreate" class="space-y-2" data-testid="recurrence-fieldset">
      <label class="flex items-center gap-2 text-sm">
        <input v-model="repeats" type="checkbox" data-testid="appointment-repeats" />
        Repeats
      </label>
      <Select
        v-if="repeats"
        v-model="frequency"
        class="w-48"
        aria-label="How often"
        data-testid="appointment-frequency"
      >
        <option value="DAILY">every day</option>
        <option value="WEEKLY">every week, on this weekday</option>
        <option value="MONTHLY">every month</option>
      </Select>
      <p v-if="repeats" class="text-muted-foreground text-xs">
        A repeating appointment happens at a fixed time. A repeating <em>task</em> is a different
        thing: it says how often, and the schedule chooses when.
      </p>
    </fieldset>

    <fieldset
      v-else-if="block?.isRecurring && block.occurrenceStart !== null"
      class="space-y-1"
      data-testid="scope-fieldset"
    >
      <legend class="text-sm font-medium">This change applies to</legend>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="scope" type="radio" value="occurrence" data-testid="scope-occurrence" />
        only this occurrence
      </label>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="scope" type="radio" value="this_and_future" data-testid="scope-future" />
        this and all future occurrences
      </label>
      <label class="flex items-center gap-2 text-sm">
        <input v-model="scope" type="radio" value="series" data-testid="scope-series" />
        every occurrence, past ones included
      </label>
    </fieldset>

    <p class="text-muted-foreground text-xs">Local to {{ timeZone }}.</p>
    <p v-if="interval === null" class="text-destructive text-sm" data-testid="interval-invalid">
      A block must end after it starts.
    </p>

    <div class="flex flex-wrap items-center gap-2">
      <Button :disabled="!canSave" data-testid="save-appointment" @click="save">
        {{ isCreate ? 'Add block' : 'Save block' }}
      </Button>
      <Button
        variant="ghost"
        :disabled="busy"
        data-testid="cancel-appointment-edit"
        @click="emit('cancel')"
      >
        Cancel
      </Button>
      <template v-if="block">
        <span class="grow" />
        <Button
          variant="ghost"
          :disabled="busy"
          data-testid="delete-appointment"
          @click="cancelBlock"
        >
          Remove block
        </Button>
      </template>
    </div>
  </section>
</template>

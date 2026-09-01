<script setup lang="ts">
import { Button } from '@/components/ui/button';
import { useWorkspace } from '@/lib/workspace';

/**
 * What every screen says before it can say anything else.
 *
 * The three views read one workspace, so they fail and load together; saying
 * so three times in three slightly different wordings would be three chances
 * to drift.
 */
const { calendars, error, diverged, loading } = useWorkspace();
</script>

<template>
  <p v-if="error" class="text-destructive text-sm" data-testid="calendar-error">{{ error }}</p>
  <p
    v-else-if="diverged"
    class="text-muted-foreground text-sm"
    role="status"
    data-testid="schedule-diverged"
  >
    The server placed things a little differently from the preview, and its answer is what you are
    looking at now.
  </p>
  <p v-else-if="loading" class="text-muted-foreground text-sm">Loading the schedule…</p>

  <!--
    A new account has a tenant but no calendar: §4.3 says a user may own
    several, so nothing creates one for them. Without this the schedule
    rendered nothing at all — signing up and landing on a blank page is not
    a working registration.
  -->
  <section
    v-else-if="calendars.length === 0"
    class="max-w-prose space-y-3"
    data-testid="no-calendar-yet"
  >
    <h2 class="text-lg font-semibold">Welcome. Let's make you a calendar.</h2>
    <p class="text-muted-foreground text-sm">
      A calendar is a scheduling context — a set of hours you work in and the kinds of thing you do
      in them. You can have several; work and personal keep their own windows and their own week.
    </p>
    <Button as-child data-testid="create-first-calendar">
      <RouterLink to="/settings">Set up my first calendar</RouterLink>
    </Button>
  </section>
</template>

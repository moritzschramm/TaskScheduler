<script setup lang="ts">
import GettingStarted from '@/components/GettingStarted.vue';
import { useI18n } from '@/i18n';
import { useWorkspace } from '@/lib/workspace';

/**
 * What every screen says before it can say anything else.
 *
 * The three views read one workspace, so they fail and load together; saying
 * so three times in three slightly different wordings would be three chances
 * to drift.
 */
const { calendars, categories, error, diverged, notice, loading } = useWorkspace();

const { t } = useI18n();
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
  <!--
    What the last command did, when the grid cannot say it (see `notice` in
    `lib/workspace`). Below the error and the divergence line, which are both
    about something having gone differently from the plan, and above "loading",
    which by this point is over.
  -->
  <p v-else-if="notice" class="text-muted-foreground text-sm" role="status" data-testid="notice">
    {{ notice }}
  </p>
  <p v-else-if="loading" class="text-muted-foreground text-sm">{{ t('app.loading') }}</p>

  <!--
    A new account can schedule nothing until a category has hours, and a
    planner alone gets it no closer — so that, not the planner, is what the
    first screen asks for. It stays up until there is a category, because an
    account with a planner and no categories is in exactly the same position
    as one with neither.
  -->
  <!--
    No `data-testid` here: a fallthrough attribute overrides the component's
    own, and this one would have replaced the name the component answers to.
  -->
  <GettingStarted v-else-if="calendars.length === 0 || categories.length === 0" />
</template>

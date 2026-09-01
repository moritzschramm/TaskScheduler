<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { resendVerification, session, signOut, startHeartbeat, stopHeartbeat } from '@/lib/session';

/**
 * The frame around every signed-in page.
 *
 * The context strip is §9.3's switcher in read-only form: which tenant this
 * request is acting in, and which others exist. Switching is a write to the
 * *session* rather than to domain state, so it is not a command and does not
 * belong to M11's configuration surface; showing the list is what makes its
 * absence obvious rather than invisible.
 */

const router = useRouter();

// Presence is a fact about a signed-in page being open (§11), so the beat
// starts with the shell and stops with it.
onMounted(startHeartbeat);
onUnmounted(stopHeartbeat);

const active = computed(() =>
  session.value?.contexts.find((context) => context.tenantId === session.value?.activeTenantId),
);

async function leave() {
  stopHeartbeat();
  await signOut();
  await router.replace({ name: 'sign-in' });
}

/**
 * The unconfirmed-address notice (spec §10.1, §11).
 *
 * A strip rather than a modal, and one that never blocks: with verification
 * not required, an unconfirmed address costs the user nothing today and only
 * costs them §11's email when they are offline — so the notice states a
 * consequence and offers the fix, rather than standing in the way of an
 * application that works fine without it.
 *
 * Dismissible for the same reason. Somebody who cannot reach that mailbox
 * right now should not have to look at this on every page for a week.
 */
const dismissed = ref(false);
const resent = ref(false);
const resendError = ref<string | null>(null);
const resending = ref(false);

const unverified = computed(
  () => session.value !== null && !session.value.user.emailVerified && !dismissed.value,
);

async function confirmAgain() {
  const address = session.value?.user.email;
  if (address === undefined) return;

  resending.value = true;
  resendError.value = null;

  try {
    resendError.value = await resendVerification(address);
    if (resendError.value === null) resent.value = true;
  } finally {
    resending.value = false;
  }
}
</script>

<template>
  <!--
    The shell owns the viewport, and `main` is the only thing that scrolls.

    It used to be `min-h-full` on a page that grew as tall as its content, which
    left the document scrolling *and* the week grid scrolling inside it — two
    vertical scrollbars for one page. Pinning the frame to the viewport also
    keeps the header and the verification notice in place, which is what a
    person navigating a long week actually wants from them.
  -->
  <div class="bg-background flex h-full flex-col">
    <!--
      WCAG 2.4.1. The header is short, but the calendar behind it is a grid of
      focusable blocks — without this, reaching the task panel by keyboard
      means tabbing through everything on screen first.
    -->
    <a
      class="bg-background focus:ring-ring sr-only focus:not-sr-only focus:absolute focus:z-50 focus:m-2 focus:rounded-md focus:border focus:px-3 focus:py-2 focus:ring-2"
      href="#main"
      data-testid="skip-link"
    >
      Skip to the main content
    </a>

    <header
      v-if="session"
      class="flex shrink-0 items-center justify-between gap-4 border-b px-6 py-3"
      data-testid="app-shell-header"
    >
      <div class="flex items-baseline gap-3">
        <span class="text-sm font-semibold tracking-tight">Ambitime</span>
        <Badge v-if="active" variant="secondary" data-testid="active-context">
          {{ active.isPersonal ? 'Personal' : active.name }}
        </Badge>
        <span
          v-if="session.contexts.length > 1"
          class="text-muted-foreground text-xs"
          data-testid="context-count"
        >
          {{ session.contexts.length }} contexts
        </span>
      </div>

      <div class="flex items-center gap-3">
        <RouterLink
          class="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
          to="/history"
          data-testid="history-link"
        >
          History
        </RouterLink>
        <RouterLink
          class="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
          to="/settings"
          data-testid="settings-link"
        >
          Settings
        </RouterLink>
        <span class="text-muted-foreground text-xs">{{ session.user.email }}</span>
        <Button variant="ghost" size="sm" data-testid="sign-out" @click="leave">Sign out</Button>
      </div>
    </header>

    <!--
      `role="status"` rather than `alert`: nothing is wrong, and interrupting a
      screen reader mid-sentence to say so would be the wrong volume for it.
    -->
    <div
      v-if="unverified"
      class="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b bg-amber-50 px-6 py-2 text-sm text-amber-950 dark:bg-amber-950 dark:text-amber-50"
      role="status"
      data-testid="unverified-banner"
    >
      <p v-if="resent" data-testid="verification-resent">
        Sent. Check <strong>{{ session?.user.email }}</strong> for the link.
      </p>
      <p v-else-if="resendError" data-testid="verification-resend-error">{{ resendError }}</p>
      <p v-else>Confirm your email address so Ambitime can reach you when a due date is at risk.</p>

      <div class="flex items-center gap-2">
        <Button
          v-if="!resent"
          variant="outline"
          size="sm"
          :disabled="resending"
          data-testid="resend-verification"
          @click="confirmAgain"
        >
          {{ resending ? 'Sending…' : 'Send the link again' }}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid="dismiss-verification"
          @click="dismissed = true"
        >
          Not now
        </Button>
      </div>
    </div>

    <!--
      `min-h-0` so the flex item may shrink below its content and scroll, and
      `relative` so it is the containing block for what it holds.

      The second is not decoration. `sr-only` positions absolutely, so every
      visually-hidden label in a long page resolved against the initial
      containing block and escaped this element's clip — one of them sits a
      thousand pixels down the task table and was stretching the *document* to
      reach it, which is where the second scrollbar came from. Any descendant
      that positions itself now resolves against this box and scrolls with it.
    -->
    <main id="main" class="relative min-h-0 flex-1 overflow-y-auto" tabindex="-1">
      <slot />
    </main>
  </div>
</template>

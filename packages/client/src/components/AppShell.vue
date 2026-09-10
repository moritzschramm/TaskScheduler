<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import {
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuPortal,
  DropdownMenuRoot,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from 'reka-ui';
import { ChevronDown } from 'lucide-vue-next';
import UndoRedo from '@/components/UndoRedo.vue';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { resendVerification, session, signOut, startHeartbeat, stopHeartbeat } from '@/lib/session';
import { resetWorkspace, useWorkspace } from '@/lib/workspace';
import { useI18n } from '@/i18n';

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

const { t } = useI18n();
const { history, submit } = useWorkspace();

/**
 * The labels are computed, not constants.
 *
 * A frozen array built at module load would keep the language it was built in
 * for the life of the tab, so switching language in settings would leave the
 * navigation in the old one — the one part of the screen a reader would be
 * certain was broken.
 */
const primary = computed(() => [
  { to: '/', label: t('nav.schedule'), testId: 'nav-schedule' },
  { to: '/tasks', label: t('nav.tasks'), testId: 'nav-tasks' },
  { to: '/categories', label: t('nav.categories'), testId: 'nav-categories' },
]);

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
  // The schedule is held at module scope, so it outlives the session unless
  // something drops it. Signing in as somebody else must not show the last
  // person's week for the moment before the first read lands.
  resetWorkspace();
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
      {{ t('app.skipToContent') }}
    </a>

    <header
      v-if="session"
      class="flex shrink-0 items-center justify-between gap-4 border-b px-6 py-3"
      data-testid="app-shell-header"
    >
      <div class="flex items-baseline gap-3">
        <span class="text-sm font-semibold tracking-tight">{{ t('app.name') }}</span>
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

      <!--
        The three screens the week is worked on, promoted out of one crowded
        page. `aria-current` rather than colour alone says which you are on
        (WCAG 1.4.1), and the exact match on Schedule keeps it from staying lit
        on every route beneath `/`.
      -->
      <nav class="flex flex-1 items-center gap-1" :aria-label="t('app.mainLandmark')">
        <RouterLink
          v-for="link in primary"
          :key="link.to"
          v-slot="{ isActive, isExactActive }"
          :to="link.to"
          custom
        >
          <RouterLink
            class="rounded-md px-3 py-1.5 text-sm"
            :class="
              (link.to === '/' ? isExactActive : isActive)
                ? 'bg-secondary text-secondary-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground'
            "
            :to="link.to"
            :aria-current="(link.to === '/' ? isExactActive : isActive) ? 'page' : undefined"
            :data-testid="link.testId"
          >
            {{ link.label }}
          </RouterLink>
        </RouterLink>
      </nav>

      <div class="flex items-center gap-2">
        <!--
          Undo and redo belong to the application, not to the week.
          They lived in the calendar toolbar, so the two screens that draw no
          calendar could not reach them — while the log they read is one log
          across every screen (§7.5). Here they are wherever you are.
        -->
        <UndoRedo :history="history" :submit="submit" />

        <!--
          Everything about *you* behind your own name. Three links spread along
          the bar competed with the four that are the application; folded away,
          the bar says what this app does and the menu says what you can do to
          your account.
        -->
        <DropdownMenuRoot>
          <DropdownMenuTrigger
            class="text-muted-foreground hover:text-foreground focus-visible:ring-ring flex items-center gap-1 rounded-md px-2 py-1 text-xs focus-visible:ring-2 focus-visible:outline-none"
            data-testid="account-menu"
          >
            {{ session.user.email }}
            <ChevronDown class="size-3" aria-hidden="true" />
          </DropdownMenuTrigger>

          <DropdownMenuPortal disabled>
            <DropdownMenuContent
              class="bg-popover text-popover-foreground z-50 min-w-44 rounded-md border p-1 shadow-md"
              align="end"
              :side-offset="6"
              data-testid="account-menu-panel"
            >
              <DropdownMenuItem
                class="hover:bg-accent focus:bg-accent w-full cursor-pointer rounded-sm px-2 py-1.5 text-sm outline-none"
                data-testid="history-link"
                @select="router.push('/history')"
              >
                {{ t('app.history') }}
              </DropdownMenuItem>
              <DropdownMenuItem
                class="hover:bg-accent focus:bg-accent w-full cursor-pointer rounded-sm px-2 py-1.5 text-sm outline-none"
                data-testid="settings-link"
                @select="router.push('/settings')"
              >
                {{ t('app.settings') }}
              </DropdownMenuItem>
              <DropdownMenuSeparator class="bg-border -mx-1 my-1 h-px" />
              <DropdownMenuItem
                class="hover:bg-accent focus:bg-accent w-full cursor-pointer rounded-sm px-2 py-1.5 text-sm outline-none"
                data-testid="sign-out"
                @select="leave"
              >
                {{ t('app.signOut') }}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenuPortal>
        </DropdownMenuRoot>
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
        {{ t('verify.sent', { email: session?.user.email ?? '' }) }}
      </p>
      <p v-else-if="resendError" data-testid="verification-resend-error">{{ resendError }}</p>
      <p v-else>{{ t('verify.prompt') }}</p>

      <div class="flex items-center gap-2">
        <Button
          v-if="!resent"
          variant="outline"
          size="sm"
          :disabled="resending"
          data-testid="resend-verification"
          @click="confirmAgain"
        >
          {{ resending ? `${t('verify.resend')}…` : t('verify.resend') }}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          data-testid="dismiss-verification"
          @click="dismissed = true"
        >
          {{ t('verify.dismiss') }}
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

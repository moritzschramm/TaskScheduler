<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from '@/i18n';
import { useRoute, useRouter } from 'vue-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { MINIMUM_PASSWORD_LENGTH, resetPassword } from '@/lib/session';

const { t } = useI18n();

/**
 * Choosing a new password (spec §10.1).
 *
 * Reached only from an email. Better Auth's own `/reset-password/:token`
 * endpoint checks the token before it redirects here, so this page is entered
 * with `?token=` when it was good and with `?error=` when it was not — which
 * is why there is no "check the token" step below. The check already happened,
 * one redirect ago, on the server.
 *
 * Every other session ends when the password changes
 * (`revokeSessionsOnPasswordReset`), so signing in again is not friction — it
 * is the point, and saying so is what stops it reading as a bug.
 */
const route = useRoute();
const router = useRouter();

const token = computed(() =>
  typeof route.query['token'] === 'string' ? route.query['token'] : '',
);
const linkError = computed(() =>
  typeof route.query['error'] === 'string' ? route.query['error'] : null,
);

const password = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

const tooShort = computed(
  () => password.value.length > 0 && password.value.length < MINIMUM_PASSWORD_LENGTH,
);

async function submit() {
  // The disabled button stops a click but not Enter in the field — see the
  // same guard on the sign-up form.
  if (tooShort.value) return;

  busy.value = true;
  error.value = null;

  try {
    error.value = await resetPassword(token.value, password.value);
    if (error.value === null) {
      // Straight to sign-in rather than into the app: the reset just revoked
      // every session, including any this browser was holding.
      await router.replace({ name: 'sign-in' });
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="flex min-h-full items-center justify-center p-8">
    <Card class="w-full max-w-sm" data-testid="reset-password">
      <CardHeader>
        <CardTitle>{{ t('auth.resetTitle') }}</CardTitle>
        <CardDescription v-if="!linkError && token">
          {{ t('auth.resetLead') }}
        </CardDescription>
      </CardHeader>

      <CardContent>
        <!--
          A dead link, named as such. "Expired or already used" is the honest
          pair — the endpoint consumes the token, so a second click on a link
          that worked looks exactly like one that never did.
        -->
        <div
          v-if="linkError || !token"
          class="flex flex-col gap-4"
          role="alert"
          data-testid="reset-link-dead"
        >
          <p class="text-sm">
            {{ t('auth.resetExpired') }}
          </p>
          <Button as-child data-testid="request-another">
            <RouterLink to="/forgot-password">{{ t('auth.sendNewLink') }}</RouterLink>
          </Button>
        </div>

        <form v-else class="flex flex-col gap-4" @submit.prevent="submit">
          <div class="flex flex-col gap-1.5">
            <label class="text-sm font-medium" for="password">{{ t('auth.newPassword') }}</label>
            <input
              id="password"
              v-model="password"
              type="password"
              autocomplete="new-password"
              required
              :minlength="MINIMUM_PASSWORD_LENGTH"
              :aria-describedby="tooShort ? 'password-hint' : undefined"
              :aria-invalid="tooShort ? 'true' : undefined"
              class="border-input bg-background rounded-md border px-3 py-2 text-sm"
              data-testid="new-password"
            />
            <p
              id="password-hint"
              class="text-xs"
              :class="tooShort ? 'text-destructive' : 'text-muted-foreground'"
              data-testid="password-hint"
            >
              At least {{ MINIMUM_PASSWORD_LENGTH }} characters.
            </p>
          </div>

          <p v-if="error" class="text-destructive text-sm" role="alert" data-testid="reset-error">
            {{ error }}
          </p>

          <Button type="submit" :disabled="busy || tooShort" data-testid="reset-submit">
            {{ busy ? 'Saving…' : 'Set new password' }}
          </Button>
        </form>
      </CardContent>
    </Card>
  </main>
</template>

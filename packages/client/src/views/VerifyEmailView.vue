<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { useI18n } from '@/i18n';
import { useRoute } from 'vue-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { loadSession, resendVerification, session } from '@/lib/session';

const { t } = useI18n();

/**
 * Where a confirmation link lands (spec §10.1).
 *
 * **The verifying already happened.** Better Auth's `/verify-email` endpoint
 * consumes the token, sets the flag, signs the reader in and only then
 * redirects here — so this page reports an outcome rather than producing one.
 * Which is why it arrives clean on success and with `?error=` when the token
 * was forged, spent or stale.
 *
 * The session is re-read on arrival because the redirect may have created one:
 * somebody who followed the link in a different browser is signed in by the
 * time they get here, and the shell above should say so.
 */
const route = useRoute();

const failure = computed(() =>
  typeof route.query['error'] === 'string' ? route.query['error'] : null,
);

const resent = ref(false);
const resendError = ref<string | null>(null);
const busy = ref(false);

onMounted(async () => {
  await loadSession();
});

/**
 * Only offered to somebody signed in, because only then is there an address to
 * send to. A dead link carries no identity — the token is the identity, and it
 * is what failed — so the signed-out case can do nothing but point at sign-in.
 */
async function resend() {
  const address = session.value?.user.email;
  if (address === undefined) return;

  busy.value = true;
  resendError.value = null;

  try {
    resendError.value = await resendVerification(address);
    if (resendError.value === null) resent.value = true;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="flex min-h-full items-center justify-center p-8">
    <Card class="w-full max-w-sm" data-testid="verify-email">
      <template v-if="failure === null">
        <CardHeader>
          <CardTitle>{{ t('auth.verifiedTitle') }}</CardTitle>
          <CardDescription>
            {{ t('auth.verifiedLead') }}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button as-child data-testid="verified-continue">
            <RouterLink to="/">{{ t('auth.openSchedule') }}</RouterLink>
          </Button>
        </CardContent>
      </template>

      <template v-else>
        <CardHeader>
          <CardTitle>{{ t('auth.verifyFailed') }}</CardTitle>
          <CardDescription data-testid="verify-error">
            {{
              failure === 'TOKEN_EXPIRED'
                ? 'It expired. Confirmation links last a day.'
                : 'It has expired or has already been used.'
            }}
          </CardDescription>
        </CardHeader>

        <CardContent class="flex flex-col gap-3">
          <p v-if="resent" class="text-sm" role="status" data-testid="verify-resent">
            Sent. Check <strong>{{ session?.user.email }}</strong> for a new link.
          </p>
          <p
            v-else-if="resendError"
            class="text-destructive text-sm"
            role="alert"
            data-testid="verify-resend-error"
          >
            {{ resendError }}
          </p>

          <Button
            v-if="session && !resent"
            :disabled="busy"
            data-testid="verify-resend"
            @click="resend"
          >
            {{ busy ? 'Sending…' : 'Send me a new link' }}
          </Button>

          <Button v-if="!session" as-child variant="outline">
            <RouterLink to="/sign-in">{{ t('auth.signIn') }}</RouterLink>
          </Button>
        </CardContent>
      </template>
    </Card>
  </main>
</template>

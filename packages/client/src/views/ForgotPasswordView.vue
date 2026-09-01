<script setup lang="ts">
import { ref } from 'vue';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { requestPasswordReset } from '@/lib/session';

/**
 * Asking for a reset link (spec §10.1).
 *
 * **The confirmation is the same whether or not the address has an account,
 * and that is not a hedge.** The server behaves identically for both, so the
 * sentence below describes what happened rather than declining to say. It is
 * also the one place in this flow where hiding existence costs the user
 * nothing: somebody who owns the address gets the mail either way, and
 * somebody who does not learns nothing by asking.
 *
 * Contrast the sign-up form, which cannot manage the same trick — see `signUp`.
 */
const email = ref('');
const sent = ref(false);
const error = ref<string | null>(null);
const busy = ref(false);

async function submit() {
  busy.value = true;
  error.value = null;

  try {
    error.value = await requestPasswordReset(email.value);
    if (error.value === null) sent.value = true;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="flex min-h-full items-center justify-center p-8">
    <Card class="w-full max-w-sm" data-testid="forgot-password">
      <CardHeader>
        <CardTitle>Reset your password</CardTitle>
        <CardDescription>
          We will email you a link that lets you choose a new one.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <!--
          Announced rather than merely rendered: the form it replaces is gone,
          so a screen reader would otherwise be told nothing at all happened.
        -->
        <div v-if="sent" class="flex flex-col gap-4" role="status" data-testid="reset-requested">
          <p class="text-sm">
            If <strong>{{ email }}</strong> has an Ambitime account, a link is on its way. It works
            once, and for an hour.
          </p>
          <p class="text-muted-foreground text-sm">
            Nothing arrived? Check the spam folder, then
            <button
              type="button"
              class="underline underline-offset-4"
              data-testid="reset-again"
              @click="sent = false"
            >
              try a different address</button
            >.
          </p>
          <Button as-child variant="outline">
            <RouterLink to="/sign-in">Back to sign in</RouterLink>
          </Button>
        </div>

        <form v-else class="flex flex-col gap-4" @submit.prevent="submit">
          <div class="flex flex-col gap-1.5">
            <label class="text-sm font-medium" for="email">Email</label>
            <input
              id="email"
              v-model="email"
              type="email"
              autocomplete="username"
              required
              class="border-input bg-background rounded-md border px-3 py-2 text-sm"
              data-testid="forgot-email"
            />
          </div>

          <p v-if="error" class="text-destructive text-sm" role="alert" data-testid="forgot-error">
            {{ error }}
          </p>

          <Button type="submit" :disabled="busy" data-testid="forgot-submit">
            {{ busy ? 'Sending…' : 'Email me a link' }}
          </Button>

          <p class="text-muted-foreground text-center text-sm">
            Remembered it?
            <RouterLink
              class="underline underline-offset-4"
              to="/sign-in"
              data-testid="back-to-sign-in"
            >
              Sign in
            </RouterLink>
          </p>
        </form>
      </CardContent>
    </Card>
  </main>
</template>

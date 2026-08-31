<script setup lang="ts">
import { computed, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { MINIMUM_PASSWORD_LENGTH, signUp } from '@/lib/session';

/**
 * Creating an account (spec §10.1).
 *
 * A route of its own rather than a mode on the sign-in form, so it can be
 * linked to and so `?next=` survives the round trip the same way — somebody
 * sent to a page while signed out should land back on it whichever door they
 * came through.
 *
 * The account it makes is complete: M1's triggers give it a personal tenant,
 * an owner membership and a primary email identity, and Better Auth signs it
 * in. What it does *not* have is a calendar, which is why the schedule offers
 * to make the first one (§4.3 leaves that to the user, since they may want
 * several).
 */
const router = useRouter();
const route = useRoute();

const displayName = ref('');
const email = ref('');
const password = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

const next = computed(() => (typeof route.query['next'] === 'string' ? route.query['next'] : '/'));

/** Checked here so the form can refuse before a round trip that would too. */
const tooShort = computed(
  () => password.value.length > 0 && password.value.length < MINIMUM_PASSWORD_LENGTH,
);

async function submit() {
  // A disabled button stops a click, not a form. Pressing Enter in the password
  // field submits regardless, so the guard belongs here rather than only on the
  // control.
  if (tooShort.value) return;

  busy.value = true;
  error.value = null;

  try {
    error.value = await signUp(email.value, password.value, displayName.value.trim());
    if (error.value === null) await router.replace(next.value);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="flex min-h-full items-center justify-center p-8">
    <Card class="w-full max-w-sm" data-testid="sign-up">
      <CardHeader>
        <CardTitle>Create an account</CardTitle>
        <CardDescription>Ambitime schedules your work into the time you have.</CardDescription>
      </CardHeader>

      <CardContent>
        <form class="flex flex-col gap-4" @submit.prevent="submit">
          <div class="flex flex-col gap-1.5">
            <label class="text-sm font-medium" for="name">Name</label>
            <input
              id="name"
              v-model="displayName"
              type="text"
              autocomplete="name"
              class="border-input bg-background rounded-md border px-3 py-2 text-sm"
              data-testid="sign-up-name"
            />
            <p class="text-muted-foreground text-xs">Optional. It is what colleagues will see.</p>
          </div>

          <div class="flex flex-col gap-1.5">
            <label class="text-sm font-medium" for="email">Email</label>
            <input
              id="email"
              v-model="email"
              type="email"
              autocomplete="username"
              required
              class="border-input bg-background rounded-md border px-3 py-2 text-sm"
              data-testid="sign-up-email"
            />
          </div>

          <div class="flex flex-col gap-1.5">
            <label class="text-sm font-medium" for="password">Password</label>
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
              data-testid="sign-up-password"
            />
            <!-- Said before it is typed, not after it is rejected. -->
            <p
              id="password-hint"
              class="text-xs"
              :class="tooShort ? 'text-destructive' : 'text-muted-foreground'"
              data-testid="password-hint"
            >
              At least {{ MINIMUM_PASSWORD_LENGTH }} characters.
            </p>
          </div>

          <p v-if="error" class="text-destructive text-sm" role="alert" data-testid="sign-up-error">
            {{ error }}
          </p>

          <Button type="submit" :disabled="busy || tooShort" data-testid="sign-up-submit">
            {{ busy ? 'Creating your account…' : 'Create account' }}
          </Button>

          <p class="text-muted-foreground text-center text-sm">
            Already have one?
            <RouterLink
              class="underline underline-offset-4"
              :to="{ name: 'sign-in', query: route.query }"
              data-testid="to-sign-in"
            >
              Sign in
            </RouterLink>
          </p>
        </form>
      </CardContent>
    </Card>
  </main>
</template>

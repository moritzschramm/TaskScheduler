<script setup lang="ts">
import { ref } from 'vue';
import { useI18n } from '@/i18n';
import { useRoute, useRouter } from 'vue-router';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { signIn } from '@/lib/session';

const { t } = useI18n();

const router = useRouter();
const route = useRoute();

const email = ref('');
const password = ref('');
const error = ref<string | null>(null);
const busy = ref(false);

async function submit() {
  busy.value = true;
  error.value = null;

  try {
    error.value = await signIn(email.value, password.value);
    if (error.value === null) {
      const next = typeof route.query['next'] === 'string' ? route.query['next'] : '/';
      await router.replace(next);
    }
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="flex min-h-full items-center justify-center p-8">
    <Card class="w-full max-w-sm" data-testid="sign-in">
      <CardHeader>
        <CardTitle>{{ t('auth.signInTitle') }}</CardTitle>
        <CardDescription>{{ t('auth.tagline') }}</CardDescription>
      </CardHeader>

      <CardContent>
        <form class="flex flex-col gap-4" @submit.prevent="submit">
          <div class="flex flex-col gap-1.5">
            <label class="text-sm font-medium" for="email">{{ t('auth.email') }}</label>
            <input
              id="email"
              v-model="email"
              type="email"
              autocomplete="username"
              required
              class="border-input bg-background rounded-md border px-3 py-2 text-sm"
            />
          </div>

          <div class="flex flex-col gap-1.5">
            <div class="flex items-baseline justify-between gap-2">
              <label class="text-sm font-medium" for="password">{{ t('auth.password') }}</label>
              <!--
                Beside the field it is about, and visible before the attempt
                fails. Somebody who has forgotten a password does not learn it
                by being told the pair did not match.
              -->
              <RouterLink
                class="text-muted-foreground hover:text-foreground text-xs underline underline-offset-4"
                to="/forgot-password"
                data-testid="to-forgot-password"
              >
                {{ t('auth.forgot') }}
              </RouterLink>
            </div>
            <input
              id="password"
              v-model="password"
              type="password"
              autocomplete="current-password"
              required
              class="border-input bg-background rounded-md border px-3 py-2 text-sm"
            />
          </div>

          <p v-if="error" class="text-destructive text-sm" data-testid="sign-in-error">
            {{ error }}
          </p>

          <Button type="submit" :disabled="busy">
            {{ busy ? 'Signing in…' : 'Sign in' }}
          </Button>

          <p class="text-muted-foreground text-center text-sm">
            {{ t('auth.noAccount') }}
            <RouterLink
              class="underline underline-offset-4"
              :to="{ name: 'sign-up', query: route.query }"
              data-testid="to-sign-up"
            >
              {{ t('auth.createOne') }}
            </RouterLink>
          </p>
        </form>
      </CardContent>
    </Card>
  </main>
</template>

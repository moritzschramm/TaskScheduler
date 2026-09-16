<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  ASSISTANT_PROVIDERS,
  DEFAULT_ASSISTANT_MODEL,
  type AssistantProvider,
} from '@ambitime/shared';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { ApiError, api, expectOk } from '@/lib/api';
import { loadSession, session } from '@/lib/session';
import { resetAssistant } from '@/lib/assistant';

const { t } = useI18n();

/**
 * Where the key for §2.2's assistant is entered.
 *
 * **Not a command, alone on this page.** Every other control here writes
 * through the command layer (§3.2), and this one deliberately does not: the log
 * is append-only with UPDATE and DELETE revoked, so a secret journalled into it
 * could never be removed — not by clearing this field, not by rotating the key
 * at the provider. Credentials were already outside the command layer in this
 * application; a password reaches the database through Better Auth (§10.1).
 * Migration 0019 carries the long version of the argument.
 *
 * **One-way.** What comes back is the provider, the model and the last four
 * characters. There is no read endpoint for the key and no field that could be
 * populated with it — replacing it means pasting a new one, which is how every
 * provider's own console works and for the same reason.
 */

const provider = ref<AssistantProvider>('anthropic');
const apiKey = ref('');
const model = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

const stored = computed(() => session.value?.assistant ?? null);
const defaultModel = computed(() => DEFAULT_ASSISTANT_MODEL[provider.value]);

async function save(): Promise<void> {
  if (apiKey.value.trim() === '') return;

  busy.value = true;
  error.value = null;

  try {
    const response = await api.api.assistant.credentials.$put({
      json: {
        provider: provider.value,
        apiKey: apiKey.value,
        ...(model.value.trim() === '' ? {} : { model: model.value.trim() }),
      },
    });

    await expectOk(response);
    // Cleared the moment it lands: a key left sitting in a field is a key in a
    // password manager's next autofill and in the next screenshot.
    apiKey.value = '';
    model.value = '';
    await loadSession();
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : t('errors.setup');
  } finally {
    busy.value = false;
  }
}

async function remove(): Promise<void> {
  busy.value = true;
  error.value = null;

  try {
    await expectOk(await api.api.assistant.credentials.$delete());
    await loadSession();
    // The conversation goes with it. It was reasoning about this person's week
    // through a key they have just taken back.
    resetAssistant();
  } catch (cause) {
    error.value = cause instanceof ApiError ? cause.message : t('errors.setup');
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section class="space-y-4" data-testid="assistant-section">
    <header>
      <h2 class="text-lg font-semibold">{{ t('settings.assistantTitle') }}</h2>
      <p class="text-muted-foreground max-w-prose text-sm">{{ t('settings.assistantLead') }}</p>
    </header>

    <p v-if="error" class="text-destructive text-sm" role="alert" data-testid="assistant-error">
      {{ error }}
    </p>

    <p class="text-sm" data-testid="assistant-state">
      <template v-if="stored">
        {{ t('settings.assistantSaved', { hint: stored.hint, model: stored.model }) }}
      </template>
      <template v-else>{{ t('settings.assistantNone') }}</template>
    </p>

    <div class="grid max-w-2xl gap-4 sm:grid-cols-2">
      <div class="space-y-1">
        <Label for="assistant-provider">{{ t('settings.assistantProvider') }}</Label>
        <Select id="assistant-provider" v-model="provider" data-testid="assistant-provider">
          <option v-for="name in ASSISTANT_PROVIDERS" :key="name" :value="name">
            {{ name === 'anthropic' ? 'Anthropic (Claude)' : 'OpenAI' }}
          </option>
        </Select>
      </div>

      <div class="space-y-1">
        <Label for="assistant-model">{{ t('settings.assistantModel') }}</Label>
        <Input
          id="assistant-model"
          v-model="model"
          :placeholder="defaultModel"
          data-testid="assistant-model"
        />
        <p class="text-muted-foreground text-xs">
          {{ t('settings.assistantModelHint', { model: defaultModel }) }}
        </p>
      </div>

      <div class="space-y-1 sm:col-span-2">
        <Label for="assistant-key">{{ t('settings.assistantKey') }}</Label>
        <Input
          id="assistant-key"
          v-model="apiKey"
          type="password"
          autocomplete="off"
          placeholder="sk-…"
          data-testid="assistant-key"
        />
        <p class="text-muted-foreground text-xs">{{ t('settings.assistantKeyHint') }}</p>
      </div>
    </div>

    <div class="flex items-center gap-2">
      <Button :disabled="busy || apiKey.trim() === ''" data-testid="assistant-save" @click="save">
        {{ t('settings.assistantSave') }}
      </Button>
      <Button
        v-if="stored"
        variant="ghost"
        :disabled="busy"
        data-testid="assistant-remove"
        @click="remove"
      >
        {{ t('settings.assistantRemove') }}
      </Button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { nextTick, ref, watch } from 'vue';
import { RotateCcw, Send, X } from 'lucide-vue-next';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import AssistantPlan from '@/components/assistant/AssistantPlan.vue';
import { useAssistant } from '@/lib/assistant';

const { t } = useI18n();
const { messages, open, busy, error, configured, send, apply, decline, undoPlan, reset } =
  useAssistant();

/**
 * The conversation (spec §2.2).
 *
 * **Not a modal.** A Reka `Dialog` would trap focus and cover the page, and the
 * one thing somebody wants to watch while an assistant rearranges their week is
 * the week. So: a panel with the right ARIA, closable on Escape, and the
 * calendar live behind it.
 *
 * **Enter sends; Shift+Enter is a newline.** The textarea grows to a few lines
 * and stops. Almost everything typed here is one sentence, and a Send button
 * somebody has to reach for after every one of them is a gesture too many.
 */

const draft = ref('');
const composer = ref<HTMLTextAreaElement | null>(null);
const log = ref<HTMLElement | null>(null);

// New messages arrive at the bottom, which is where the eye already is.
watch(
  () => messages.value.length,
  async () => {
    await nextTick();
    if (log.value !== null) log.value.scrollTop = log.value.scrollHeight;
  },
);

watch(open, async (isOpen) => {
  if (!isOpen) return;
  await nextTick();
  composer.value?.focus();
});

async function submit(): Promise<void> {
  const text = draft.value;
  // Cleared before the request, not after: the answer takes seconds, and a
  // field that stays full for all of them invites a second press.
  draft.value = '';
  await send(text);
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Enter' || event.shiftKey) return;
  event.preventDefault();
  void submit();
}
</script>

<template>
  <section
    id="assistant-panel"
    class="bg-background fixed right-6 bottom-24 z-50 flex h-[32rem] max-h-[calc(100vh-8rem)] w-[26rem] max-w-[calc(100vw-3rem)] flex-col rounded-lg border shadow-xl"
    role="dialog"
    :aria-label="t('assistant.title')"
    data-testid="assistant-panel"
    @keydown.escape="open = false"
  >
    <!--
      A `div`, not a `header`. HTML maps a `header` to the `banner` role unless
      it sits inside a sectioning *element*, and `role="dialog"` is not one of
      them — so a `header` here becomes a second banner on a page that already
      has the shell's, which is a real violation and not merely an axe rule.
    -->
    <div class="flex shrink-0 items-center justify-between gap-2 border-b px-4 py-2.5">
      <h2 class="text-sm font-semibold">{{ t('assistant.title') }}</h2>
      <div class="flex items-center gap-1">
        <button
          v-if="messages.length > 0"
          class="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-md p-1.5 focus-visible:ring-2 focus-visible:outline-none"
          :title="t('assistant.reset')"
          :aria-label="t('assistant.reset')"
          data-testid="assistant-reset"
          @click="reset"
        >
          <RotateCcw class="size-4" aria-hidden="true" />
        </button>
        <button
          class="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded-md p-1.5 focus-visible:ring-2 focus-visible:outline-none"
          :aria-label="t('assistant.close')"
          data-testid="assistant-close"
          @click="open = false"
        >
          <X class="size-4" aria-hidden="true" />
        </button>
      </div>
    </div>

    <!--
      `aria-live="polite"`: an answer arriving is worth announcing, and worth
      not interrupting whatever is being read to say so.
    -->
    <div
      ref="log"
      class="flex-1 space-y-3 overflow-y-auto px-4 py-3"
      aria-live="polite"
      data-testid="assistant-log"
    >
      <p v-if="messages.length === 0" class="text-muted-foreground text-sm">
        {{ t('assistant.lead') }}
      </p>

      <div v-for="message in messages" :key="message.id">
        <p
          v-if="message.kind === 'user'"
          class="bg-secondary text-secondary-foreground ml-8 rounded-lg px-3 py-2 text-sm whitespace-pre-wrap"
          data-testid="assistant-user-message"
        >
          {{ message.text }}
        </p>

        <p
          v-else-if="message.kind === 'notice'"
          class="text-muted-foreground text-xs italic"
          data-testid="assistant-notice"
        >
          {{ message.text }}
        </p>

        <div v-else data-testid="assistant-reply">
          <p v-if="message.text !== ''" class="text-sm whitespace-pre-wrap">{{ message.text }}</p>

          <AssistantPlan
            v-if="message.plan"
            :plan="message.plan"
            :busy="busy"
            @apply="apply(message.plan)"
            @discard="decline(message.plan)"
            @undo="undoPlan(message.plan)"
          />
        </div>
      </div>

      <p v-if="busy" class="text-muted-foreground text-sm" data-testid="assistant-busy">
        {{ t('assistant.thinking') }}
      </p>

      <p v-if="error" class="text-destructive text-sm" role="alert" data-testid="assistant-error">
        {{ error }}
      </p>
    </div>

    <!--
      A key is what makes this a chat rather than a button that fails. Said here
      rather than by hiding the launcher, so somebody who has heard the feature
      exists finds out where to switch it on.
    -->
    <div v-if="!configured" class="shrink-0 border-t px-4 py-3 text-sm" data-testid="assistant-off">
      <p class="text-muted-foreground">{{ t('assistant.disabled') }}</p>
      <RouterLink class="underline underline-offset-4" to="/settings" @click="open = false">
        {{ t('assistant.disabledLink') }}
      </RouterLink>
    </div>

    <form v-else class="flex shrink-0 items-end gap-2 border-t p-3" @submit.prevent="submit">
      <label class="sr-only" for="assistant-input">{{ t('assistant.title') }}</label>
      <textarea
        id="assistant-input"
        ref="composer"
        v-model="draft"
        class="border-input bg-background focus-visible:ring-ring max-h-24 min-h-9 flex-1 resize-none rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none"
        rows="1"
        :placeholder="t('assistant.placeholder')"
        data-testid="assistant-input"
        @keydown="onKeydown"
      ></textarea>

      <Button
        type="submit"
        size="icon"
        :disabled="busy || draft.trim() === ''"
        :aria-label="t('assistant.send')"
        data-testid="assistant-send"
      >
        <Send class="size-4" aria-hidden="true" />
      </Button>
    </form>
  </section>
</template>

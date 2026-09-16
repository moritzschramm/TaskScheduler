<script setup lang="ts">
import { onMounted } from 'vue';
import { MessageCircle, X } from 'lucide-vue-next';
import { useI18n } from '@/i18n';
import AssistantPanel from '@/components/assistant/AssistantPanel.vue';
import { restoreAssistant, useAssistant } from '@/lib/assistant';
import { session } from '@/lib/session';

const { t } = useI18n();
const { open, toggle } = useAssistant();

/**
 * The button the assistant lives behind (spec §2.2).
 *
 * Mounted in the shell rather than in a view, which is what "stays in place"
 * means here: `AppShell` wraps the router outlet, so moving between Schedule,
 * Tasks and Activity types never unmounts this and never interrupts a
 * conversation halfway through. The `fixed` positioning is the other half — the
 * panel sits against the viewport, not inside the one element on the page that
 * scrolls.
 *
 * Present even with no key configured. The panel says how to switch it on; a
 * launcher that appeared only once somebody had already found the setting would
 * be a feature nobody discovers.
 */

// A reload in the middle of a sentence should not cost the conversation; a
// conversation left alone for half an hour should (see `ASSISTANT_IDLE_RESET_MS`).
onMounted(restoreAssistant);
</script>

<template>
  <template v-if="session">
    <AssistantPanel v-if="open" />

    <button
      class="bg-primary text-primary-foreground focus-visible:ring-ring fixed right-6 bottom-6 z-50 flex size-12 items-center justify-center rounded-full shadow-lg transition-transform hover:scale-105 focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
      :aria-label="open ? t('assistant.close') : t('assistant.open')"
      :aria-expanded="open"
      aria-controls="assistant-panel"
      :title="open ? t('assistant.close') : t('assistant.open')"
      data-testid="assistant-launcher"
      @click="toggle"
    >
      <X v-if="open" class="size-5" aria-hidden="true" />
      <MessageCircle v-else class="size-5" aria-hidden="true" />
    </button>
  </template>
</template>

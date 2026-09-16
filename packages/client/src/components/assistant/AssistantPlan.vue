<script setup lang="ts">
import { computed } from 'vue';
import { AlertTriangle, Check } from 'lucide-vue-next';
import { useI18n } from '@/i18n';
import { Button } from '@/components/ui/button';
import type { PlanView } from '@/lib/assistant';

const { t } = useI18n();

/**
 * What the assistant would like to do, before it has done it (spec §2.2).
 *
 * The card is the gate. Every line in it is rendered from the command that
 * would be sent — not from the model's description of it — so pressing Apply
 * agrees to what is actually about to happen. See `lib/proposals.ts`.
 *
 * A line that cannot run is shown rather than quietly dropped. A plan of three
 * where one is malformed is a plan somebody should look at twice, and hiding
 * the broken one would make "apply" mean something different from what the list
 * says.
 */
const props = defineProps<{ plan: PlanView; busy: boolean }>();

const emit = defineEmits<{ apply: []; discard: []; undo: [] }>();

const runnable = computed(() => props.plan.proposals.filter((p) => p.request !== null).length);
</script>

<template>
  <div class="bg-muted/40 mt-2 rounded-md border p-3" data-testid="assistant-plan">
    <p class="text-muted-foreground mb-2 text-xs font-medium tracking-wide uppercase">
      {{ t('assistant.plan.heading') }}
    </p>

    <ol class="space-y-2">
      <li
        v-for="(proposal, index) in plan.proposals"
        :key="proposal.call.id"
        class="text-sm"
        :data-testid="`plan-step-${index}`"
      >
        <p :class="proposal.problem === null ? '' : 'text-muted-foreground line-through'">
          {{ proposal.headline }}
        </p>

        <ul v-if="proposal.details.length > 0" class="text-muted-foreground mt-0.5 text-xs">
          <li v-for="detail in proposal.details" :key="detail">{{ detail }}</li>
        </ul>

        <!--
          The validator's own words, not a paraphrase. Somebody reading this is
          deciding whether to re-ask, and "estimatedDurationMin must be a
          positive integer" tells them what to say next.
        -->
        <p
          v-if="proposal.problem !== null"
          class="text-destructive mt-0.5 flex items-start gap-1 text-xs"
          data-testid="plan-step-problem"
        >
          <AlertTriangle class="mt-0.5 size-3 shrink-0" aria-hidden="true" />
          <span>{{ t('assistant.plan.willNotRun') }} — {{ proposal.problem }}</span>
        </p>
      </li>
    </ol>

    <div class="mt-3 flex items-center gap-2">
      <template v-if="plan.state === 'pending'">
        <Button
          size="sm"
          :disabled="busy || runnable === 0"
          data-testid="plan-apply"
          @click="emit('apply')"
        >
          {{ t('assistant.plan.apply') }}
        </Button>
        <Button size="sm" variant="ghost" data-testid="plan-discard" @click="emit('discard')">
          {{ t('assistant.plan.discard') }}
        </Button>
      </template>

      <p v-else-if="plan.state === 'applying'" class="text-muted-foreground text-xs">
        {{ t('assistant.plan.applying') }}
      </p>

      <template v-else>
        <p class="text-muted-foreground flex items-center gap-1 text-xs" data-testid="plan-state">
          <Check v-if="plan.state === 'applied'" class="size-3" aria-hidden="true" />
          {{
            plan.state === 'applied'
              ? t('assistant.plan.applied')
              : plan.state === 'declined'
                ? t('assistant.plan.declined')
                : t('assistant.plan.partly')
          }}
        </p>

        <!--
          One press, for the whole plan. Every command in it went out under one
          `groupId`, and §7.5 folds a group into a single unit of history — which
          is what makes "if it gets it wrong, undo it" a true sentence rather
          than one that only covers the last line.
        -->
        <Button
          v-if="plan.undoable"
          size="sm"
          variant="ghost"
          :disabled="busy"
          data-testid="plan-undo"
          @click="emit('undo')"
        >
          {{ t('assistant.plan.undo') }}
        </Button>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '@/i18n';
import { Label } from '@/components/ui/label';

const { t } = useI18n();

/**
 * One inheritable property of spec §4.4, in all three of its states.
 *
 * Priority, due date, preferred range, focus, category and cooldown may be set
 * on any node and are inherited by descendants, nearest ancestor wins. So a
 * property is in exactly one of three states, and a form offering only a value
 * box could express two of them:
 *
 * - **set here** — an override; this task's own value.
 * - **inherited** — no own value; an ancestor supplies one, shown but not
 *   editable here, because editing it here is what "set here" means.
 * - **unset** — no own value, and no ancestor has one either.
 *
 * The toggle is the override itself. Turning it off is the "clearing reverts to
 * inherited" half of §4.4, and it is the half a plain form cannot do at all:
 * with only a value box, a property that has been overridden once can never be
 * un-overridden, because there is no way to say "nothing" that is
 * distinguishable from "empty".
 *
 * It was a switch labelled "Set here", which named the *state* it would put the
 * field in and left the reader to work out which way it was pointing. A button
 * labelled with what pressing it does needs no such inference — and it can say
 * "Use inherited" or "Clear" as appropriate, which one switch label could not.
 */
const props = defineProps<{
  /**
   * Which field this is, for the test id.
   *
   * Separate from `label` because the label is translated: deriving the id from
   * it made `field-priority` become `field-priorität` the moment the interface
   * was German, so every selector that named a field was quietly
   * language-dependent.
   */
  field: string;
  label: string;
  /** What an ancestor supplies, ready to display. `null` when none does. */
  inherited?: string | null;
  hint?: string;
  disabled?: boolean;
}>();

const overridden = defineModel<boolean>('overridden', { required: true });

const action = computed(() => {
  if (!overridden.value) return t('editor.setValue');
  return props.inherited === null || props.inherited === undefined
    ? t('common.clear')
    : t('editor.useInherited');
});
</script>

<template>
  <div class="space-y-1.5" :data-testid="`field-${field}`">
    <div class="flex items-center justify-between gap-3">
      <Label>{{ label }}</Label>
      <button
        type="button"
        class="text-muted-foreground hover:text-foreground focus-visible:ring-ring rounded text-xs underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-none"
        :disabled="disabled"
        :aria-pressed="overridden"
        :aria-label="`${action} for ${label}`"
        data-testid="override-toggle"
        @click="overridden = !overridden"
      >
        {{ action }}
      </button>
    </div>

    <slot v-if="overridden" />

    <p v-else class="text-muted-foreground text-sm" data-testid="inherited-value">
      <template v-if="inherited !== null && inherited !== undefined">
        <span class="italic">{{ t('editor.inheritedValue', { value: String(inherited) }) }}</span>
      </template>
      <template v-else>{{ t('common.notSet') }}</template>
    </p>

    <p v-if="hint" class="text-muted-foreground text-xs">{{ hint }}</p>
  </div>
</template>

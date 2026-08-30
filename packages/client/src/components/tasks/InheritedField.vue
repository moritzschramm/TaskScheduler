<script setup lang="ts">
import { computed } from 'vue';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

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
 * The switch is the override itself. Turning it off is the "clearing reverts to
 * inherited" half of §4.4, and it is the half a plain form cannot do at all:
 * with only a value box, a property that has been overridden once can never be
 * un-overridden, because there is no way to say "nothing" that is
 * distinguishable from "empty".
 */
const props = defineProps<{
  label: string;
  /** What an ancestor supplies, ready to display. `null` when none does. */
  inherited?: string | null;
  hint?: string;
  disabled?: boolean;
}>();

const overridden = defineModel<boolean>('overridden', { required: true });

const slug = computed(() => props.label.toLowerCase().replace(/\s+/g, '-'));
</script>

<template>
  <div class="space-y-1.5" :data-testid="`field-${slug}`">
    <div class="flex items-center justify-between gap-3">
      <Label>{{ label }}</Label>
      <label class="text-muted-foreground flex items-center gap-2 text-xs">
        <span>Set here</span>
        <Switch
          v-model="overridden"
          :disabled="disabled"
          :aria-label="`Set ${label} on this task`"
          data-testid="override-toggle"
        />
      </label>
    </div>

    <slot v-if="overridden" />

    <p v-else class="text-muted-foreground text-sm" data-testid="inherited-value">
      <template v-if="inherited !== null && inherited !== undefined">
        Inherited: <span class="italic">{{ inherited }}</span>
      </template>
      <template v-else>Not set</template>
    </p>

    <p v-if="hint" class="text-muted-foreground text-xs">{{ hint }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, type HTMLAttributes } from 'vue';
import { SwitchRoot, SwitchThumb } from 'reka-ui';
import { cn } from '@/lib/utils';

/**
 * Reka's switch rather than a checkbox: this one earns the dependency. It
 * carries `role="switch"`, the checked state and keyboard activation, which is
 * what a screen reader needs to announce "on/off" rather than "checked" (§14).
 *
 * `aria-label` and friends are left to attribute fallthrough, and `id` is
 * assembled conditionally: under `exactOptionalPropertyTypes` an optional prop
 * bound as `:id="undefined"` is a type error, not an omission.
 */
const props = defineProps<{
  id?: string;
  disabled?: boolean;
  class?: HTMLAttributes['class'];
}>();

const model = defineModel<boolean>({ default: false });

const rootProps = computed(() => ({
  disabled: props.disabled ?? false,
  ...(props.id === undefined ? {} : { id: props.id }),
}));
</script>

<template>
  <SwitchRoot
    v-model="model"
    v-bind="rootProps"
    data-slot="switch"
    :class="
      cn(
        'peer focus-visible:ring-ring data-[state=checked]:bg-primary data-[state=unchecked]:bg-input inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        props.class,
      )
    "
  >
    <SwitchThumb
      class="bg-background pointer-events-none block h-4 w-4 rounded-full shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-4 data-[state=unchecked]:translate-x-0"
    />
  </SwitchRoot>
</template>

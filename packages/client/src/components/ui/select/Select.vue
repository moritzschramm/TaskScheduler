<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';

/**
 * A styled native `<select>`, deliberately not Reka's listbox.
 *
 * Spec §14 targets WCAG 2.2 AA, and a native select is the most accessible
 * control on the platform: it comes with keyboard interaction, screen-reader
 * semantics, type-ahead and the operating system's own picker on touch, none of
 * which a custom popover gets for free. The settings screen has no requirement
 * — no rich option content, no multi-select, no async search — that would repay
 * giving those up.
 */
const props = defineProps<{ class?: HTMLAttributes['class'] }>();
const model = defineModel<string>();
</script>

<template>
  <select
    v-model="model"
    data-slot="select"
    :class="
      cn(
        'border-input bg-background ring-offset-background focus-visible:ring-ring h-9 w-full rounded-md border px-3 py-1 text-sm shadow-xs transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        props.class,
      )
    "
  >
    <slot />
  </select>
</template>

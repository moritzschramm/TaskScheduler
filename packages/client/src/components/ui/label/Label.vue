<script setup lang="ts">
import type { HTMLAttributes } from 'vue';
import { cn } from '@/lib/utils';

/**
 * A native `<label>`. Reka's adds only double-click text-selection suppression,
 * which is not worth a wrapper — and every form control on this screen is a
 * native one, so the native association is exactly what assistive technology
 * expects (spec §14).
 */
const props = defineProps<{ for?: string; class?: HTMLAttributes['class'] }>();
</script>

<template>
  <label
    data-slot="label"
    :for="props.for"
    :class="cn('flex items-center gap-2 text-sm leading-none font-medium select-none', props.class)"
  >
    <slot />
  </label>
</template>

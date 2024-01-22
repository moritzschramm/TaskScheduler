<script setup lang="ts">
import { type Error } from '@/error'

const props = defineProps<{
  error: Error
}>()
</script>

<template>
  <p v-show="props.error.err" class="text-red-600 text-sm my-2">
    {{ props.error.err }}
  </p>
</template>

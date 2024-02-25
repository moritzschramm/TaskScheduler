<script setup lang="ts">
const props = defineProps<{
  disabled?: boolean
  loading?: boolean
}>()
</script>

<template>
  <button
    type="button"
    :disabled="props.disabled || props.loading"
    class="inline-flex items-center justify-center my-2 bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600 focus:outline-none focus:bg-blue-600 disabled:bg-blue-400"
  >
    <slot />

    <svg
      v-show="props.loading"
      class="animate-spin -mr-1 ml-3 h-5 w-5 text-white"
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
    >
      <circle
        class="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        stroke-width="4"
      ></circle>
      <path
        class="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      ></path>
    </svg>
  </button>
</template>

<script setup lang="ts">
const props = defineProps(['step'])
</script>

<template>
  <div class="flex items-center h-6 bg-gray-50">
    <div
      v-if="step < 2"
      class="flex-none w-6 h-6 rounded-full bg-inherit border border-blue-500 text-blue-500 text-center pt-px text-sm"
    >
      1
    </div>
    <svg
      v-else
      class="flex-none w-8 h-8 text-blue-500 bg-inherit"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      viewBox="0 0 20 20"
    >
      <path
        d="M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5Zm3.707 8.207-4 4a1 1 0 0 1-1.414 0l-2-2a1 1 0 0 1 1.414-1.414L9 10.586l3.293-3.293a1 1 0 0 1 1.414 1.414Z"
      />
    </svg>

    <div
      class="grow h-px"
      :class="{ 'bg-blue-500': props.step > 1, 'bg-gray-300': props.step === 1 }"
    ></div>

    <div
      v-if="step < 3"
      class="flex-none w-6 h-6 rounded-full bg-inherit border text-center pt-px text-sm"
      :class="{
        'border-blue-500 text-blue-500': props.step > 1,
        'border-gray-300 text-gray-300': props.step === 1
      }"
    >
      2
    </div>
    <svg
      v-else
      class="flex-none w-8 h-8 text-blue-500 bg-inherit"
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
      fill="currentColor"
      viewBox="0 0 20 20"
    >
      <path
        d="M10 .5a9.5 9.5 0 1 0 9.5 9.5A9.51 9.51 0 0 0 10 .5Zm3.707 8.207-4 4a1 1 0 0 1-1.414 0l-2-2a1 1 0 0 1 1.414-1.414L9 10.586l3.293-3.293a1 1 0 0 1 1.414 1.414Z"
      />
    </svg>

    <div
      class="grow h-px"
      :class="{ 'bg-blue-500': props.step === 3, 'bg-gray-300': props.step < 3 }"
    ></div>

    <div
      class="flex-none w-6 h-6 rounded-full bg-inherit border text-center pt-px text-sm"
      :class="{
        'border-blue-500 text-blue-500': props.step === 3,
        'border-gray-300 text-gray-300': props.step < 3
      }"
    >
      3
    </div>
  </div>
</template>

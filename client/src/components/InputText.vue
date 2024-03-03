<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { type Error } from '@/error'

const props = defineProps<{
  name: string
  label: string
  type: string
  error?: Error
  focus?: boolean
}>()

defineEmits(['enterPressed'])

const inputRef = ref<HTMLInputElement | null>(null)
const content = defineModel()

onMounted(() => {
  if (props.focus) {
    inputRef.value?.focus()
  }
})
</script>

<template>
  <div class="my-2">
    <label :for="props.name" class="block text-gray-600 text-sm font-medium mb-2">{{
      props.label
    }}</label>
    <input
      ref="inputRef"
      @keyup.enter="$emit('enterPressed')"
      v-model="content"
      :type="props.type"
      :id="props.name"
      :name="props.name"
      class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
    />
  </div>

  <p v-show="props.error && props.error[props.name]" class="text-red-600 text-sm my-2">
    {{ props.error![props.name] }}
  </p>
</template>

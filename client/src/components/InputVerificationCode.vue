<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { type Error } from '@/error'

const props = defineProps<{
  name: string
  label: string
  error?: Error
  focused?: boolean
}>()

defineEmits(['enterPressed'])

const inputRef0 = ref<HTMLInputElement | null>(null)
const inputRef1 = ref<HTMLInputElement | null>(null)
const inputRef2 = ref<HTMLInputElement | null>(null)
const inputRef3 = ref<HTMLInputElement | null>(null)
const inputRef4 = ref<HTMLInputElement | null>(null)
const inputRef5 = ref<HTMLInputElement | null>(null)
const content = defineModel()

onMounted(() => {
  if (props.focused) {
    inputRef0.value?.focus()
  }
})
</script>

<template>
  <div class="my-2">
    <label :for="props.name" class="block text-gray-600 text-sm font-medium mb-2">{{
      props.label
    }}</label>
    <div class="flex justify-center">
      <input
        ref="inputRef0"
        v-model="content"
        type="text"
        :id="props.name"
        :name="props.name"
        class="w-9 px-3 py-2 mx-1 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
      />
      <input
        ref="inputRef1"
        v-model="content"
        type="text"
        :id="props.name"
        :name="props.name"
        class="w-9 px-3 py-2 mx-1 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
      />
      <input
        ref="inputRef2"
        v-model="content"
        type="text"
        :id="props.name"
        :name="props.name"
        class="w-9 px-3 py-2 mx-1 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
      />
      <input
        ref="inputRef3"
        v-model="content"
        type="text"
        :id="props.name"
        :name="props.name"
        class="w-9 px-3 py-2 mx-1 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
      />
      <input
        ref="inputRef4"
        v-model="content"
        type="text"
        :id="props.name"
        :name="props.name"
        class="w-9 px-3 py-2 mx-1 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
      />
      <input
        ref="inputRef5"
        @keyup.enter="$emit('enterPressed')"
        v-model="content"
        type="text"
        :id="props.name"
        :name="props.name"
        class="w-9 px-3 py-2 mx-1 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
      />
    </div>
  </div>

  <p v-show="props.error && props.error[props.name]" class="text-red-600 text-sm my-2">
    {{ props.error![props.name] }}
  </p>
</template>

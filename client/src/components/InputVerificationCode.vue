<script setup lang="ts">
import { ref, type Ref, onMounted, watch } from 'vue'
import { type Error } from '@/error'

const props = defineProps<{
  name: string
  label: string
  error?: Error
  focus?: boolean
}>()
defineEmits(['enterPressed'])
const verificationCode = defineModel()

const amountOfInputs = 6
const indexes: number[] = []
let templateStr = ''
for (let i = 0; i < amountOfInputs; i++) {
  indexes.push(i)
  templateStr += ' '
}
const code = ref(templateStr)

const inputRefs: Ref<HTMLInputElement[]> = ref([])

onMounted(() => {
  if (props.focus) {
    inputRefs.value[0]?.focus()
  }
})

watch(verificationCode, () => {
  const vc = verificationCode.value as string
  if (vc.length === 0) {
    code.value = templateStr
    inputRefs.value[0]?.focus()
  }
})

function input(event: Event, index: number) {
  const inputValue = (event.target as HTMLInputElement).value
    .toUpperCase()
    .substring(0, amountOfInputs - index)

  if (inputValue.length > 0) {
    let currentStr = code.value
    currentStr =
      currentStr.substring(0, index) + inputValue + currentStr.substring(index + inputValue.length)
    code.value = currentStr

    verificationCode.value = code.value.trim()

    if (index + inputValue.length < amountOfInputs) {
      inputRefs.value[index + inputValue.length]?.focus()
    } else {
      inputRefs.value[amountOfInputs - 1]?.focus()
    }
  }
}

function remove(index: number) {
  let currentStr = code.value
  currentStr = currentStr.substring(0, index) + ' ' + currentStr.substring(index + 1)
  code.value = currentStr

  verificationCode.value = code.value.trim()

  if (index - 1 >= 0) {
    inputRefs.value[index - 1]?.focus()
  }
}
</script>

<template>
  <div class="my-2">
    <label :for="props.name" class="block text-gray-600 text-sm font-medium mb-2">{{
      props.label
    }}</label>
    <div class="flex justify-center">
      <input
        v-for="index in indexes"
        :key="props.name + index"
        ref="inputRefs"
        @keyup.enter="$emit('enterPressed')"
        @input="input($event, index)"
        @keyup.delete="remove(index)"
        @focus="($event.target as HTMLInputElement).select()"
        :value="code.charAt(index).trim()"
        type="text"
        :maxlength="amountOfInputs - index"
        :id="props.name + index"
        :name="props.name + index"
        class="w-10 px-3 py-2 mx-1 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
      />
    </div>
  </div>

  <p v-show="props.error && props.error[props.name]" class="text-red-600 text-sm my-2">
    {{ props.error![props.name] }}
  </p>
</template>

<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { inject, reactive, watch } from 'vue'
import { HttpClient } from '@/injectable/http'
import { emptyError } from '@/error'
import InputText from '@/components/InputText.vue'
import GenericError from '@/components/GenericError.vue'

const http = inject(HttpClient)
const route = useRoute()
const sessionStore = useSessionStore()

const form = reactive({
  data: {
    email: sessionStore.user.email ?? '',
    password: ''
  },
  invalid: true,
  error: emptyError
})

watch(
  () => form.data,
  (data) => {
    form.invalid = data.email.length === 0 || data.password.length === 0
  },
  { deep: true }
)

const submit = () => {
  if (form.invalid) {
    return
  }
  http
    ?.post('/auth/login', form.data)
    .then(() => {
      alert('login successful') // TODO
    })
    .catch((error) => {
      form.data.password = ''
      form.error = error.response.data
    })
}
</script>

<template>
  <div class="h-screen flex items-center justify-center">
    <div class="p-8 w-96">
      <h2 class="text-2xl font-semibold mb-6">Login</h2>

      <div
        v-show="route.query.created"
        class="rounded bg-green-200 border-solid border-green-300 border-2 mb-6 p-4 text-green-700"
      >
        Successfully created account!<br />Please login now
      </div>

      <form>
        <InputText
          label="Email"
          name="email"
          type="email"
          :error="form.error"
          :focused="!sessionStore.user.email"
          v-model="form.data.email"
          @enterPressed="submit"
        />

        <InputText
          label="Password"
          name="password"
          type="password"
          :error="form.error"
          :focused="!!sessionStore.user.email"
          v-model="form.data.password"
          @enterPressed="submit"
        />

        <GenericError :error="form.error" />

        <button
          @click="submit"
          :disabled="form.invalid"
          type="button"
          class="my-2 w-full bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600 focus:outline-none focus:bg-blue-600 disabled:bg-blue-400"
        >
          Login
        </button>

        <div v-show="!route.query.created" class="text-center">
          <RouterLink to="/register" class="text-blue-500 hover:text-blue-600"
            >New? Create an account</RouterLink
          >
        </div>
      </form>
    </div>
  </div>
</template>

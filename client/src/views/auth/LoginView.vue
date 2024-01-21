<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { inject, reactive, watch } from 'vue'
import { HttpClient } from '@/injectable/http'
import InputText from '@/components/InputText.vue'

const http = inject(HttpClient)
const route = useRoute()
const sessionStore = useSessionStore()

const form = reactive({
  data: {
    email: sessionStore.user.email ?? '',
    password: '',
  },
  invalid: true,
  error: ''
})

watch(() => form.data, (data) => {
  form.invalid = data.email.length === 0 || data.password.length === 0
})

const submit = () => {
  if (!form.invalid) {
    return
  }
  http
    ?.post('/auth/login', {
      email: form.data.email,
      password: form.data.password
    })
    .then(() => {
      alert('login successful')
    })
    .catch(() => {
      form.data.password = ''
      form.error = 'Email address and password do not match'
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
          :focused="!!sessionStore.user.email"
          v-model="form.data.email"
          @enterPressed="submit"
        />

        <InputText
          label="Password"
          name="password"
          type="password"
          :focused="!!sessionStore.user.email"
          v-model="form.data.password"
          @enterPressed="submit"
        />

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

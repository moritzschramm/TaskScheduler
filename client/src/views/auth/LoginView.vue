<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { inject, onMounted, ref } from 'vue'
import { HttpClient } from '@/injectable/http'

const http = inject(HttpClient)
const route = useRoute()
const sessionStore = useSessionStore()

const error = ref('')
const emailInput = ref<HTMLInputElement | null>(null)
const passwordInput = ref<HTMLInputElement | null>(null)
const email = ref(sessionStore.user.email ?? '')
const password = ref('')

onMounted(() => {
  route.query.created || sessionStore.user.email
    ? passwordInput.value?.focus()
    : emailInput.value?.focus()
})

const submit = () => {
  http
    ?.post('/auth/login', {
      email: email.value,
      password: password.value
    })
    .then(() => {
      alert('login success')
    })
    .catch(() => {
      password.value = ''
      error.value = 'Email address and password do not match'
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
        <div class="mb-4">
          <label for="email" class="block text-gray-600 text-sm font-medium mb-2">Email</label>
          <input
            ref="emailInput"
            v-model="email"
            type="email"
            id="email"
            name="email"
            class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
            required
          />
        </div>

        <div class="mb-4">
          <label for="password" class="block text-gray-600 text-sm font-medium mb-2"
            >Password</label
          >
          <input
            ref="passwordInput"
            v-model="password"
            type="password"
            id="password"
            name="password"
            class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
            required
          />
        </div>

        <p v-show="error" class="text-red-600 text-sm mb-4">
          {{ error }}
        </p>

        <button
          @click="submit"
          type="button"
          class="mb-4 w-full bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600 focus:outline-none focus:bg-blue-600"
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

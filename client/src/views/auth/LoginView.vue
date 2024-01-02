<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { onMounted, ref } from 'vue';

const route = useRoute()
const sessionStore = useSessionStore()

const emailInput = ref<HTMLInputElement | null>(null)
const passwordInput = ref<HTMLInputElement | null>(null)

onMounted(() => {
  route.query.created || sessionStore.user.email ?
    passwordInput.value?.focus() :
    emailInput.value?.focus()
})

const submit = () => {
  alert("Not implemented")
}
</script>

<template>
  <div class="h-screen flex items-center justify-center">
    <div class="p-8 w-96">
      <h2 class="text-2xl font-semibold mb-6">Login</h2>

      <div v-show="route.query.created" class="rounded bg-green-200 border-solid border-green-300 border-2 mb-6 p-4 text-green-700">
        Successfully created account!<br>Please login now
      </div>
      
      <form>
        <div class="mb-4">
          <label for="email" class="block text-gray-600 text-sm font-medium mb-2">Email</label>
          <input ref="emailInput" type="email" id="email" name="email" :value="sessionStore.user.email ?? ''" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500" required>
        </div>
        
        <div class="mb-4">
          <label for="password" class="block text-gray-600 text-sm font-medium mb-2">Password</label>
          <input ref="passwordInput" type="password" id="password" name="password" class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500" required>
        </div>
        
        <button @click="submit" type="button" class="mb-4 w-full bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600 focus:outline-none focus:bg-blue-600">Login</button>
      
        <div v-show="!route.query.created" class="text-center">
          <RouterLink to="/register" class="text-blue-500 hover:text-blue-600">New? Create an account</RouterLink>
        </div>
      </form>
    </div>
  </div>
</template>
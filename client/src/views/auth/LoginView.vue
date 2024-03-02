<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'
import { useSessionStore } from '@/stores/sessionStore'
import { inject, reactive, watch } from 'vue'
import { HttpClient } from '@/injectable/http'
import { emptyError } from '@/error'
import router from '@/router'
import GenericError from '@/components/GenericError.vue'
import InputText from '@/components/InputText.vue'
import SubmitButton from '@/components/SubmitButton.vue'

const http = inject(HttpClient)
const route = useRoute()
const session = useSessionStore()

const form = reactive({
  data: {
    email: session.user.email ?? '',
    password: ''
  },
  invalid: true,
  loading: false,
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
  form.loading = true
  http
    ?.post('/auth/login', form.data)
    .then((response) => {
      session.setUserId(response.data.id)
      session.setEmail(response.data.email)
      session.setName(response.data.firstname, response.data.lastname)
      router.replace({ name: 'home' })
    })
    .catch((error) => {
      form.data.password = ''
      form.error = error.response.data
    })
    .finally(() => {
      form.loading = false
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

      <div>
        <InputText
          label="Email"
          name="email"
          type="email"
          :error="form.error"
          :focused="!session.user.email"
          v-model="form.data.email"
          @enterPressed="submit"
        />

        <InputText
          label="Password"
          name="password"
          type="password"
          :error="form.error"
          :focused="!!session.user.email"
          v-model="form.data.password"
          @enterPressed="submit"
        />

        <GenericError :error="form.error" />

        <SubmitButton
          @click="submit"
          :disabled="form.invalid"
          :loading="form.loading"
          class="w-full"
        >
          Login
        </SubmitButton>

        <div v-show="!route.query.created" class="text-center">
          <RouterLink to="/register" class="text-blue-500 hover:text-blue-600"
            >New? Create an account</RouterLink
          >
        </div>
      </div>
    </div>
  </div>
</template>
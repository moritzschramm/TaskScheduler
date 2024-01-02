<script setup lang="ts">
import { RouterLink, useRouter } from 'vue-router'
import { inject, reactive, watch, onBeforeMount } from 'vue'
import { HttpClient } from '@/injectable/http'
import { useRegisterStore } from '@/stores/register'
import { useSessionStore } from '@/stores/session'
import StepBar from '@/components/StepBar.vue'

const router = useRouter()
const http = inject(HttpClient)
const registerStore = useRegisterStore()
const sessionStore = useSessionStore()

const EMAIL_REGEX = /^.+@.+\..+$/

enum FormState {
  EMAIL = 1,
  USER_DATA = 2,
  VERIFY = 3
}

const form = reactive({
  data: {
    email: '',
    firstname: '',
    lastname: '',
    password: '',
    confirm: '',
    verificationCode: ''
  },
  invalid: true,
  state: FormState.EMAIL,
  error: ''
})

// check if page was reloaded and restore state
onBeforeMount(() => {
  if (registerStore.email) {
    form.data.email = registerStore.email
    form.state = FormState.USER_DATA
  }
  if (registerStore.firstname && registerStore.lastname) {
    form.data.firstname = registerStore.firstname
    form.data.lastname = registerStore.lastname
    form.state = FormState.VERIFY
  }
})

// check if current form is in valid state so next step button is enabled
// only watch for changes in the data object in form
watch(
  () => form.data,
  (data) => {
    if (form.state === FormState.EMAIL) {
      form.invalid = data.email.length === 0 || !EMAIL_REGEX.test(data.email)
    } else if (form.state === FormState.USER_DATA) {
      form.invalid =
        data.firstname.length === 0 ||
        data.lastname.length === 0 ||
        data.password.length === 0 ||
        data.confirm.length === 0
    } else if (form.state === FormState.VERIFY) {
      form.invalid = data.verificationCode.length === 0
    }
  },
  { deep: true }
)

const next = (state: FormState) => {
  form.invalid = true
  form.error = ''
  form.state = state
}

const submit = () => {
  if (form.state === FormState.EMAIL) {
    /*http?.post('/auth/register-email', { email: form.data.email })
    .then(() => {
      registerStore.setEmail(form.data.email)
      next(FormState.USER_DATA)
    })
    .catch((error) => {
      form.error = error
    })*/
    registerStore.setEmail(form.data.email)
    next(FormState.USER_DATA)
  } else if (form.state === FormState.USER_DATA) {
    if (form.data.password.length < 10) {
      form.error = 'Password needs to have at least 10 characters'
      return
    }

    if (form.data.password !== form.data.confirm) {
      form.error = 'Passwords do not match'
      return
    }

    /*http?.post('/auth/register-user-data', { 
      firstname: form.data.firstname, 
      lastname: form.data.lastname, 
      password: form.data.password,
    })
    .then(() => {
      registerStore.setName(form.data.firstname, form.data.lastname)
      next(FormState.VERIFY)
    })
    .catch((error) => {
      form.error = error
    })*/
    registerStore.setName(form.data.firstname, form.data.lastname)
    next(FormState.VERIFY)
  } else if (form.state === FormState.VERIFY) {
    /*http?.post('/auth/verify-email', { code: form.data.verificationCode })
    .then(() => {
      if (registerStore.email) sessionStore.setEmail(registerStore.email)
      if (registerStore.firstname && registerStore.lastname) sessionStore.setName(registerStore.firstname, registerStore.lastname)
      router.replace({
        name: 'login',
        query: { 'created': 'now' }
      })
    })
    .catch((error) => {
      form.error = error
    })*/

    if (registerStore.email) sessionStore.setEmail(registerStore.email)
    if (registerStore.firstname && registerStore.lastname)
      sessionStore.setName(registerStore.firstname, registerStore.lastname)
    registerStore.$reset()
    router.replace({
      name: 'login',
      query: { created: 'now' }
    })
  }
}
</script>

<template>
  <div class="flex justify-center py-8">
    <div class="w-[640px]">
      <StepBar class="mb-10" :step="form.state" />

      <h2 class="text-2xl font-semibold mb-4">
        {{
          form.state === FormState.USER_DATA
            ? 'Enter Your User Data'
            : form.state === FormState.VERIFY
              ? 'Verify Email Address'
              : 'Register New Account'
        }}
      </h2>

      <form>
        <div v-show="form.state === FormState.EMAIL">
          <p class="mb-6">Enter your email address to register a new account.</p>
          <div class="mb-4">
            <label for="email" class="block text-gray-600 text-sm font-medium mb-2">Email</label>
            <input
              v-model.trim="form.data.email"
              type="email"
              id="email"
              name="email"
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
              required
            />
          </div>
        </div>

        <div v-show="form.state === FormState.USER_DATA">
          <p class="mb-6">
            We have send a verification code to <strong>{{ form.data.email }}</strong
            ><br />
            In the meantime, please enter the fields below.
          </p>

          <div class="mb-4">
            <label for="firstname" class="block text-gray-600 text-sm font-medium mb-2"
              >Firstname</label
            >
            <input
              v-model.trim="form.data.firstname"
              type="text"
              id="firstname"
              name="firstname"
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
              required
            />
          </div>

          <div class="mb-8">
            <label for="lastname" class="block text-gray-600 text-sm font-medium mb-2"
              >Lastname</label
            >
            <input
              v-model.trim="form.data.lastname"
              type="text"
              id="lastname"
              name="lastname"
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
              required
            />
          </div>

          <p class="mb-2 text-sm">
            Make sure to choose a strong password of at least 10 characters
          </p>

          <div class="mb-4">
            <label for="password" class="block text-gray-600 text-sm font-medium mb-2"
              >Password</label
            >
            <input
              v-model="form.data.password"
              type="password"
              id="password"
              name="password"
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
              required
            />
          </div>

          <div class="mb-4">
            <label for="confirm" class="block text-gray-600 text-sm font-medium mb-2"
              >Confirm password</label
            >
            <input
              v-model="form.data.confirm"
              type="password"
              id="confirm"
              name="confirm"
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
              required
            />
          </div>
        </div>

        <div v-show="form.state === FormState.VERIFY">
          <p class="mb-6">
            Please enter the verification code send to <strong>{{ form.data.email }}</strong>
          </p>

          <div class="mb-4">
            <label for="verificationCode" class="block text-gray-600 text-sm font-medium mb-2"
              >Verification Code</label
            >
            <input
              v-model.trim="form.data.verificationCode"
              type="text"
              id="verificationCode"
              name="verificationCode"
              class="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:border-blue-500"
              required
            />
          </div>

          <p class="mb-4 text-sm">
            Wrong email address?
            <a href="/register" target="_blank" class="text-blue-500 hover:text-blue-600"
              >Start a new registration process</a
            >
          </p>
        </div>

        <p v-show="form.error" class="text-red-600 text-sm mb-4">
          {{ form.error }}
        </p>

        <div class="text-right">
          <button
            @click="submit"
            :disabled="form.invalid"
            type="button"
            class="mb-4 bg-blue-500 text-white py-2 px-4 rounded-md hover:bg-blue-600 focus:outline-none focus:bg-blue-600 disabled:bg-blue-400"
          >
            {{ form.state === FormState.VERIFY ? 'Finish' : 'Next step' }}
          </button>
        </div>

        <div v-show="form.state === FormState.EMAIL" class="text-center">
          <RouterLink to="/login" class="text-blue-500 hover:text-blue-600"
            >Already have an account? Login</RouterLink
          >
        </div>
      </form>
    </div>
  </div>
</template>

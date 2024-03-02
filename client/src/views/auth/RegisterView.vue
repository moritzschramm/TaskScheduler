<script setup lang="ts">
import { RouterLink, useRouter } from 'vue-router'
import { inject, reactive, watch, onBeforeMount } from 'vue'
import { HttpClient } from '@/injectable/http'
import { useRegisterStore } from '@/stores/registerStore'
import { useSessionStore } from '@/stores/sessionStore'
import { emptyError } from '@/error'
import GenericError from '@/components/GenericError.vue'
import InputText from '@/components/InputText.vue'
import InputVerificationCode from '@/components/InputVerificationCode.vue'
import StepBar from '@/components/StepBar.vue'
import SubmitButton from '@/components/SubmitButton.vue'

const router = useRouter()
const http = inject(HttpClient)
const registerStore = useRegisterStore()
const session = useSessionStore()

const EMAIL_REGEX = /^.+@.+\..+$/

enum FormState {
  EMAIL = 1,
  PASSWORD = 2,
  VERIFY = 3
}
const initialForm = {
  data: {
    email: '',
    password: '',
    confirm: '',
    verificationCode: ''
  },
  invalid: true,
  loading: false,
  state: FormState.EMAIL,
  error: emptyError
}
const form = reactive(structuredClone(initialForm))

// check if page was reloaded and restore state
onBeforeMount(() => {
  if (registerStore.state) {
    form.state = registerStore.state
    if (registerStore.email) {
      form.data.email = registerStore.email
    }
  }
})

// check if current form is in valid state so next step button is enabled
watch(
  () => form.data, // only watch for changes in the data object in form
  (data) => {
    if (form.state === FormState.EMAIL) {
      form.invalid = data.email.length === 0 || !EMAIL_REGEX.test(data.email)
    } else if (form.state === FormState.PASSWORD) {
      form.invalid =
        data.password.length === 0 ||
        data.confirm.length === 0
    } else if (form.state === FormState.VERIFY) {
      form.invalid = data.verificationCode.length === 0
    }
  },
  { deep: true } // important for state watching on deeper levels then data (i.e. data.email etc.)
)

// go to next form state
const next = (state: FormState) => {
  form.invalid = true
  form.error = emptyError
  form.state = state
  registerStore.setState(state)
}

// submit form at current state and go to next state
const submit = () => {
  if (form.invalid) {
    return
  }
  if (form.state === FormState.EMAIL) {
    form.loading = true
    http
      ?.post('/auth/register-email', { email: form.data.email })
      .then(() => {
        registerStore.setEmail(form.data.email)
        next(FormState.PASSWORD)
      })
      .catch((error) => {
        form.error = error.response.data
      })
      .finally(() => {
        form.loading = false
      })
  } else if (form.state === FormState.PASSWORD) {

    if (form.data.password !== form.data.confirm) {
      form.error = { confirm: 'Passwords do not match' }
      form.data.confirm = ''
      return
    }

    form.loading = true
    http
      ?.post('/auth/register-password', {
        password: form.data.password
      })
      .then(() => {
        next(FormState.VERIFY)
      })
      .catch((error) => {
        form.error = error.response.data
      })
      .finally(() => {
        form.loading = false
        form.data.confirm = ''
      })
  } else if (form.state === FormState.VERIFY) {
    form.loading = true
    http
      ?.post('/auth/verify-email', {
        verificationCode: form.data.verificationCode
      })
      .then(() => {
        if (registerStore.email) {
          session.setEmail(registerStore.email)
        }
        registerStore.$reset()
        router.replace({
          name: 'login',
          query: { created: 'now' }
        })
      })
      .catch((error) => {
        form.error = error.response.data
        form.data.verificationCode = ''
      })
      .finally(() => {
        form.loading = false
      })
  }
}

function reset() {
  registerStore.$reset()
  Object.assign(form, structuredClone(initialForm))
}
</script>

<template>
  <div class="flex justify-center py-8">
    <div class="w-[640px]">
      <StepBar class="mb-10" :step="form.state" />

      <h2 class="text-2xl font-semibold mb-4">
        {{
          form.state === FormState.EMAIL
            ? 'Enter Your Email Address'
            : form.state === FormState.PASSWORD
              ? 'Enter a Password'
              : 'Verify Your Email Address'
        }}
      </h2>

      <div>
        <div v-show="form.state === FormState.EMAIL">
          <p class="mb-6">Enter your email address to register a new account.</p>
          <InputText
            label="Email"
            name="email"
            type="email"
            :error="form.error"
            :focused="form.state === FormState.EMAIL"
            v-model.trim="form.data.email"
            @enterPressed="submit"
          />
        </div>

        <div v-show="form.state === FormState.PASSWORD">
          <p class="mb-4">
            We have send a verification code to <strong>{{ form.data.email }}</strong
            ><br />
            In the meantime, please enter a password.
          </p>
          <p class="mb-4 text-sm">
            Wrong email address?
            <button @click="reset" class="text-blue-500 hover:text-blue-600">
              Start a new registration process
            </button>
          </p>

          <p class="mt-4 mb-4 text-sm">
            Make sure to choose a strong password of at least 10 characters
          </p>

          <InputText
            label="Password"
            name="password"
            type="password"
            :error="form.error"
            v-model="form.data.password"
            @enterPressed="submit"
          />

          <InputText
            label="Confirm Password"
            name="confirm"
            type="password"
            :error="form.error"
            v-model="form.data.confirm"
            @enterPressed="submit"
          />
        </div>

        <div v-show="form.state === FormState.VERIFY">
          <p class="mb-4">
            Please enter the verification code send to <strong>{{ form.data.email }}</strong>
          </p>
          <p class="mb-6 text-sm">
            Wrong email address?
            <button @click="reset" class="text-blue-500 hover:text-blue-600">
              Start a new registration process
            </button>
          </p>

          <InputVerificationCode
            label="Verification Code"
            name="verificationCode"
            :error="form.error"
            :focused="form.state === FormState.VERIFY"
            v-model.trim="form.data.verificationCode"
            @enterPressed="submit"
          />
        </div>

        <GenericError :error="form.error" />

        <div class="text-right">
          <SubmitButton @click="submit" :disabled="form.invalid" :loading="form.loading">
            {{ form.state === FormState.VERIFY ? 'Finish' : 'Next step' }}
          </SubmitButton>
        </div>

        <div v-show="form.state === FormState.EMAIL" class="text-center">
          <RouterLink to="/login" class="text-blue-500 hover:text-blue-600"
            >Already have an account? Login
          </RouterLink>
        </div>
      </div>
    </div>
  </div>
</template>

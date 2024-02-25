<script setup lang="ts">
import { RouterLink, useRouter } from 'vue-router'
import { inject, reactive, watch, onBeforeMount } from 'vue'
import { HttpClient } from '@/injectable/http'
import { useRegisterStore } from '@/stores/register'
import { useSessionStore } from '@/stores/session'
import { emptyError } from '@/error'
import GenericError from '@/components/GenericError.vue'
import InputText from '@/components/InputText.vue'
import StepBar from '@/components/StepBar.vue'
import SubmitButton from '@/components/SubmitButton.vue'

const router = useRouter()
const http = inject(HttpClient)
const registerStore = useRegisterStore()
const session = useSessionStore()

const EMAIL_REGEX = /^.+@.+\..+$/

enum FormState {
  EMAIL = 1,
  USER_DATA = 2,
  VERIFY = 3
}
const initialForm = {
  data: {
    email: '',
    firstname: '',
    lastname: '',
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
watch(
  () => form.data, // only watch for changes in the data object in form
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
  { deep: true } // important for state watching on deeper levels then data (i.e. data.email etc.)
)

// go to next form state
const next = (state: FormState) => {
  form.invalid = true
  form.error = emptyError
  form.state = state
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
        next(FormState.USER_DATA)
      })
      .catch((error) => {
        form.error = error.response.data
      })
      .finally(() => {
        form.loading = false
      })
  } else if (form.state === FormState.USER_DATA) {
    if (form.data.password.length < 10) {
      form.error = { confirm: 'Password needs to have at least 10 characters' }
      return
    }

    if (form.data.password !== form.data.confirm) {
      form.error = { confirm: 'Passwords do not match' }
      form.data.confirm = ''
      return
    }

    form.loading = true
    http
      ?.post('/auth/register-user-data', {
        firstname: form.data.firstname,
        lastname: form.data.lastname,
        password: form.data.password
      })
      .then(() => {
        registerStore.setName(form.data.firstname, form.data.lastname)
        next(FormState.VERIFY)
      })
      .catch((error) => {
        form.error = error.response.data
      })
      .finally(() => {
        form.loading = false
      })
  } else if (form.state === FormState.VERIFY) {
    form.loading = true
    http
      ?.post('/auth/verify-email', {
        verificationCode: form.data.verificationCode
      })
      .then(() => {
        if (registerStore.email && registerStore.firstname && registerStore.lastname) {
          session.setEmail(registerStore.email)
          session.setName(registerStore.firstname, registerStore.lastname)
          registerStore.$reset()
        }
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
            ? 'Register New Account'
            : form.state === FormState.USER_DATA
              ? 'Enter Your Account Data'
              : 'Verify Email Address'
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

        <div v-show="form.state === FormState.USER_DATA">
          <p class="mb-4">
            We have send a verification code to <strong>{{ form.data.email }}</strong
            ><br />
            In the meantime, please enter the fields below.
          </p>
          <p class="mb-6 text-sm">
            Wrong email address?
            <button @click="reset" class="text-blue-500 hover:text-blue-600">
              Start a new registration process
            </button>
          </p>
          <InputText
            label="Firstname"
            name="firstname"
            type="text"
            :error="form.error"
            :focused="form.state === FormState.USER_DATA"
            v-model.trim="form.data.firstname"
            @enterPressed="submit"
          />

          <InputText
            label="Lastname"
            name="lastname"
            type="text"
            :error="form.error"
            v-model.trim="form.data.lastname"
            @enterPressed="submit"
          />

          <p class="mt-6 mb-2 text-sm">
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

          <InputText
            label="Verification Code"
            name="verificationCode"
            type="text"
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

import { defineStore } from 'pinia'
import { ref } from 'vue'
import { type StoreConfig, loadOldState } from '@/stores/PersistentStorage'

export const registerStoreConfig: StoreConfig = {
  name: 'registerStore',
  storageInterface: localStorage
}

// TODO add expiration date for data in this store (1hr)
export const useRegisterStore = defineStore(registerStoreConfig.name, () => {
  const oldState = loadOldState(registerStoreConfig)

  const email = ref<string | undefined>(oldState.email ?? undefined)
  const firstname = ref<string | undefined>(oldState.firstname ?? undefined)
  const lastname = ref<string | undefined>(oldState.lastname ?? undefined)

  function setEmail(emailAddr: string) {
    email.value = emailAddr
  }
  function setName(first: string, last: string) {
    firstname.value = first
    lastname.value = last
  }

  function $reset() {
    email.value = undefined
    firstname.value = undefined
    lastname.value = undefined
  }

  return { email, firstname, lastname, setEmail, setName, $reset }
})

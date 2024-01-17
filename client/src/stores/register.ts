import { defineStore } from 'pinia'
import { ref } from 'vue'
import { type StoreConfig, loadOldState } from '@/stores/PersistentStorage'

export const registerStoreConfig: StoreConfig = {
  name: 'registerStore',
  storageInterface: sessionStorage
}

export const useRegisterStore = defineStore(registerStoreConfig.name, () => {
  const oldState = loadOldState(registerStoreConfig)

  const registerId = ref<string | undefined>(oldState.registerId ?? undefined)
  const email = ref<string | undefined>(oldState.email ?? undefined)
  const firstname = ref<string | undefined>(oldState.firstname ?? undefined)
  const lastname = ref<string | undefined>(oldState.lastname ?? undefined)

  function setEmail(registerIdStr: string, emailAddr: string) {
    registerId.value = registerIdStr
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

  return { registerId, email, firstname, lastname, setEmail, setName, $reset }
})

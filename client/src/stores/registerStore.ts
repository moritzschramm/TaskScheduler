import { defineStore } from 'pinia'
import { ref } from 'vue'
import { type StoreConfig, loadOldState } from '@/stores/PersistentStorage'

export const registerStoreConfig: StoreConfig = {
  name: 'registerStore',
  storageInterface: localStorage
}

// TODO add expiration date for data in this store (0.5hr)
export const useRegisterStore = defineStore(registerStoreConfig.name, () => {
  const oldState = loadOldState(registerStoreConfig)

  const email = ref<string | undefined>(oldState.email ?? undefined)
  const state = ref<number | undefined>(oldState.state ?? undefined)

  function setEmail(emailAddr: string) {
    email.value = emailAddr
  }
  function setState(currentState: number) {
    state.value = currentState
  }

  function $reset() {
    email.value = undefined
    state.value = undefined
  }

  return { email, state, setEmail, setState, $reset }
})

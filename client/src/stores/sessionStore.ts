import { defineStore } from 'pinia'
import { ref } from 'vue'
import { type StoreConfig, loadOldState } from '@/stores/PersistentStorage'

export interface User {
  id?: string
  email?: string
  name?: string
}

export const sessionStoreConfig: StoreConfig = {
  name: 'sessionStore',
  storageInterface: localStorage
}

export const useSessionStore = defineStore(sessionStoreConfig.name, () => {
  const oldState = loadOldState(sessionStoreConfig)

  const user = ref<User>(oldState.user ?? {})

  function setUserId(id: string) {
    user.value.id = id
  }
  function setEmail(email: string) {
    user.value.email = email
  }
  function setName(name: string) {
    user.value.name = name
  }
  function reset() {
    user.value = {}
  }

  return { user, setUserId, setEmail, setName, reset }
})

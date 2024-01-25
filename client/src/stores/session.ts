import { defineStore } from 'pinia'
import { ref } from 'vue'
import { type StoreConfig, loadOldState } from './PersistentStorage'

export interface User {
  id?: string
  email?: string
  firstname?: string
  lastname?: string
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
  function setName(first: string, last: string) {
    user.value.firstname = first
    user.value.lastname = last
  }

  return { user, setUserId, setEmail, setName }
})

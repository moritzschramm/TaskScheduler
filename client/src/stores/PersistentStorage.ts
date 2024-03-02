import { sessionStoreConfig, useSessionStore } from '@/stores/sessionStore'
import { registerStoreConfig, useRegisterStore } from '@/stores/registerStore'
import type { Store } from 'pinia'

export interface StoreConfig {
  name: string
  storageInterface: Storage
}

const registerStateSubscriber = (store: Store, config: StoreConfig) => {
  store.$subscribe(
    (_, state) => {
      config.storageInterface.setItem(config.name, JSON.stringify(state))
    },
    { detached: true }
  )
}

export const loadOldState = (storeConfig: StoreConfig): any => {
  return JSON.parse(storeConfig.storageInterface.getItem(storeConfig.name) ?? '{}')
}

// make state persistent with localStorage (or whatever storageInterface is set)
// should be called in main, after pinia is registered
export const registerPersistentStores = () => {
  registerStateSubscriber(useSessionStore(), sessionStoreConfig)

  // session storage: Keep data from reload, but flush data if tab closes
  registerStateSubscriber(useRegisterStore(), registerStoreConfig)
}

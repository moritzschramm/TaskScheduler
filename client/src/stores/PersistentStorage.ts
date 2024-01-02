import { sessionStoreConfig, useSessionStore } from "@/stores/session"
import { registerStoreConfig, useRegisterStore } from "@/stores/register"
import type { Store } from 'pinia'

export interface StoreConfig {
    name: string,
    storageInterface: Storage
}

const registerStateSubscriber = (store: Store, config: StoreConfig) => {
    store.$subscribe((_, state) => {
        config.storageInterface.setItem(config.name, JSON.stringify(state))
    }, { detached: true })
}

// make state persistent with localStorage
// should be called in main, after pinia is registered
export const registerPersistentStores = () => {

    registerStateSubscriber(useSessionStore(), sessionStoreConfig)

    // session storage: Keep data from reload, but flush data if tab closes
    registerStateSubscriber(useRegisterStore(), registerStoreConfig)
}


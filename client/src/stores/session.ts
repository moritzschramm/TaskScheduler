import { defineStore } from "pinia"
import { ref } from "vue"
import { type StoreConfig } from "./PersistentStorage"

export interface User {
    id?: string,
    email?: string,
    firstname?: string,
    lastname?: string,
}

export const sessionStoreConfig: StoreConfig = {
    name: 'sessionStore',
    storageInterface: localStorage,
}

export const useSessionStore = defineStore(sessionStoreConfig.name, () => {
    const oldState = JSON.parse(sessionStoreConfig.storageInterface.getItem(sessionStoreConfig.name) ?? "{}")

    const user = ref<User>(oldState.user ?? {})

    function setEmail(emailAddr: string) {
        user.value.email = emailAddr
    }
    function setName(first: string, last: string) {
        user.value.firstname = first
        user.value.lastname = last
    }

    return { user, setEmail, setName }
})
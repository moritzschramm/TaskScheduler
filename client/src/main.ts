import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { axiosInstance, HttpClient } from '@/injectable/http'

import App from '@/App.vue'

import router from '@/router'
import { useSessionStore } from '@/stores/sessionStore'
import { registerPersistentStores } from '@/stores/PersistentStorage'

const app = createApp(App)

app.use(createPinia())
registerPersistentStores()

app.use(router)

const sessionStore = useSessionStore()
// * Authentication Guard
router.beforeEach(async (to) => {
  // no access to any page other than login and register when user is unauthenticated
  // access to login and register is always allowed
  if (to.name !== 'register' && to.name !== 'login' && !sessionStore.user.id) {
    return { name: 'login' } // redirect to login page
  }
})

app.provide(HttpClient, axiosInstance)

app.mount('#app')

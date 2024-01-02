import './assets/main.css'

import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { axiosInstance, HttpClient } from '@/injectable/http'

import App from '@/App.vue'
import router from '@/router'
import { registerPersistentStores } from '@/stores/PersistentStorage'

const app = createApp(App)

app.use(createPinia())
registerPersistentStores()

app.use(router)

app.provide(HttpClient, axiosInstance)

app.mount('#app')

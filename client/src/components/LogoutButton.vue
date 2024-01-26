<script setup lang="ts">
import { HttpClient } from '@/injectable/http';
import router from '@/router';
import { inject } from 'vue';
import { useSessionStore } from '@/stores/session';

const http = inject(HttpClient)
const sessionStore = useSessionStore()

function logout() {
    http?.post('/auth/logout')
        .then((response) => {
            const email = sessionStore.user.email
            sessionStore.reset()
            sessionStore.setEmail(email)  // keep email for easier login
            router.push({ name: 'login' })
        })
        .catch((response) => {
            console.error(response.data)
            router.push({ name: 'login' })
        })
}
</script>

<template>
    <button @click="logout" class="text-white">Logout</button>
</template>

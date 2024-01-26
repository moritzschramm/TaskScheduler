<script setup lang="ts">
import { RouterLink } from 'vue-router'
import LogoutButton from '@/components/LogoutButton.vue'
</script>

<template>
    <header>
        <nav class="bg-gray-800 p-4">
            <div class="container mx-auto flex justify-between items-center">
                <RouterLink to="/" class="text-white text-lg font-semibold">AuthExample</RouterLink>

                <!-- Navigation Links -->
                <div class="space-x-4">
                    <RouterLink to="/" class="text-white hover:text-gray-300">Home</RouterLink>
                    <RouterLink to="/profile" class="text-white hover:text-gray-300">Profile</RouterLink>
                    <LogoutButton />
                </div>
            </div>
        </nav>
    </header>
</template>

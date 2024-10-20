<script setup lang="ts">
import { RouterLink } from 'vue-router'
import LogoutButton from '@/components/LogoutButton.vue'
</script>

<template>
  <header>
    <nav class="bg-gray-50 p-4">
      <div class="container flex justify-between items-center">
        <RouterLink to="/" class="text-gray-900 hover:text-gray-500 text-lg">TaskScheduler</RouterLink>

        <div class="space-x-4">
          <RouterLink to="/" class="text-gray-900 hover:text-gray-500">Home</RouterLink>
          <RouterLink to="/profile" class="text-gray-900 hover:text-gray-500">Profile</RouterLink>
          <LogoutButton />
        </div>
      </div>
    </nav>
  </header>
</template>

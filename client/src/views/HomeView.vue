<script setup lang="ts">
import NavBar from '@/components/NavBar.vue'

import { HttpClient } from '@/injectable/http'
import { inject } from 'vue'

const http = inject(HttpClient)

http?.post('/test/hello').then(function (response) {
  console.log(response)
})
</script>

<template>
  <NavBar />

  <div class="flex">
    <!-- Sidebar -->
    <div class="w-64 h-screen bg-gray-800 text-white p-4">
      <h2 class="text-2xl font-semibold mb-6">Dashboard</h2>
      <ul>
        <li class="mb-4">
          <a href="#" class="flex items-center space-x-2 hover:bg-gray-700 p-2 rounded-md">
            <span>🏠</span>
            <span>Home</span>
          </a>
        </li>
        <li class="mb-4">
          <a href="#" class="flex items-center space-x-2 hover:bg-gray-700 p-2 rounded-md">
            <span>📄</span>
            <span>Reports</span>
          </a>
        </li>
        <li class="mb-4">
          <a href="#" class="flex items-center space-x-2 hover:bg-gray-700 p-2 rounded-md">
            <span>📦</span>
            <span>Products</span>
          </a>
        </li>
        <li class="mb-4">
          <a href="#" class="flex items-center space-x-2 hover:bg-gray-700 p-2 rounded-md">
            <span>⚙️</span>
            <span>Settings</span>
          </a>
        </li>
      </ul>
    </div>

    <!-- Main Content -->
    <div class="flex-1 p-10 text-gray-700">
      <h1 class="text-3xl font-semibold">Welcome to your Dashboard</h1>
      <div class="max-w-lg mx-auto p-4">
        <div class="text-center mb-6">
          <h2 class="text-2xl font-bold">August 2024</h2>
        </div>

        <div class="grid grid-cols-7 gap-2 text-center">
          <!-- Days of the week -->
          <div class="font-semibold">Sun</div>
          <div class="font-semibold">Mon</div>
          <div class="font-semibold">Tue</div>
          <div class="font-semibold">Wed</div>
          <div class="font-semibold">Thu</div>
          <div class="font-semibold">Fri</div>
          <div class="font-semibold">Sat</div>

          <!-- Days (example for August 2024) -->
          <div class="text-gray-400">28</div>
          <div class="text-gray-400">29</div>
          <div class="text-gray-400">30</div>
          <div class="text-gray-400">31</div>
          <div class="bg-blue-500 text-white rounded-md p-2">1</div>
          <div class="bg-blue-500 text-white rounded-md p-2">2</div>
          <div class="bg-blue-500 text-white rounded-md p-2">3</div>

          <!-- Continue with the rest of the days -->
          <!-- Use text-gray-400 for days outside the current month -->
          <div class="bg-blue-500 text-white rounded-md p-2">4</div>
          <div class="bg-blue-500 text-white rounded-md p-2">5</div>
          <div class="bg-blue-500 text-white rounded-md p-2">6</div>
          <div class="bg-blue-500 text-white rounded-md p-2">7</div>
          <div class="bg-blue-500 text-white rounded-md p-2">8</div>
          <div class="bg-blue-500 text-white rounded-md p-2">9</div>
          <div class="bg-blue-500 text-white rounded-md p-2">10</div>
          <!-- Add all the days of the month similarly -->
        </div>
      </div>
    </div>
  </div>

</template>

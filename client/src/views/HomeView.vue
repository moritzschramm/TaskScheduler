<script setup lang="ts">
import NavBar from '@/components/NavBar.vue'

import { HttpClient } from '@/injectable/http';
import { inject } from 'vue';

const http = inject(HttpClient)

http?.post("/test/hello")
    .then(function (response) {
        console.log(response)
    })
</script>

<template>
    <NavBar />

    Home view
</template>

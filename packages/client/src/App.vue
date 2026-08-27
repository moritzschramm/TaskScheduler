<script setup lang="ts">
import HealthStatus from '@/components/HealthStatus.vue';
</script>

<template>
  <main class="flex min-h-full flex-col items-center justify-center gap-8 p-8">
    <header class="flex flex-col items-center gap-2 text-center">
      <h1 class="text-3xl font-semibold tracking-tight">Ambitime</h1>
      <p class="text-muted-foreground max-w-prose text-sm">
        Walking skeleton (M0). The real application starts at M10 — this page exists to prove the
        client → nginx → server → Postgres path works.
      </p>
    </header>

    <HealthStatus />
  </main>
</template>

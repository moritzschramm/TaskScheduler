<script setup lang="ts">
import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { session, signOut } from '@/lib/session';

/**
 * The frame around every signed-in page.
 *
 * The context strip is §9.3's switcher in read-only form: which tenant this
 * request is acting in, and which others exist. Switching is a write to the
 * session (M8 has the endpoint) and belongs with the rest of the mutation
 * surface in M11 — showing the list now is what makes its absence obvious
 * rather than invisible.
 */

const router = useRouter();

const active = computed(() =>
  session.value?.contexts.find((context) => context.tenantId === session.value?.activeTenantId),
);

async function leave() {
  await signOut();
  await router.replace({ name: 'sign-in' });
}
</script>

<template>
  <div class="bg-background min-h-full">
    <header
      v-if="session"
      class="flex items-center justify-between gap-4 border-b px-6 py-3"
      data-testid="app-shell-header"
    >
      <div class="flex items-baseline gap-3">
        <span class="text-sm font-semibold tracking-tight">Ambitime</span>
        <Badge v-if="active" variant="secondary" data-testid="active-context">
          {{ active.isPersonal ? 'Personal' : active.name }}
        </Badge>
        <span
          v-if="session.contexts.length > 1"
          class="text-muted-foreground text-xs"
          data-testid="context-count"
        >
          {{ session.contexts.length }} contexts
        </span>
      </div>

      <div class="flex items-center gap-3">
        <span class="text-muted-foreground text-xs">{{ session.user.email }}</span>
        <Button variant="ghost" size="sm" data-testid="sign-out" @click="leave">Sign out</Button>
      </div>
    </header>

    <slot />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { CheckCircle2, Loader2, RefreshCw, XCircle } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { fetchHealth, type HealthResult } from '@/lib/health';

const result = ref<HealthResult | null>(null);
const loading = ref(false);

async function check() {
  loading.value = true;
  try {
    result.value = await fetchHealth();
  } finally {
    loading.value = false;
  }
}

onMounted(check);
</script>

<template>
  <Card class="w-full max-w-xl" data-testid="health-card">
    <CardHeader>
      <div class="flex items-center justify-between gap-4">
        <div class="flex flex-col gap-1.5">
          <CardTitle>Database connectivity</CardTitle>
          <CardDescription>
            The server answers <code class="font-mono text-xs">/api/health</code> only after a real
            query round-trips to Postgres.
          </CardDescription>
        </div>

        <Badge v-if="loading" variant="secondary" data-testid="health-badge">
          <Loader2 class="animate-spin" />
          Checking
        </Badge>
        <Badge v-else-if="result?.state === 'ok'" variant="success" data-testid="health-badge">
          <CheckCircle2 />
          Connected
        </Badge>
        <Badge
          v-else-if="result?.state === 'error'"
          variant="destructive"
          data-testid="health-badge"
        >
          <XCircle />
          Unreachable
        </Badge>
      </div>
    </CardHeader>

    <CardContent>
      <dl
        v-if="result?.state === 'ok'"
        class="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm"
        data-testid="health-details"
      >
        <dt class="text-muted-foreground">Schema version</dt>
        <dd class="font-mono">{{ result.data.database.schemaVersion }}</dd>

        <dt class="text-muted-foreground">Postgres time (UTC)</dt>
        <dd class="font-mono">{{ result.data.database.serverTime }}</dd>

        <dt class="text-muted-foreground">Query latency</dt>
        <dd class="font-mono">{{ result.data.database.latencyMs }} ms</dd>
      </dl>

      <p
        v-else-if="result?.state === 'error'"
        class="text-destructive text-sm"
        data-testid="health-error"
      >
        {{ result.message }}
      </p>

      <p v-else class="text-muted-foreground text-sm">Contacting the server…</p>
    </CardContent>

    <CardFooter>
      <Button variant="outline" size="sm" :disabled="loading" @click="check">
        <RefreshCw :class="loading ? 'animate-spin' : ''" />
        Re-check
      </Button>
    </CardFooter>
  </Card>
</template>

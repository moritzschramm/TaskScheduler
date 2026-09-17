<script setup lang="ts">
import { computed } from 'vue';
import { Moon, Sun } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { toggleTheme, useTheme } from '@/lib/theme';
import { useI18n } from '@/i18n';

/**
 * The everyday half of the theme setting (spec §13).
 *
 * One press, and it flips what is on screen. The full choice — including
 * following the operating system, which is the default and the one most people
 * should stay on — is in Settings, because "go back to following my Mac" is a
 * decision somebody makes once and "it is too bright in here" is something they
 * think at dusk with the calendar already open.
 *
 * **The icon is the destination, not the state.** A sun on a light page is a
 * label for where you already are, which tells nobody what the button does. A
 * moon on a light page is an offer. That is also what the accessible name says,
 * so the two channels agree rather than one of them being decoration.
 *
 * It is inside the signed-in header, so the sign-in page has no toggle. That is
 * the right trade rather than an omission: a stored choice survives signing out
 * because it is in this browser, and somebody who has never chosen is being
 * shown exactly what their operating system asked for.
 */

const { t } = useI18n();
const { surface } = useTheme();

const label = computed(() => t(surface.value === 'dark' ? 'theme.toLight' : 'theme.toDark'));
</script>

<template>
  <Button
    variant="ghost"
    size="sm"
    :title="label"
    :aria-label="label"
    data-testid="theme-toggle"
    :data-surface="surface"
    @click="toggleTheme"
  >
    <Sun v-if="surface === 'dark'" class="size-4" aria-hidden="true" />
    <Moon v-else class="size-4" aria-hidden="true" />
  </Button>
</template>

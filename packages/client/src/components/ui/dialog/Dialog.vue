<script setup lang="ts">
import {
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogRoot,
  DialogTitle,
} from 'reka-ui';

/**
 * A modal, from Reka UI rather than from first principles.
 *
 * The focus trap, the Escape handler, the `aria-modal` wiring and the return of
 * focus to whatever opened it are the parts that are easy to write badly and
 * hard to notice are wrong — §14 targets WCAG 2.2 AA, and a hand-rolled dialog
 * is the classic way to miss 2.1.2 and 2.4.3.
 *
 * The portal is **disabled**, so the content renders where it is declared
 * rather than teleporting to `document.body`. `fixed` positioning means it
 * still covers the viewport, and it keeps the dialog inside the component tree
 * — which is what lets a test that mounted a view find the form it opened.
 */
const open = defineModel<boolean>('open', { required: true });

defineProps<{
  /** Names the dialog for assistive technology; the body may repeat it. */
  title: string;
  description?: string;
}>();
</script>

<template>
  <DialogRoot v-model:open="open">
    <DialogPortal disabled>
      <DialogOverlay class="fixed inset-0 z-40 bg-black/40" data-testid="dialog-overlay" />
      <!--
        `aria-modal` is stated as well as implied. Reka hides the rest of the
        page with `aria-hidden`, which is the sturdier of the two techniques and
        is what actually keeps a screen reader inside — but some assistive
        technology reads the attribute, and both are true here: focus is trapped
        and everything behind is hidden.
      -->
      <DialogContent
        class="bg-card fixed top-1/2 left-1/2 z-50 max-h-[88vh] w-[min(52rem,92vw)] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-lg border p-6 shadow-lg"
        aria-modal="true"
        data-testid="dialog"
      >
        <DialogTitle class="sr-only">{{ title }}</DialogTitle>
        <DialogDescription v-if="description" class="sr-only">{{ description }}</DialogDescription>

        <!-- Escape closes it too, but only for people who know that. -->
        <DialogClose
          class="text-muted-foreground hover:text-foreground focus-visible:ring-ring absolute top-3 right-3 rounded-md px-2 py-1 text-sm focus-visible:ring-2 focus-visible:outline-none"
          aria-label="Close"
          data-testid="dialog-close"
        >
          ✕
        </DialogClose>

        <slot />
      </DialogContent>
    </DialogPortal>
  </DialogRoot>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Button } from '@/components/ui/button';
import type { CommandRequest, HistoryView } from '@ambitime/shared';

/**
 * Undo and redo (spec §7.5), over the actor's own command log.
 *
 * They are commands like any other: pressing undo appends an `Undo` to the log
 * beside what it reversed, which is what keeps the history an honest record of
 * intent — including the intent to take something back (§12).
 *
 * The button says what it would undo. "Undo" alone asks a user to remember
 * what they last did, and the log already knows: a group of commands undone
 * together is named by its first, since that is the action the user took.
 */
const props = defineProps<{
  history: HistoryView | null;
  submit: (request: CommandRequest) => Promise<boolean>;
}>();

/** `MoveTask` → `Move task`. The log's vocabulary, made readable. */
function readable(types: string[] | null | undefined): string | null {
  const first = types?.[0];
  if (first === undefined) return null;

  const words = first.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const undoLabel = computed(() => readable(props.history?.undoable));
const redoLabel = computed(() => readable(props.history?.redoable));
</script>

<template>
  <div class="flex items-center gap-1">
    <Button
      variant="ghost"
      size="sm"
      :disabled="undoLabel === null"
      :title="undoLabel === null ? 'Nothing to undo' : `Undo: ${undoLabel}`"
      data-testid="undo"
      @click="submit({ type: 'Undo', params: {} })"
    >
      Undo
    </Button>
    <Button
      variant="ghost"
      size="sm"
      :disabled="redoLabel === null"
      :title="redoLabel === null ? 'Nothing to redo' : `Redo: ${redoLabel}`"
      data-testid="redo"
      @click="submit({ type: 'Redo', params: {} })"
    >
      Redo
    </Button>
  </div>
</template>

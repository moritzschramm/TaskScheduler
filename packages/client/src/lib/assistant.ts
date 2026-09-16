import { computed, ref, type ComputedRef, type Ref } from 'vue';
import {
  ASSISTANT_IDLE_RESET_MS,
  MAX_PROPOSALS_PER_TURN,
  MAX_STEPS_PER_MESSAGE,
  assistantReplySchema,
  type AssistantCallResult,
  type AssistantReply,
  type AssistantTurn,
  type CommandRequest,
} from '@ambitime/shared';
import { ApiError, api, expectOk } from './api';
import { now } from './clock';
import { renderSnapshot } from './snapshot';
import { toProposal, type Proposal } from './proposals';
import { useWorkspace } from './workspace';
import { language, translate, type MessageKey, type Params } from '@/i18n';
import { session } from './session';

/**
 * The chat, and the rules it is bound by (spec §2.2).
 *
 * §3.2 planned for this: "GUI actions and a future NL parser both emit
 * commands; nothing else can write." So there is no new write path here. The
 * model proposes; this module turns proposals into commands, shows them to a
 * person, and — only when they say so — sends them down the same
 * `POST /api/commands` a button uses.
 *
 * Three rules make that safe rather than merely true:
 *
 * 1. **Nothing applies itself.** Every command waits behind Apply. There is no
 *    auto-approve, no "safe commands" exception, and no setting to turn it off:
 *    the moment one exists, the interesting question stops being "what did it
 *    propose" and starts being "what did it already do".
 * 2. **A plan is one undo.** Every command in a batch carries the same
 *    `groupId`, and §7.5 folds a group into a single unit of history. "Press
 *    undo" is then a true answer to "it got it wrong", rather than a true
 *    answer for the last line only.
 * 3. **A typed message buys a bounded number of turns.** Applying a plan lets
 *    the model continue — which is what makes two-step work possible, since the
 *    id of a task it just created is not knowable in advance — but only
 *    `MAX_STEPS_PER_MESSAGE` times, and every step past the first still needs a
 *    person to press Apply again.
 *
 * Held at module scope, like the workspace, because the panel is mounted in the
 * shell and outlives every route: navigating from Schedule to Tasks must not be
 * a way of losing a conversation halfway through.
 */

export interface PlanView {
  groupId: string;
  proposals: Proposal[];
  state: 'pending' | 'applying' | 'applied' | 'declined' | 'failed';
  /** Set once applied, so the message can offer to take it back. */
  undoable: boolean;
}

export type ChatMessage =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string; plan: PlanView | null }
  /** Something the application says on its own behalf — a limit, a refusal. */
  | { kind: 'notice'; id: string; text: string };

const messages = ref<ChatMessage[]>([]);
/** The conversation as the model sees it; `messages` is how it is drawn. */
const turns = ref<AssistantTurn[]>([]);
const open = ref(false);
const busy = ref(false);
const error = ref<string | null>(null);
/** Steps spent on the message being answered, against `MAX_STEPS_PER_MESSAGE`. */
let steps = 0;
let lastUsed = 0;

const SESSION_KEY = 'ambitime.assistant';

function t(key: MessageKey, params?: Params): string {
  return translate(language.value, key, params);
}

function id(): string {
  return crypto.randomUUID();
}

/**
 * Whether the assistant is available at all: a key has been set.
 *
 * Read off the session rather than kept here, so it is right the moment
 * settings saves one — the settings screen reloads the session after every
 * write, and this follows.
 */
const configured = computed(() => session.value?.assistant != null);

/**
 * Drops a conversation that has been left alone too long.
 *
 * The reason is staleness rather than tidiness. What this chat reasons about is
 * a *week*, and the assumptions inside a half-finished exchange — which
 * Thursday, whose dentist, what "it" referred to — go quietly wrong as that
 * week is worked on elsewhere. Starting again costs one sentence of retyping;
 * carrying on from an hours-old premise costs a command that looked right.
 */
function expired(): boolean {
  return messages.value.length > 0 && now().getTime() - lastUsed > ASSISTANT_IDLE_RESET_MS;
}

function touch(): void {
  lastUsed = now().getTime();
  persist();
}

export function resetAssistant(): void {
  messages.value = [];
  turns.value = [];
  error.value = null;
  steps = 0;
  lastUsed = 0;
  try {
    globalThis.sessionStorage?.removeItem(SESSION_KEY);
  } catch {
    // A browser refusing storage is not a reason to refuse a conversation.
  }
}

/**
 * Kept in `sessionStorage`, not `localStorage`.
 *
 * A reload in the middle of a sentence should not cost the conversation, and a
 * tab closed at the end of the day should. The transcript is the user's own
 * words about their own schedule — no key, no token — and it is dropped on
 * read if the idle window has passed, so the reset rule holds across a reload
 * as well as within one.
 */
function persist(): void {
  try {
    globalThis.sessionStorage?.setItem(
      SESSION_KEY,
      JSON.stringify({ at: lastUsed, messages: messages.value, turns: turns.value }),
    );
  } catch {
    // Private browsing, or a quota. The chat works; it just will not survive.
  }
}

export function restoreAssistant(): void {
  try {
    const raw = globalThis.sessionStorage?.getItem(SESSION_KEY);
    if (raw == null) return;

    const saved = JSON.parse(raw) as {
      at?: number;
      messages?: ChatMessage[];
      turns?: AssistantTurn[];
    };
    if (typeof saved.at !== 'number' || now().getTime() - saved.at > ASSISTANT_IDLE_RESET_MS) {
      resetAssistant();
      return;
    }

    messages.value = saved.messages ?? [];
    turns.value = saved.turns ?? [];
    lastUsed = saved.at;

    // A plan that was still waiting when the tab reloaded has no standing: the
    // model was answered with nothing, and offering Apply now would apply a
    // proposal whose conversation no longer exists in the transcript.
    for (const message of messages.value) {
      if (message.kind === 'assistant' && message.plan?.state === 'pending') {
        message.plan.state = 'declined';
      }
    }
  } catch {
    resetAssistant();
  }
}

/**
 * The schedule, rendered fresh for every request.
 *
 * Not cached. It is the one part of the prompt that is *supposed* to change,
 * and a stale copy is the failure this whole feature would be blamed for: an
 * assistant confidently describing a week that was rearranged five minutes ago.
 */
function snapshot(): string {
  const workspace = useWorkspace();

  return renderSnapshot({
    now: now().toISOString(),
    zone: workspace.zone.value,
    locale: workspace.locale.value,
    calendar: workspace.calendar.value,
    configuration: workspace.configuration.value,
    schedule: workspace.view.value?.schedule ?? null,
    fixedBlocks: workspace.view.value?.fixedBlocks ?? [],
    tasks: workspace.tasks.value,
    backlog: workspace.backlog.value,
    capacity: workspace.capacity.value,
    days: workspace.days.value,
  });
}

/** What a plan line needs to be written in the reader's language. */
function subject() {
  const workspace = useWorkspace();

  return {
    taskTitles: new Map(workspace.tasks.value.map((task) => [task.id, task.title])),
    blockTitles: new Map(
      (workspace.view.value?.fixedBlocks ?? []).map((block) => [
        block.appointmentId,
        block.title === '' ? t('assistant.plan.untitledBlock') : block.title,
      ]),
    ),
    categoryNames: new Map(workspace.categories.value.map((c) => [c.id, c.name])),
    zone: workspace.zone.value,
    locale: workspace.locale.value,
  };
}

async function ask(): Promise<AssistantReply> {
  const response = await api.api.assistant.turn.$post({
    json: { turns: turns.value, snapshot: snapshot() },
  });

  return assistantReplySchema.parse(await expectOk(response));
}

/**
 * One exchange: send what has been said, draw what comes back.
 *
 * Returns whether a plan is now waiting, which is what decides whether the
 * conversation pauses here.
 */
async function step(): Promise<boolean> {
  const workspace = useWorkspace();
  const calendarId = workspace.selectedId.value;

  const reply = await ask();
  turns.value.push({ role: 'assistant', text: reply.text, calls: reply.calls });

  const proposals =
    calendarId === null ? [] : reply.calls.map((call) => toProposal(call, calendarId, subject()));

  const plan: PlanView | null =
    proposals.length === 0 ? null : { groupId: id(), proposals, state: 'pending', undoable: false };

  messages.value.push({ kind: 'assistant', id: id(), text: reply.text, plan });

  if (reply.stop === 'limit') {
    messages.value.push({ kind: 'notice', id: id(), text: t('assistant.truncated') });
  }

  if (reply.calls.length >= MAX_PROPOSALS_PER_TURN) {
    messages.value.push({ kind: 'notice', id: id(), text: t('assistant.capped') });
  }

  // A calendar has to exist before anything can be proposed against it, and
  // the model was never told which one — so this is our failure to report,
  // not its.
  if (calendarId === null && reply.calls.length > 0) {
    messages.value.push({ kind: 'notice', id: id(), text: t('assistant.noCalendar') });
  }

  return plan !== null;
}

export async function send(text: string): Promise<void> {
  const trimmed = text.trim();
  if (trimmed === '' || busy.value) return;

  if (expired()) resetAssistant();

  // Any plan still on screen when somebody types again has been passed over.
  // Both providers refuse a transcript in which a tool call goes unanswered, so
  // the decline is recorded here rather than left to be noticed later.
  declineOutstanding();

  messages.value.push({ kind: 'user', id: id(), text: trimmed });
  turns.value.push({ role: 'user', text: trimmed });

  steps = 0;
  error.value = null;
  busy.value = true;

  try {
    await step();
  } catch (cause) {
    fail(cause);
  } finally {
    busy.value = false;
    touch();
  }
}

/**
 * Runs a plan, as one unit of history, and lets the model see what happened.
 *
 * The continuation afterwards is what makes a two-step request possible at all:
 * a command naming a task the previous command created cannot be written until
 * that task has an id. It is bounded twice over — by `MAX_STEPS_PER_MESSAGE`,
 * and by the fact that whatever comes back is another plan somebody has to
 * press Apply on.
 */
export async function apply(plan: PlanView): Promise<void> {
  if (plan.state !== 'pending' || busy.value) return;

  const workspace = useWorkspace();
  plan.state = 'applying';
  busy.value = true;
  error.value = null;

  try {
    const runnable = plan.proposals.filter((proposal) => proposal.request !== null);
    const outcomes = await workspace.runBatch(
      runnable.map((proposal) => proposal.request as CommandRequest),
      plan.groupId,
    );

    const results: AssistantCallResult[] = [];
    let applied = 0;
    let index = 0;

    for (const proposal of plan.proposals) {
      if (proposal.request === null) {
        results.push({
          id: proposal.call.id,
          status: 'invalid',
          detail: `Rejected before it ran: ${proposal.problem ?? 'invalid parameters'}`,
        });
        continue;
      }

      const outcome = outcomes[index++];

      if (outcome === undefined) {
        // The batch stopped at an earlier failure, so this never ran.
        results.push({
          id: proposal.call.id,
          status: 'failed',
          detail: 'Not attempted: an earlier command in this plan failed.',
        });
        continue;
      }

      if (outcome.ok) {
        applied += 1;
        // The created ids go back deliberately: they are what a follow-up
        // command needs to name what this one made.
        const created = outcome.created.map((entity) => `${entity.entity} ${entity.id}`).join(', ');

        results.push({
          id: proposal.call.id,
          status: 'applied',
          detail: created === '' ? 'Applied.' : `Applied. Created ${created}.`,
        });
      } else {
        results.push({
          id: proposal.call.id,
          status: 'failed',
          detail: `Refused: ${outcome.error ?? 'unknown reason'}`,
        });
      }
    }

    turns.value.push({ role: 'outcome', results });
    plan.state = applied === plan.proposals.length ? 'applied' : 'failed';
    plan.undoable = applied > 0;

    if (applied > 0 && steps + 1 < MAX_STEPS_PER_MESSAGE) {
      steps += 1;
      await step();
    } else if (applied > 0) {
      messages.value.push({ kind: 'notice', id: id(), text: t('assistant.stepLimit') });
    }
  } catch (cause) {
    plan.state = 'failed';
    fail(cause);
  } finally {
    busy.value = false;
    touch();
  }
}

/**
 * Turning a plan down.
 *
 * Recorded in the transcript rather than simply dismissed, because the model
 * has to be told: a refusal is information — often the most useful information
 * in the conversation — and a silence would leave it free to propose the same
 * thing again. No request is made; the words travel with whatever is typed next.
 */
export function decline(plan: PlanView): void {
  if (plan.state !== 'pending') return;

  plan.state = 'declined';
  turns.value.push({
    role: 'outcome',
    results: plan.proposals.map((proposal) => ({
      id: proposal.call.id,
      status: 'declined' as const,
      detail: 'The user did not accept this. Do not propose it again unless asked.',
    })),
  });

  touch();
}

function declineOutstanding(): void {
  for (const message of messages.value) {
    if (message.kind === 'assistant' && message.plan?.state === 'pending') decline(message.plan);
  }
}

/** Takes back an applied plan, through the same undo the header offers (§7.5). */
export async function undoPlan(plan: PlanView): Promise<void> {
  const workspace = useWorkspace();
  if (!plan.undoable || busy.value) return;

  busy.value = true;
  try {
    const ok = await workspace.submit({ type: 'Undo', params: {} });
    if (ok) {
      plan.undoable = false;
      messages.value.push({ kind: 'notice', id: id(), text: t('assistant.undone') });
      // The model is told, so the next thing it proposes is not built on a
      // change that has been taken back.
      turns.value.push({ role: 'user', text: 'I undid that.' });
    }
  } finally {
    busy.value = false;
    touch();
  }
}

function fail(cause: unknown): void {
  error.value =
    cause instanceof ApiError
      ? cause.message
      : cause instanceof Error
        ? cause.message
        : t('assistant.failed');
}

export interface Assistant {
  messages: Ref<ChatMessage[]>;
  open: Ref<boolean>;
  busy: Ref<boolean>;
  error: Ref<string | null>;
  configured: ComputedRef<boolean>;
  send: (text: string) => Promise<void>;
  apply: (plan: PlanView) => Promise<void>;
  decline: (plan: PlanView) => void;
  undoPlan: (plan: PlanView) => Promise<void>;
  reset: () => void;
  toggle: () => void;
}

export function useAssistant(): Assistant {
  return {
    messages,
    open,
    busy,
    error,
    configured,
    send,
    apply,
    decline,
    undoPlan,
    reset: resetAssistant,
    toggle,
  };
}

/**
 * Opening the panel is also when the idle rule is enforced.
 *
 * A timer would be the other way to do it, and would fire in a tab nobody is
 * looking at, on a laptop that was asleep, against a `Date.now()` that jumped.
 * The check belongs where somebody is about to read the conversation.
 */
function toggle(): void {
  if (!open.value && expired()) resetAssistant();
  open.value = !open.value;
  if (open.value) touch();
}

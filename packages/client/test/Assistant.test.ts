import { ref } from 'vue';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSISTANT_IDLE_RESET_MS,
  type AssistantReply,
  type CommandRequest,
} from '@ambitime/shared';
import type { PlanView } from '@/lib/assistant';

/**
 * The chat, and the three rules that make it safe (spec §2.2, §3.2).
 *
 * 1. Nothing the model asks for runs until somebody presses Apply.
 * 2. A plan applies as **one** unit of history, so one undo takes all of it
 *    back (§7.5).
 * 3. A typed message buys a bounded number of turns, so no loop can spend an
 *    afternoon of somebody's money.
 *
 * Everything below is one of those three, or the idle reset that keeps a stale
 * premise from being carried into a week that has moved on.
 */

const CALENDAR = '01890000-0000-7000-8000-0000000000c0';
const TASK = '01890000-0000-7000-8000-000000000001';

const runBatch =
  vi.fn<(requests: readonly CommandRequest[], groupId: string) => Promise<unknown>>();
const submit = vi.fn<(request: CommandRequest) => Promise<boolean>>();

vi.mock('@/lib/workspace', () => ({
  useWorkspace: () => ({
    selectedId: ref(CALENDAR),
    zone: ref('Europe/Berlin'),
    locale: ref('en-GB'),
    calendar: ref({ id: CALENDAR, name: 'Personal', timezone: 'Europe/Berlin' }),
    configuration: ref(null),
    view: ref(null),
    tasks: ref([{ id: TASK, title: 'Invoices' }]),
    categories: ref([]),
    backlog: ref([]),
    capacity: ref([]),
    days: ref([]),
    runBatch,
    submit,
  }),
}));

const assistant = await import('@/lib/assistant');

/** The plan on the most recent answer, or the one still waiting. */
function planOf(pending = false): PlanView {
  const { messages } = assistant.useAssistant();

  const found = [...messages.value]
    .reverse()
    .find(
      (message) =>
        message.kind === 'assistant' &&
        message.plan !== null &&
        (!pending || message.plan.state === 'pending'),
    );

  if (found === undefined || found.kind !== 'assistant' || found.plan === null) {
    throw new Error('No plan was proposed');
  }

  return found.plan;
}

/** Answers the turn endpoint with one reply, and records what was asked. */
function reply(...replies: AssistantReply[]) {
  const sent: unknown[] = [];
  let index = 0;

  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    sent.push(JSON.parse(String(init.body)));
    const body = replies[Math.min(index++, replies.length - 1)];
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  return sent;
}

const move: AssistantReply = {
  text: 'I can move that.',
  calls: [
    {
      id: 'call_1',
      command: 'MoveTask',
      params: { taskId: TASK, datetime: '2026-09-17T09:00:00+02:00' },
    },
  ],
  stop: 'calls',
};

const done: AssistantReply = { text: 'Done.', calls: [], stop: 'end' };

beforeEach(() => {
  assistant.resetAssistant();
  runBatch.mockReset().mockResolvedValue([{ ok: true, error: null, created: [] }]);
  submit.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('asking for something', () => {
  it('shows what was said and what is proposed, and runs nothing', async () => {
    reply(move);
    const { messages, send } = assistant.useAssistant();

    await send('move the invoices to Thursday');

    expect(messages.value.map((message) => message.kind)).toEqual(['user', 'assistant']);
    const answer = messages.value[1];
    expect(answer?.kind === 'assistant' && answer.text).toBe('I can move that.');
    expect(answer?.kind === 'assistant' && answer.plan?.proposals).toHaveLength(1);

    // The whole point: a proposal is not an action.
    expect(runBatch).not.toHaveBeenCalled();
  });

  it('sends the week with the question, so it needs no lookup to answer', async () => {
    const sent = reply(done);
    await assistant.useAssistant().send('what is on Thursday?');

    const body = sent[0] as { snapshot: string; turns: unknown[] };
    expect(body.snapshot).toContain('The schedule, as the user is looking at it');
    expect(body.turns).toEqual([{ role: 'user', text: 'what is on Thursday?' }]);
  });

  it('ignores an empty message rather than spending a request on it', async () => {
    const sent = reply(done);
    await assistant.useAssistant().send('   ');

    expect(sent).toHaveLength(0);
  });
});

describe('applying a plan', () => {
  it('sends every command under one group, so one undo takes it all back', async () => {
    reply(
      {
        text: 'Two changes.',
        calls: [
          {
            id: 'call_1',
            command: 'MoveTask',
            params: { taskId: TASK, datetime: '2026-09-17T09:00:00+02:00' },
          },
          { id: 'call_2', command: 'CompleteTask', params: { taskId: TASK } },
        ],
        stop: 'calls',
      },
      done,
    );

    runBatch.mockResolvedValue([
      { ok: true, error: null, created: [] },
      { ok: true, error: null, created: [] },
    ]);

    const { send, apply } = assistant.useAssistant();
    await send('do two things');

    const plan = planOf();
    await apply(plan);

    expect(runBatch).toHaveBeenCalledTimes(1);
    const [requests, groupId] = runBatch.mock.calls[0]!;
    expect(requests.map((request) => request.type)).toEqual(['MoveTask', 'CompleteTask']);
    expect(groupId).toBe(plan.groupId);
    expect(plan.state).toBe('applied');
    expect(plan.undoable).toBe(true);
  });

  it('tells the model what happened, including what it created', async () => {
    const sent = reply(
      {
        text: 'Adding that.',
        calls: [{ id: 'call_1', command: 'CreateTask', params: { title: 'Invoices' } }],
        stop: 'calls',
      },
      done,
    );

    runBatch.mockResolvedValue([
      { ok: true, error: null, created: [{ entity: 'task', id: TASK }] },
    ]);

    const { send, apply } = assistant.useAssistant();
    await send('add a task');
    await apply(planOf());

    // The created id goes back because the next command may need to name what
    // this one made — which is the whole reason a plan gets a follow-up turn.
    const follow = sent[1] as { turns: { role: string; results?: { detail: string }[] }[] };
    const outcome = follow.turns.find((turn) => turn.role === 'outcome');
    expect(outcome?.results?.[0]?.detail).toContain(TASK);
  });

  it('does not run a command whose arguments were wrong, and says so', async () => {
    reply({
      text: 'Adding that.',
      calls: [{ id: 'call_1', command: 'CreateTask', params: { title: '' } }],
      stop: 'calls',
    });

    const { send } = assistant.useAssistant();
    await send('add a task with no name');

    expect(planOf().proposals[0]?.problem).toContain('title');
  });

  it('stops at the step limit rather than proposing for ever', async () => {
    // A model that answers every applied plan with another one. Each round
    // still costs a press of Apply, and this is the belt over that brace.
    reply(move);
    const { messages, send, apply } = assistant.useAssistant();

    await send('keep going');

    for (let round = 0; round < 10; round += 1) {
      const pending = messages.value.find(
        (message) => message.kind === 'assistant' && message.plan?.state === 'pending',
      );
      if (pending === undefined) break;
      await apply(planOf(true));
    }

    expect(messages.value.some((message) => message.kind === 'notice')).toBe(true);
    expect(runBatch.mock.calls.length).toBeLessThanOrEqual(5);
  });
});

describe('turning a plan down', () => {
  it('records the refusal without spending a request on it', async () => {
    const sent = reply(move, done);
    const { send, decline } = assistant.useAssistant();

    await send('move the invoices');
    decline(planOf());

    expect(sent).toHaveLength(1);
    expect(runBatch).not.toHaveBeenCalled();

    // It travels with whatever is typed next: both providers refuse a
    // transcript in which a tool call goes unanswered, and the model has to
    // know it was turned down or it will propose the same thing again.
    await send('never mind, what is on Friday?');
    const follow = sent[1] as { turns: { role: string; results?: { status: string }[] }[] };
    expect(follow.turns.find((turn) => turn.role === 'outcome')?.results?.[0]?.status).toBe(
      'declined',
    );
  });

  it('declines anything still waiting when the user just types again', async () => {
    const sent = reply(move, done);
    const { send } = assistant.useAssistant();

    await send('move the invoices');
    await send('actually, what is on Friday?');

    const follow = sent[1] as { turns: { role: string }[] };
    expect(follow.turns.map((turn) => turn.role)).toEqual(['user', 'assistant', 'outcome', 'user']);
  });
});

describe('taking it back', () => {
  it('undoes through the same command the header uses', async () => {
    reply(move, done);
    const { send, apply, undoPlan } = assistant.useAssistant();

    await send('move the invoices');
    const plan = planOf();
    await apply(plan);
    await undoPlan(plan);

    expect(submit).toHaveBeenCalledWith({ type: 'Undo', params: {} });
    expect(plan.undoable).toBe(false);
  });
});

describe('leaving it alone', () => {
  it('starts again after half an hour, rather than carrying a stale premise', async () => {
    reply(move, done);
    const { messages, send, toggle } = assistant.useAssistant();

    await send('move the invoices');
    expect(messages.value).toHaveLength(2);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + ASSISTANT_IDLE_RESET_MS + 1000));

    // Opening the panel is where the rule is enforced, because that is where
    // somebody is about to read the conversation.
    toggle();
    expect(messages.value).toHaveLength(0);
  });

  it('keeps a conversation that is still warm', async () => {
    reply(move, done);
    const { messages, send, toggle } = assistant.useAssistant();

    await send('move the invoices');

    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 60_000));

    toggle();
    expect(messages.value).toHaveLength(2);
  });
});

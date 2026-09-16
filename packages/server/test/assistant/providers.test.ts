import { afterEach, describe, expect, it, vi } from 'vitest';
import { runTurn, AssistantProviderError } from '../../src/assistant/providers.js';
import type { AssistantTurn } from '@ambitime/shared';

/**
 * What actually goes on the wire (spec §2.2, §17).
 *
 * The transcript this application keeps belongs to neither provider: an
 * `outcome` turn is one Anthropic user message holding every `tool_result`, and
 * one OpenAI `tool` message *per* result. Getting that wrong does not fail
 * loudly — it fails as a 400 from a provider, in production, on the second turn
 * of a conversation, which is the worst place to discover a shape.
 *
 * The provider's own fetch is stubbed rather than its SDK: what is being
 * asserted is the request, and mocking the client would assert only that this
 * file calls the method it calls.
 */

const TASK = '01890000-0000-7000-8000-000000000001';

interface Captured {
  url: string;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function answering(payload: unknown): Captured[] {
  const seen: Captured[] = [];

  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit) => {
    const headers = new Headers(init.headers);
    seen.push({
      url: String(input instanceof Request ? input.url : input),
      body: JSON.parse(String(init.body)),
      headers: Object.fromEntries(headers.entries()),
    });

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });

  return seen;
}

const TRANSCRIPT: AssistantTurn[] = [
  { role: 'user', text: 'move the invoices to Thursday' },
  {
    role: 'assistant',
    text: 'I can move that.',
    calls: [{ id: 'call_1', command: 'MoveTask', params: { taskId: TASK } }],
  },
  { role: 'outcome', results: [{ id: 'call_1', status: 'applied', detail: 'Applied.' }] },
  { role: 'user', text: 'and complete it' },
];

const ANTHROPIC_REPLY = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5',
  content: [
    { type: 'text', text: 'Marking it done.' },
    { type: 'tool_use', id: 'call_2', name: 'CompleteTask', input: { taskId: TASK } },
    // A tool this application never offered. Dropped rather than passed on —
    // the client would refuse it a moment later, and a plan line nobody can
    // explain is worse than one that was never drawn.
    { type: 'tool_use', id: 'call_3', name: 'DeleteEverything', input: {} },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 10, output_tokens: 5 },
};

afterEach(() => void vi.unstubAllGlobals());

describe('talking to Anthropic', () => {
  it('sends the prompt and the schedule as two cacheable spans', async () => {
    const seen = answering(ANTHROPIC_REPLY);

    await runTurn({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      model: 'claude-opus-5',
      snapshot: '# The schedule',
      turns: TRANSCRIPT,
    });

    const system = seen[0]?.body['system'] as { text: string; cache_control?: object }[];

    // Two breakpoints, in this order: the prompt and the tools never change,
    // and the schedule changes only when the schedule does. The conversation
    // grows after both.
    expect(system).toHaveLength(2);
    expect(system[0]?.text).toContain('Ambitime');
    expect(system[0]?.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1]?.text).toBe('# The schedule');
    expect(system[1]?.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('asks for a quick answer, and for a refusal to be rescued', async () => {
    const seen = answering(ANTHROPIC_REPLY);

    await runTurn({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      model: 'claude-opus-5',
      snapshot: '',
      turns: [{ role: 'user', text: 'hello' }],
    });

    // Low effort because this is a chat mapping sentences onto commands against
    // a week it has been handed in full: depth buys nothing and costs the one
    // thing the interface must have, which is an answer while somebody is still
    // looking at the screen.
    expect(seen[0]?.body['output_config']).toEqual({ effort: 'low' });

    // The fallback pair travels together — the parameter and the beta that
    // enables it — so removing one without the other is a 400 rather than a
    // silent downgrade.
    expect(seen[0]?.body['fallbacks']).toBe('default');
    expect(seen[0]?.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
  });

  it('offers the commands as tools, and nothing else', async () => {
    const seen = answering(ANTHROPIC_REPLY);

    await runTurn({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      model: 'claude-opus-5',
      snapshot: '',
      turns: [{ role: 'user', text: 'hello' }],
    });

    const tools = seen[0]?.body['tools'] as { name: string; input_schema: object }[];
    const names = tools.map((tool) => tool.name);

    expect(names).toContain('MoveTask');
    expect(names).toContain('BlockOutDay');
    // Everything the Activity types screen can do (§17).
    expect(names).toContain('SetAvailabilityWindows');
    expect(names).toContain('CreateWeekTypeOverride');
    // Nothing the Settings screen can do, and none of the user's own gestures.
    expect(names).not.toContain('UpdateSettings');
    expect(names).not.toContain('SetCalendarWindows');
    expect(names).not.toContain('Undo');
  });

  it('renders an answered plan as tool_use blocks and a tool_result message', async () => {
    const seen = answering(ANTHROPIC_REPLY);

    await runTurn({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      model: 'claude-opus-5',
      snapshot: '',
      turns: TRANSCRIPT,
    });

    const messages = seen[0]?.body['messages'] as { role: string; content: unknown }[];

    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      // Anthropic takes tool results as a *user* message — one, holding all of
      // them.
      'user',
      'user',
    ]);

    const assistant = messages[1]?.content as { type: string; name?: string }[];
    expect(assistant.map((block) => block.type)).toEqual(['text', 'tool_use']);
    expect(assistant[1]?.name).toBe('MoveTask');

    const results = messages[2]?.content as { type: string; tool_use_id: string }[];
    expect(results[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });
  });

  it('reads back the text and the calls, and drops a tool it never offered', async () => {
    answering(ANTHROPIC_REPLY);

    const reply = await runTurn({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
      model: 'claude-opus-5',
      snapshot: '',
      turns: [{ role: 'user', text: 'complete the invoices' }],
    });

    expect(reply.text).toBe('Marking it done.');
    expect(reply.stop).toBe('calls');
    expect(reply.calls).toEqual([
      { id: 'call_2', command: 'CompleteTask', params: { taskId: TASK } },
    ]);
  });

  it('passes the provider’s own refusal through, with its status', async () => {
    // "Your credit balance is too low" and "that model is not available to this
    // key" are two different afternoons, and neither of them is "something went
    // wrong".
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(
          JSON.stringify({
            type: 'error',
            error: { type: 'authentication_error', message: 'invalid x-api-key' },
          }),
          { status: 401, headers: { 'content-type': 'application/json' } },
        ),
    );

    const failure = runTurn({
      provider: 'anthropic',
      apiKey: 'sk-ant-wrong',
      model: 'claude-opus-5',
      snapshot: '',
      turns: [{ role: 'user', text: 'hello' }],
    });

    await expect(failure).rejects.toBeInstanceOf(AssistantProviderError);
    // The sentence, not the envelope: both SDKs put the status and the whole
    // raw body into `.message`, which buries the one line somebody can act on.
    await expect(failure).rejects.toMatchObject({ status: 401, message: 'invalid x-api-key' });
  });
});

describe('talking to OpenAI', () => {
  const REPLY = {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-5',
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: 'Marking it done.',
          tool_calls: [
            {
              id: 'call_2',
              type: 'function',
              function: { name: 'CompleteTask', arguments: `{"taskId":"${TASK}"}` },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
  };

  it('splits one outcome into a tool message per result', async () => {
    const seen = answering(REPLY);

    await runTurn({
      provider: 'openai',
      apiKey: 'sk-openai-test',
      model: 'gpt-5',
      snapshot: '# The schedule',
      turns: TRANSCRIPT,
    });

    const messages = seen[0]?.body['messages'] as { role: string; tool_call_id?: string }[];

    expect(messages.map((message) => message.role)).toEqual([
      'system',
      'system',
      'user',
      'assistant',
      'tool',
      'user',
    ]);
    expect(messages[4]?.tool_call_id).toBe('call_1');
  });

  it('parses arguments out of the JSON string they arrive as', async () => {
    answering(REPLY);

    const reply = await runTurn({
      provider: 'openai',
      apiKey: 'sk-openai-test',
      model: 'gpt-5',
      snapshot: '',
      turns: [{ role: 'user', text: 'complete the invoices' }],
    });

    expect(reply.calls).toEqual([
      { id: 'call_2', command: 'CompleteTask', params: { taskId: TASK } },
    ]);
  });

  it('survives arguments that are not JSON at all', async () => {
    // One bad command in a plan, which fails validation a moment later with a
    // message naming the fields it is missing. Losing the whole answer over it
    // would be the worse trade.
    answering({
      ...REPLY,
      choices: [
        {
          ...REPLY.choices[0],
          message: {
            ...REPLY.choices[0]!.message,
            tool_calls: [
              {
                id: 'call_2',
                type: 'function',
                function: { name: 'CompleteTask', arguments: '{not json' },
              },
            ],
          },
        },
      ],
    });

    const reply = await runTurn({
      provider: 'openai',
      apiKey: 'sk-openai-test',
      model: 'gpt-5',
      snapshot: '',
      turns: [{ role: 'user', text: 'complete the invoices' }],
    });

    expect(reply.calls).toEqual([{ id: 'call_2', command: 'CompleteTask', params: {} }]);
  });
});

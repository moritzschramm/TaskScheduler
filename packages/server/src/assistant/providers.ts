import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
  MAX_PROPOSALS_PER_TURN,
  isAssistantCommand,
  type AssistantCall,
  type AssistantProvider,
  type AssistantReply,
  type AssistantTurn,
} from '@ambitime/shared';
import { ANTHROPIC_TOOLS, ASSISTANT_SYSTEM_PROMPT, OPENAI_TOOLS } from './prompt.js';

/**
 * The one place this application talks to somebody else's model.
 *
 * **Why the server and not the browser.** Both SDKs can run in a page, and both
 * name the flag that allows it after the danger: a key in `localStorage` is a
 * key that any script on the origin can read and post anywhere, for as long as
 * the browser keeps it. Here it is written once, encrypted at rest, and never
 * sent back — the settings screen is told the last four characters and nothing
 * more. It also means the vocabulary and the system prompt are the server's,
 * so what the model is told the application can do cannot be edited from the
 * console.
 *
 * **What this does not do is execute anything.** It returns what the model
 * said and what it would like to run. Every write still goes through
 * `POST /api/commands`, from the client, once a person has agreed — see
 * `packages/client/src/lib/assistant.ts`. That is not an accident of layering:
 * it is what keeps the assistant inside the single write path (§3.2) instead of
 * beside it, and what makes its changes undoable like everybody else's.
 */

export class AssistantProviderError extends Error {
  constructor(
    message: string,
    /** The provider's own status, when it gave one; used to pick ours. */
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = 'AssistantProviderError';
  }
}

export interface TurnInput {
  provider: AssistantProvider;
  apiKey: string;
  model: string;
  /** The schedule as the caller is looking at it; context, never authority. */
  snapshot: string;
  turns: readonly AssistantTurn[];
}

/**
 * Room for an answer.
 *
 * Generous rather than tight: the visible output is two or three sentences plus
 * a handful of tool calls, but thinking is billed against the same ceiling and
 * a truncated turn is worse than a slightly larger bill — it arrives as half a
 * sentence with a plan that may be half a plan.
 */
const MAX_TOKENS = 8192;

export function runTurn(input: TurnInput): Promise<AssistantReply> {
  return input.provider === 'anthropic' ? viaAnthropic(input) : viaOpenAI(input);
}

/**
 * Where the schedule goes, and why it is in `system` rather than in a message.
 *
 * Caching is a prefix match, and the render order is tools, then system, then
 * messages. Putting the snapshot at the end of `system` gives two stable spans
 * with a breakpoint each: the prompt and the tools, which never change, and the
 * schedule, which changes only when the schedule does. The conversation grows
 * after both, so a second question about the same week re-reads everything
 * expensive instead of re-sending it.
 *
 * Inside a message it would have to sit either first — invalidating the whole
 * conversation every time a plan was applied — or last, where it would be
 * cheapest to send and furthest from the model's attention.
 */
async function viaAnthropic({
  apiKey,
  model,
  snapshot,
  turns,
}: TurnInput): Promise<AssistantReply> {
  const client = new Anthropic({ apiKey, maxRetries: 1 });

  const message = await translate(() =>
    client.beta.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      // A chat that maps sentences onto commands, against a week it has been
      // handed in full. Depth buys nothing here and costs the person the one
      // thing this interface has to have, which is an answer while they are
      // still looking at the screen.
      output_config: { effort: 'low' },
      // Delete this pair, and the `betas` line, if the account rejects the
      // beta. It rescues a turn the safety classifiers decline rather than
      // ending it; a scheduling assistant should never see one, and the cost
      // of being wrong about that is a chat that stops with no explanation.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [
        { type: 'text', text: ASSISTANT_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
        { type: 'text', text: snapshot, cache_control: { type: 'ephemeral' } },
      ],
      tools: ANTHROPIC_TOOLS,
      messages: turns.flatMap(anthropicMessage),
    }),
  );

  const text = message.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();

  const calls: AssistantCall[] = [];
  for (const block of message.content) {
    if (block.type !== 'tool_use') continue;
    if (!isAssistantCommand(block.name)) continue;
    calls.push({ id: block.id, command: block.name, params: asParams(block.input) });
  }

  return { text, calls: calls.slice(0, MAX_PROPOSALS_PER_TURN), stop: stopOf(message.stop_reason) };
}

function stopOf(reason: string | null): AssistantReply['stop'] {
  if (reason === 'tool_use') return 'calls';
  if (reason === 'max_tokens') return 'limit';
  if (reason === 'refusal') return 'refusal';
  return 'end';
}

function anthropicMessage(turn: AssistantTurn): Anthropic.Beta.BetaMessageParam[] {
  if (turn.role === 'user') return [{ role: 'user', content: turn.text }];

  if (turn.role === 'outcome') {
    return [
      {
        role: 'user',
        content: turn.results.map((result) => ({
          type: 'tool_result' as const,
          tool_use_id: result.id,
          content: result.detail,
          is_error: result.status === 'failed' || result.status === 'invalid',
        })),
      },
    ];
  }

  const content: Anthropic.Beta.BetaContentBlockParam[] = [];
  if (turn.text !== '') content.push({ type: 'text', text: turn.text });
  for (const call of turn.calls) {
    content.push({ type: 'tool_use', id: call.id, name: call.command, input: call.params });
  }

  // An assistant turn that said nothing and called nothing is not a turn the
  // API will accept, and replaying one would fail the whole conversation
  // rather than the message that produced it.
  return content.length === 0 ? [] : [{ role: 'assistant', content }];
}

async function viaOpenAI({ apiKey, model, snapshot, turns }: TurnInput): Promise<AssistantReply> {
  const client = new OpenAI({ apiKey, maxRetries: 1 });

  const completion = await translate(() =>
    client.chat.completions.create({
      model,
      // `max_completion_tokens`, not `max_tokens`: the current models reject
      // the old name, and reasoning tokens are billed against this one.
      max_completion_tokens: MAX_TOKENS,
      tools: OPENAI_TOOLS,
      tool_choice: 'auto',
      messages: [
        { role: 'system', content: ASSISTANT_SYSTEM_PROMPT },
        { role: 'system', content: snapshot },
        ...turns.flatMap(openAIMessages),
      ],
    }),
  );

  const choice = completion.choices[0];
  const calls: AssistantCall[] = [];

  for (const call of choice?.message.tool_calls ?? []) {
    if (call.type !== 'function') continue;
    if (!isAssistantCommand(call.function.name)) continue;
    calls.push({
      id: call.id,
      command: call.function.name,
      params: asParams(parseArguments(call.function.arguments)),
    });
  }

  return {
    text: (choice?.message.content ?? '').trim(),
    calls: calls.slice(0, MAX_PROPOSALS_PER_TURN),
    stop: choice?.finish_reason === 'length' ? 'limit' : calls.length > 0 ? 'calls' : 'end',
  };
}

function openAIMessages(turn: AssistantTurn): OpenAI.Chat.ChatCompletionMessageParam[] {
  if (turn.role === 'user') return [{ role: 'user', content: turn.text }];

  // One message per result here, where Anthropic takes one message holding all
  // of them. Same transcript, two shapes — which is the reason the wire format
  // between client and server is neither provider's.
  if (turn.role === 'outcome') {
    return turn.results.map((result) => ({
      role: 'tool',
      tool_call_id: result.id,
      content: result.detail,
    }));
  }

  if (turn.text === '' && turn.calls.length === 0) return [];

  return [
    {
      role: 'assistant',
      content: turn.text === '' ? null : turn.text,
      ...(turn.calls.length === 0
        ? {}
        : {
            tool_calls: turn.calls.map((call) => ({
              id: call.id,
              type: 'function' as const,
              function: { name: call.command, arguments: JSON.stringify(call.params) },
            })),
          }),
    },
  ];
}

/**
 * Arguments come back as a JSON *string*, and a malformed one is a real state.
 *
 * `{}` rather than a throw: an unparseable argument list is one bad command in
 * a plan, and it will fail validation a moment later with a message naming the
 * fields it is missing. Losing the whole answer over it would be a worse trade.
 */
function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function asParams(input: unknown): Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

/**
 * The provider's failure, in words the person who typed can act on.
 *
 * Passed through rather than replaced, for the same reason the command layer
 * passes its own refusals through: "your credit balance is too low" and "that
 * model is not available to this key" are two different afternoons, and
 * "something went wrong" is neither of them. These are the caller's own account
 * and the caller's own key, so there is nothing here to leak to them.
 */
async function translate<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Anthropic.APIError || error instanceof OpenAI.APIError) {
      throw new AssistantProviderError(sentenceIn(error) ?? error.message, error.status ?? null);
    }
    throw new AssistantProviderError(
      error instanceof Error ? error.message : 'The model could not be reached',
    );
  }
}

/**
 * The sentence inside the failure, rather than the whole envelope.
 *
 * Both SDKs set `.message` to the status followed by the raw response body, so
 * passing it through put `401 {"type":"error","error":{"type":...` on screen —
 * which contains the useful part ("API key is invalid") and buries it. The
 * shapes differ by one level of nesting, hence both lookups.
 */
function sentenceIn(error: { error?: unknown }): string | null {
  const body = error.error;
  if (typeof body !== 'object' || body === null) return null;

  const inner = 'error' in body ? (body as { error: unknown }).error : body;
  if (typeof inner !== 'object' || inner === null) return null;

  const message = (inner as { message?: unknown }).message;
  return typeof message === 'string' && message !== '' ? message : null;
}

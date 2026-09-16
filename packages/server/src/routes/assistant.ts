import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { zValidator } from '@hono/zod-validator';
import {
  DEFAULT_ASSISTANT_MODEL,
  assistantRequestSchema,
  setAssistantCredentialsSchema,
  type AssistantProvider,
  type AssistantReply,
} from '@ambitime/shared';
import { users } from '../db/schema/index.js';
import { requireContext } from '../auth/middleware.js';
import { withRequestContext } from '../auth/context.js';
import { toApiFailure, toValidationFailure } from '../api/errors.js';
import { AssistantProviderError, runTurn } from '../assistant/providers.js';
import { decrypt, encrypt, hintFor } from '../assistant/secrets.js';
import type { AppEnv } from '../app.js';
import type { Auth } from '../auth/auth.js';

/**
 * The natural-language interface, over HTTP (spec §2.2).
 *
 * Three routes, and the division between them is the whole design: two that
 * manage a credential, and one that asks a model a question. **None of them
 * writes anything about the schedule.** The turn route returns what the model
 * said and what it would like to run; the commands it names are sent by the
 * client, through `POST /api/commands`, after a person has read them. There is
 * still exactly one write path (§3.2), and the assistant is a caller on it
 * rather than a second one beside it.
 *
 * The credential routes are not commands, alone in this application among
 * things that change a `users` row. The reasoning is in migration 0019: the
 * command log is append-only with UPDATE and DELETE revoked, so a secret
 * journalled into it could never be removed — not by clearing the setting, not
 * by rotating the key. Credentials already live outside the command layer here;
 * a password reaches the database through Better Auth (§10.1).
 */
export function assistantRoutes(auth: Auth) {
  return new Hono<AppEnv>()
    .put(
      '/assistant/credentials',
      requireContext(auth),
      zValidator('json', setAssistantCredentialsSchema, (result, c) => {
        if (!result.success) {
          const failure = toValidationFailure(result.error);
          return c.json(failure.body, failure.status);
        }
        return undefined;
      }),
      async (c) => {
        const context = c.get('context');
        const body = c.req.valid('json');
        const model = body.model?.trim() || DEFAULT_ASSISTANT_MODEL[body.provider];

        // Trimmed before storing: keys are pasted, and a trailing newline from
        // a terminal is an authentication failure nobody can see.
        const apiKey = body.apiKey.trim();

        await withRequestContext(c.get('db'), context, (tx) =>
          tx
            .update(users)
            .set({
              assistantProvider: body.provider,
              assistantModel: model,
              assistantKey: encrypt(apiKey, c.get('assistantSecret')),
              assistantKeyHint: hintFor(apiKey),
            })
            .where(eq(users.id, context.userId)),
        );

        // The key never comes back, here or anywhere. What a settings screen
        // needs is whether one is set and which, and that is what it gets.
        return c.json({ provider: body.provider, model, hint: hintFor(apiKey) }, 200);
      },
    )

    .delete('/assistant/credentials', requireContext(auth), async (c) => {
      const context = c.get('context');

      await withRequestContext(c.get('db'), context, (tx) =>
        tx
          .update(users)
          .set({
            assistantProvider: null,
            assistantModel: null,
            assistantKey: null,
            assistantKeyHint: null,
          })
          .where(eq(users.id, context.userId)),
      );

      return c.json({ ok: true } as const, 200);
    })

    .post(
      '/assistant/turn',
      requireContext(auth),
      zValidator('json', assistantRequestSchema, (result, c) => {
        if (!result.success) {
          const failure = toValidationFailure(result.error);
          return c.json(failure.body, failure.status);
        }
        return undefined;
      }),
      async (c) => {
        const context = c.get('context');
        const body = c.req.valid('json');

        const [row] = await withRequestContext(c.get('db'), context, (tx) =>
          tx
            .select({
              provider: users.assistantProvider,
              model: users.assistantModel,
              key: users.assistantKey,
            })
            .from(users)
            .where(eq(users.id, context.userId))
            .limit(1),
        );

        if (!row?.provider || !row.model || !row.key) {
          return c.json(
            {
              error: {
                code: 'precondition_failed' as const,
                message: 'Add an API key in settings before using the assistant',
              },
            },
            409,
          );
        }

        const apiKey = decrypt(row.key, c.get('assistantSecret'));

        // Null means the stored bytes will not open: the signing secret was
        // rotated, or the row came from another deployment. Neither is a bug,
        // and both have the same answer — ask for the key again.
        if (apiKey === null) {
          return c.json(
            {
              error: {
                code: 'precondition_failed' as const,
                message: 'That stored API key could not be read. Enter it again in settings.',
              },
            },
            409,
          );
        }

        try {
          const reply: AssistantReply = await runTurn({
            provider: row.provider as AssistantProvider,
            apiKey,
            model: row.model,
            snapshot: body.snapshot,
            turns: body.turns,
          });

          return c.json(reply, 200);
        } catch (error) {
          if (error instanceof AssistantProviderError) {
            // The provider's own sentence, and a status that says whose problem
            // it is: a rejected key or an empty balance is the caller's to fix,
            // and calling either of those a 500 sends them to the wrong place.
            const ours = error.status !== null && error.status >= 400 && error.status < 500;

            return c.json(
              {
                error: {
                  code: ours ? ('precondition_failed' as const) : ('internal' as const),
                  message: error.message,
                },
              },
              ours ? 409 : 500,
            );
          }

          const failure = toApiFailure(error);
          return c.json(failure.body, failure.status);
        }
      },
    );
}

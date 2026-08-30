import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { commandRequestSchema, newCommand, type CommandResult } from '@ambitime/shared';
import { applyCommand } from '../commands/apply.js';
import { requireContext } from '../auth/middleware.js';
import { toApiFailure, toValidationFailure } from '../api/errors.js';
import { presentSchedule } from '../api/present.js';
import { withRequestContext } from '../auth/context.js';
import type { AppEnv } from '../app.js';
import type { Auth } from '../auth/auth.js';
import type { Clock } from '../app.js';
import type { Command } from '@ambitime/shared';

/**
 * The write path, over HTTP (spec §3.2, §7).
 *
 * **One endpoint.** The plan says "routes for each command", and one route is
 * the reading I went with: the vocabulary is a discriminated union already, so
 * a single body type gives a client the same narrowing eighteen routes would,
 * and it makes the architecture's hard rule visible in the route table rather
 * than asserted in a comment. There is exactly one way to change anything, and
 * you can see that there is.
 *
 * The envelope is completed here, not by the caller. `actor` and `tenant_id`
 * come from the session (§10.1) and `issued_at` from the server clock; a body
 * that could set either would be a body that could choose whose data to touch,
 * or which moment to schedule against.
 */
export function commandRoutes(auth: Auth, clock: Clock) {
  return new Hono<AppEnv>().post(
    '/commands',
    requireContext(auth),
    zValidator('json', commandRequestSchema, (result, c) => {
      if (!result.success) {
        const failure = toValidationFailure(result.error);
        return c.json(failure.body, failure.status);
      }
      return undefined;
    }),
    async (c) => {
      const context = c.get('context');
      const body = c.req.valid('json');

      const { id, ...draft } = body;

      // The id is the caller's, and has to be: it is the log's primary key
      // (§7.1), so honouring it is what makes a retry of a request whose
      // response was lost safe to send. `issued_at` is the server's, from the
      // one clock — see the note above.
      const command = newCommand(
        {
          ...draft,
          actor: context.userId,
          tenantId: context.tenantId,
        } as Parameters<typeof newCommand>[0],
        { issuedAt: clock().toISOString(), ...(id === undefined ? {} : { id }) },
      ) as Command;

      try {
        const outcome = await applyCommand(c.get('db'), command);

        // Presented inside a context of its own: `applyCommand`'s transaction
        // has committed, and the titles the blocks carry are as subject to RLS
        // as everything else the caller may read.
        const schedules = await withRequestContext(c.get('db'), context, async (tx) =>
          Promise.all(outcome.schedules.map((schedule) => presentSchedule({ tx, schedule }))),
        );

        const result: CommandResult = {
          commandId: outcome.command.id,
          seq: outcome.seq.toString(),
          schedules,
          created: outcome.created,
          attention: outcome.attention,
        };

        return c.json(result, 200);
      } catch (error) {
        const failure = toApiFailure(error);
        return c.json(failure.body, failure.status);
      }
    },
  );
}

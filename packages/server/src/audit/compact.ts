import { sql } from 'drizzle-orm';
import { UNDO_HISTORY_DEPTH } from '../commands/tuning.js';
import type { Transaction } from '../db/client.js';

/**
 * Dropping the row images undo can no longer reach (spec §12).
 *
 * A command's `inverse` carries two unrelated things. One is the journal —
 * a before-and-after image of every source row the command touched — which
 * exists so undo can put them back. The other is a handful of facts the audit
 * view reads: which calendars the command touched, and how many tasks it moved.
 * The first is by far the larger; on a real log it is the great majority of
 * every row.
 *
 * Only the first has an expiry. `readHistory` reads at most
 * `UNDO_HISTORY_DEPTH` of an actor's commands, newest first, so a command that
 * has fallen past that window is one no press of undo can ever reach again —
 * and the images it is still carrying are being kept for a reader that will
 * never ask. This drops them and keeps the rest, which is why the audit view
 * reads exactly the same after a pass as before it.
 *
 * **This is not retention.** `pruneAudit` deletes log entries and takes the
 * history of what was done with them; this keeps every entry and every
 * question the audit view asks of it, and gives up only the ability to reverse
 * something that was already past reversing. An installation wanting the log
 * smaller still than this is choosing to forget, and should say so by setting
 * a retention window.
 */
export async function compactJournals(
  tx: Transaction,
  depth: number = UNDO_HISTORY_DEPTH,
): Promise<number> {
  const stripped = await tx.execute<{ id: string }>(sql`
    WITH boundary AS (
      SELECT actor_id, seq
        FROM (SELECT actor_id,
                     seq,
                     row_number() OVER (PARTITION BY actor_id ORDER BY seq DESC) AS depth
                FROM commands) ranked
       WHERE depth = ${depth}
    )
    UPDATE commands c
       SET inverse = (c.inverse - 'changes') || '{"stripped": true}'::jsonb
      FROM boundary b
     WHERE c.actor_id = b.actor_id
       AND c.seq < b.seq
       AND jsonb_exists(c.inverse, 'changes')
    RETURNING c.id
  `);

  return stripped.length;
}

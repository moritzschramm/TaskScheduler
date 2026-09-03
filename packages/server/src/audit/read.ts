import { desc, eq, lt, sql } from 'drizzle-orm';
import { commands, users } from '../db/schema/index.js';
import type { AuditEntry } from '@ambitime/shared';
import type { Transaction } from '../db/client.js';

/**
 * The audit view (spec §12) — a read over the command log, not a second store.
 *
 * "One append-only command log serves all three: undo/redo, history, and audit
 * — the same log, with configurable retention." Undo already folds this log
 * into stacks; this reads it flat, which is the whole difference between them.
 *
 * Paged on `seq` rather than on a timestamp. `issued_at` comes from the
 * client's envelope and two commands can share one; `seq` is a `bigserial` and
 * is the only strict total order the log has, so it is the only cursor that
 * cannot skip or repeat an entry.
 *
 * RLS scopes it to the tenant. Within a tenant it is deliberately *not* scoped
 * to the actor: seeing who changed what is the point of an audit, and §10.2's
 * coarse RBAC is the lever for narrowing it later.
 */
export const AUDIT_PAGE_SIZE = 50;

export interface AuditQuery {
  /** Return entries strictly before this `seq`. Absent starts at the newest. */
  before?: string;
  limit?: number;
}

export async function readAudit(
  tx: Transaction,
  { before, limit = AUDIT_PAGE_SIZE }: AuditQuery = {},
): Promise<{ entries: AuditEntry[]; nextCursor: string | null }> {
  const rows = await tx
    .select({
      id: commands.id,
      seq: commands.seq,
      type: commands.type,
      actorId: commands.actorId,
      actorEmail: users.email,
      params: commands.params,
      groupId: commands.groupId,
      inverse: commands.inverse,
      issuedAt: commands.issuedAt,
    })
    .from(commands)
    .leftJoin(users, eq(users.id, commands.actorId))
    .where(before === undefined ? undefined : lt(commands.seq, BigInt(before)))
    .orderBy(desc(commands.seq))
    // One more than asked for, so "is there another page" needs no count.
    .limit(limit + 1);

  const page = rows.slice(0, limit);

  return {
    entries: page.map((row) => {
      const inverse = (row.inverse ?? {}) as { affectedTasks?: number; calendarIds?: string[] };

      return {
        id: row.id,
        seq: row.seq.toString(),
        type: row.type,
        actorId: row.actorId,
        actorEmail: row.actorEmail,
        params: row.params,
        groupId: row.groupId,
        // Counted at write time rather than derived here: the row images say
        // what the command wrote, and the question is what it *moved*, which
        // only the pipeline that re-derived the schedule was ever able to see.
        affectedTasks: inverse.affectedTasks ?? null,
        calendarIds: inverse.calendarIds ?? [],
        issuedAt: new Date(row.issuedAt).toISOString(),
      };
    }),
    nextCursor: rows.length > limit ? (page[page.length - 1]?.seq.toString() ?? null) : null,
  };
}

/**
 * Deletes log entries past the retention window (spec §12's "configurable
 * retention").
 *
 * Runs on the system path: retention is an operator's decision about the whole
 * installation, not a tenant's about itself.
 *
 * **Undo is bounded by this.** A command whose entry has been pruned cannot be
 * reversed, because the row images went with it. That is the honest consequence
 * of a retention policy rather than a bug, and it is why the default is to keep
 * everything: an installation that sets a window is choosing to trade
 * reversibility for storage, and should do so knowingly.
 */
export async function pruneAudit(
  tx: Transaction,
  retentionDays: number,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60_000).toISOString();

  const pruned = await tx
    .delete(commands)
    .where(sql`${commands.issuedAt} < ${cutoff}`)
    .returning({ id: commands.id });

  return pruned.length;
}

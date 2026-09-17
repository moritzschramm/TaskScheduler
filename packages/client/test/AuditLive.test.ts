import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '@ambitime/shared';
import AuditView from '@/views/AuditView.vue';
import { resetWorkspace, useWorkspace } from '@/lib/workspace';

/**
 * The history moves while you are watching it (spec §7.5, §12).
 *
 * Undo and redo sit in the shell, so they are reachable from the history page
 * itself — and pressing one appended a row the table then declined to show.
 * Nothing was wrong underneath; a reload produced the `Undo`, in the right
 * place, with the right time on it. But a history that stands still while
 * somebody is issuing commands at it is a history they stop believing, and §12
 * asks this table to be the record they check when they are unsure.
 */

const UUID = '01a0b102-761f-74eb-82f3-9c6bfa3ef2a0';

function entry(type: string, seq: string): AuditEntry {
  return {
    id: `01a0b102-761f-74eb-82f3-9c6bfa3ef2a${seq.padStart(1, '0')}`,
    seq,
    type,
    actorId: UUID,
    actorEmail: 'someone@example.test',
    params: {},
    groupId: null,
    affectedTasks: 1,
    calendarIds: [],
    issuedAt: '2026-03-23T08:00:00.000Z',
  };
}

/** What the next `/api/audit` read will answer with, and how many there were. */
let page: AuditEntry[] = [];
let audited: string[] = [];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  page = [entry('CreateTask', '1')];
  audited = [];
  resetWorkspace();

  vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

    if (url.includes('/api/audit')) {
      audited.push(url);
      return json({ entries: page, nextCursor: null, retentionDays: null });
    }
    if (url.includes('/api/history')) {
      return json({ undoable: ['CreateTask'], redoable: null, truncated: false });
    }
    return json({});
  });
});

afterEach(() => {
  // Unmounted, not left behind: the watcher is on a module-scope ref, so a
  // view from an earlier test goes on answering the next test's reads.
  for (const wrapper of open) wrapper.unmount();
  open.length = 0;
  vi.unstubAllGlobals();
  resetWorkspace();
});

const open: ReturnType<typeof mount>[] = [];

async function auditView() {
  const wrapper = mount(AuditView, { global: { stubs: { RouterLink: true } } });
  open.push(wrapper);
  await flushPromises();
  return wrapper;
}

const rowTypes = (wrapper: Awaited<ReturnType<typeof auditView>>) =>
  wrapper.findAll('[data-testid="audit-row"]').map((row) => row.attributes('data-type'));

describe('the audit table', () => {
  it('reads the log once when it opens', async () => {
    expect(rowTypes(await auditView())).toEqual(['CreateTask']);
    expect(audited).toHaveLength(1);
  });

  it('re-reads when a command is applied from the same page', async () => {
    const wrapper = await auditView();
    const { refreshHistory } = useWorkspace();

    // The shell's own first read, which this page has already made for itself.
    await refreshHistory();
    await flushPromises();
    expect(audited).toHaveLength(1);

    // Now somebody presses undo. The stacks move, and so does the table.
    page = [entry('Undo', '2'), entry('CreateTask', '1')];
    await refreshHistory();
    await flushPromises();

    expect(audited).toHaveLength(2);
    expect(rowTypes(wrapper)).toEqual(['Undo', 'CreateTask']);
  });

  it('comes back to the newest page rather than appending to the oldest', async () => {
    // Paging is a cursor into what is *below* the top; splicing new entries
    // into a list somebody had already paged through would put two orderings
    // in one table.
    const wrapper = await auditView();
    const { refreshHistory } = useWorkspace();
    await refreshHistory();
    await flushPromises();

    page = [entry('Undo', '2')];
    await refreshHistory();
    await flushPromises();

    expect(rowTypes(wrapper)).toEqual(['Undo']);
    expect(audited.at(-1)).not.toContain('before=');
  });
});

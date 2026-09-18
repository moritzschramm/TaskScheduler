import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { withTenantContext } from '../src/db/context.js';
import { readCalendarTaskTree, readTaskSubtree } from '../src/tasks/task-tree.js';
import type { TaskTreeNode } from '../src/tasks/task-tree.js';
import type { DatabaseHandle } from '../src/db/client.js';
import { addMember, createWorkTenant, registerUser } from './support/fixtures.js';
import { createCalendar, createActivityType, createTask } from './support/scheduling-fixtures.js';
import { resetDomainTables, setupTestDatabase } from './support/database.js';

/**
 * The recursive-CTE read (spec §5.3) and the inheritance rule it resolves
 * (§4.4): properties set on any node are inherited by descendants,
 * nearest-ancestor-wins, and only leaves are placed.
 */
describe('task tree read', () => {
  let handle: DatabaseHandle;
  let tenantId: string;
  let userId: string;
  let calendarId: string;
  let workActivityType: string;
  let homeActivityType: string;

  // Root ─ Design ─ Wireframes
  //      │        └ Mockups
  //      └ Build  ─ API
  let root: string;
  let design: string;
  let wireframes: string;
  let mockups: string;
  let build: string;
  let api: string;

  const byId = (nodes: TaskTreeNode[], id: string): TaskTreeNode => {
    const found = nodes.find((n) => n.id === id);
    if (!found) throw new Error(`Task ${id} missing from the tree`);
    return found;
  };

  beforeAll(async () => {
    handle = await setupTestDatabase();
  });

  afterAll(async () => {
    await handle?.close();
  });

  beforeEach(async () => {
    await resetDomainTables(handle);
    userId = (await registerUser(handle.db, { email: 'planner@example.com' })).userId;
    tenantId = await createWorkTenant(handle.db, 'Work');
    await addMember(handle.db, tenantId, userId, 'owner');
    calendarId = await createCalendar(handle.db, tenantId, userId);
    workActivityType = await createActivityType(handle.db, tenantId, 'Work', 15);
    homeActivityType = await createActivityType(handle.db, tenantId, 'Home', 5);

    const base = { tenantId, calendarId, ownerId: userId };

    root = await createTask(handle.db, {
      ...base,
      title: 'Launch',
      activityTypeId: workActivityType,
      priority: 3,
      dueDate: '2026-05-01T12:00:00Z',
      dueKind: 'hard',
      focusLevel: 4,
      cooldownOverrideMin: 20,
    });
    design = await createTask(handle.db, { ...base, title: 'Design', parentId: root });
    wireframes = await createTask(handle.db, {
      ...base,
      title: 'Wireframes',
      parentId: design,
      estimatedDurationMin: 90,
    });
    mockups = await createTask(handle.db, {
      ...base,
      title: 'Mockups',
      parentId: design,
      // Local overrides: nearer ancestor wins over the root's values.
      priority: 1,
      dueDate: '2026-04-20T12:00:00Z',
      dueKind: 'soft',
      estimatedDurationMin: 120,
    });
    build = await createTask(handle.db, {
      ...base,
      title: 'Build',
      parentId: root,
      activityTypeId: homeActivityType,
    });
    api = await createTask(handle.db, {
      ...base,
      title: 'API',
      parentId: build,
      estimatedDurationMin: 240,
    });
  });

  const readTree = () =>
    withTenantContext(handle.db, { userId, tenantId }, (tx) =>
      readCalendarTaskTree(tx, calendarId),
    );

  it('returns the whole forest with parents before their children', async () => {
    const nodes = await readTree();

    expect(nodes).toHaveLength(6);
    const order = nodes.map((n) => n.title);
    expect(order.indexOf('Launch')).toBeLessThan(order.indexOf('Design'));
    expect(order.indexOf('Design')).toBeLessThan(order.indexOf('Wireframes'));
    expect(order.indexOf('Build')).toBeLessThan(order.indexOf('API'));
  });

  it('reports depth and materialised path', async () => {
    const nodes = await readTree();

    expect(byId(nodes, root).depth).toBe(1);
    expect(byId(nodes, wireframes).depth).toBe(3);
    expect(byId(nodes, wireframes).path).toEqual([root, design, wireframes]);
  });

  it('marks only childless tasks as leaves', async () => {
    // Only leaves are placed by the scheduler (spec §4.4).
    const nodes = await readTree();

    expect(byId(nodes, root).isLeaf).toBe(false);
    expect(byId(nodes, design).isLeaf).toBe(false);
    expect(byId(nodes, wireframes).isLeaf).toBe(true);
    expect(byId(nodes, api).isLeaf).toBe(true);
  });

  it('inherits properties from the nearest ancestor that sets them', async () => {
    const nodes = await readTree();

    // Wireframes sets nothing, so everything comes from the root two levels up.
    const w = byId(nodes, wireframes);
    expect(w.ownPriority).toBeNull();
    expect(w.effectivePriority).toBe(3);
    expect(w.effectiveActivityTypeId).toBe(workActivityType);
    expect(w.effectiveFocusLevel).toBe(4);
    expect(w.effectiveCooldownOverrideMin).toBe(20);
    expect(w.effectiveDueDate).toContain('2026-05-01');
    expect(w.effectiveDueKind).toBe('hard');
  });

  it('lets a nearer ancestor override a further one', async () => {
    const nodes = await readTree();

    // Build re-categorises its branch; API inherits Home, not the root's Work.
    expect(byId(nodes, build).effectiveActivityTypeId).toBe(homeActivityType);
    expect(byId(nodes, api).effectiveActivityTypeId).toBe(homeActivityType);
    expect(byId(nodes, wireframes).effectiveActivityTypeId).toBe(workActivityType);
  });

  it('keeps own and effective values distinguishable', async () => {
    // What the UI needs to show "inherited" versus "overridden here" (M11).
    const nodes = await readTree();

    const m = byId(nodes, mockups);
    expect(m.ownPriority).toBe(1);
    expect(m.effectivePriority).toBe(1);
    expect(m.ownActivityTypeId).toBeNull();
    expect(m.effectiveActivityTypeId).toBe(workActivityType);
  });

  it('inherits due date and due kind together', async () => {
    // A kind belongs to the date it qualifies; inheriting one without the other
    // would leave a due date whose enforcement is undefined.
    const nodes = await readTree();

    const m = byId(nodes, mockups);
    expect(m.effectiveDueDate).toContain('2026-04-20');
    expect(m.effectiveDueKind).toBe('soft');

    const w = byId(nodes, wireframes);
    expect(w.effectiveDueDate).toContain('2026-05-01');
    expect(w.effectiveDueKind).toBe('hard');
  });

  it('reads a subtree seeded with what its root inherits', async () => {
    const nodes = await withTenantContext(handle.db, { userId, tenantId }, (tx) =>
      readTaskSubtree(tx, design),
    );

    expect(nodes.map((n) => n.title).sort()).toEqual(['Design', 'Mockups', 'Wireframes']);

    // Design sets no priority of its own; without the ancestor seed this would
    // come back null and disagree with the full-tree read.
    expect(byId(nodes, design).effectivePriority).toBe(3);
    expect(byId(nodes, wireframes).effectivePriority).toBe(3);
    expect(byId(nodes, mockups).effectivePriority).toBe(1);
  });

  it('agrees with the full-tree read for the same nodes', async () => {
    const full = await readTree();
    const subtree = await withTenantContext(handle.db, { userId, tenantId }, (tx) =>
      readTaskSubtree(tx, design),
    );

    for (const node of subtree) {
      expect(node).toEqual(byId(full, node.id));
    }
  });

  it('is scoped by RLS to the active tenant', async () => {
    // The read runs inside the caller's transaction, so a foreign calendar id
    // resolves to nothing rather than leaking.
    const otherUser = (await registerUser(handle.db, { email: 'other@example.com' })).userId;
    const otherTenant = await createWorkTenant(handle.db, 'Other');
    await addMember(handle.db, otherTenant, otherUser, 'owner');

    const nodes = await withTenantContext(
      handle.db,
      { userId: otherUser, tenantId: otherTenant },
      (tx) => readCalendarTaskTree(tx, calendarId),
    );

    expect(nodes).toEqual([]);
  });
});

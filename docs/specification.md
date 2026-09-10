# Software Specification

**Version:** 0.1 (draft)
**Status:** Design complete for v1; forward-looking items marked as designed-for-but-deferred.
**Purpose:** A calendar application that automatically schedules tasks into user-defined time windows, manages conflicts against fixed appointments, and reflows the schedule when disruptions occur.

This document is written to be handed to an implementation agent (e.g. Claude Code). It fixes the decisions made during design and defines the parameters left open for tuning. Terms in **bold** on first use are defined in the Glossary (§16).

---

## 1. Overview

Ambitime (name might change) lets a user define, per weekday (with overrides for special weeks such as holidays), time windows for categories of activity (work, exercise, wellness, household, etc.). Tasks belong to a category, carry an estimated duration, and are placed automatically into that category's windows. Fixed appointments (e.g. a dentist visit) are immovable and tasks schedule around them. When the user is disrupted (sick, a task overruns, a preference changes), the affected part of the schedule is cleared and reflowed into the next fitting slots.

The core of the product is a deterministic scheduling engine operating over a bounded near-term horizon, with everything beyond that horizon held in a coarse weekly backlog.

---

## 2. Scope

### 2.1 In scope for v1

- Single-user experience, desktop web client.
- **Multi-tenant data model from day one** (shared schema, `tenant_id`, row-level security), even though team/group UI is deferred. This avoids an expensive retrofit.
- Categories, per-weekday **availability windows**, and week-type overrides for special periods.
- Tasks: hierarchical (depth ≤ 5, leaf-only placement, inherited-editable properties), estimated duration, optional priority, optional due date (soft or hard), optional preferred time range / focus, per-task cooldown override, per-period recurrence, sequence membership, backlog placement with estimated week.
- Appointments: fixed in time, RRULE recurrence, participant records and status (modeled now for future internal-appointment negotiation).
- **Uninterruptible sequences** (task sets scheduled contiguously).
- Cooldowns (per-category default, per-task override, non-compressible).
- Two-week hard horizon + coarse weekly planning beyond + backlog.
- Capacity / overcommitment detection and deferral tracking.
- Command layer as the single write path; undo, history, and a lightweight audit log built on it.
- Notifications: in-app when online, email when offline (presence via last-seen heartbeat); `pg-boss` job queue.
- Internationalization and user settings.

### 2.2 Designed-for but deferred

The data model and interfaces must accommodate these without redesign:

- Team/group UI and **internal-appointment** change negotiation (participant + status records exist now).
- External calendar sync (Google, Outlook, CalDAV); iCalendar import/export.
- Real-time updates (WebSocket / SSE).
- Offline / PWA.
- Natural-language (speech/text) command interface (the command layer is the seam).
- Native mobile client.
- Dedicated fine-grained authorization engine (ReBAC); resources carry owner + visibility scope now so the migration is additive.
- Full audit tooling; cross-context co-optimization.

---

## 3. Architecture

### 3.1 Stack

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript, front and back | Enables the isomorphic scheduler (§3.3). |
| Server | Hono | RPC mode for typed client/server contract. |
| Client | Vue | Desktop web. |
| Validation | Zod | Schemas shared client/server; types and validation derive from one source. |
| DB | PostgreSQL | Range types, exclusion constraints, recursive CTEs, RLS (§5). |
| Query layer | Drizzle | Thin, SQL-transparent, does not obstruct advanced Postgres features. |
| Migrations | Drizzle Kit | |
| Auth | Better Auth | Self-hosted, organization + SSO plugins (§10). |
| Jobs | pg-boss | Postgres-backed; avoids adding Redis. |
| Web server | nginx | Reverse proxy. |
| Packaging | Docker | Dev and prod images. |
| Repo | pnpm workspaces (optional Turborepo) | Shared package for types + Zod + scheduler. |

### 3.2 Single write path — the command layer

All mutations to source state flow through **commands**: named, parameterized, serializable intent objects (§7). This is a hard architectural rule with four payoffs collapsed into one mechanism:

1. **Derived state** (§3.4) — commands mutate source; schedule is recomputed.
2. **Undo / history** (§12) — commands are logged append-only; undo reverses a command.
3. **Audit** (§12) — the same log is the audit trail.
4. **Future NL interface** (§2.2) — GUI actions and a future NL parser both emit commands; nothing else can write.

GUI actions map to commands 1:1. No code path mutates source state except by applying a command.

### 3.3 Isomorphic scheduler

The scheduling engine is a **pure function** of its inputs, packaged in the shared workspace package and run in two places:

- **Client** — computes an optimistic proposed schedule for instant feedback.
- **Server** — authoritative. Applies the command to source, re-derives (deterministic, cheap over a two-week horizon), persists the placement cache, and returns it. The client reconciles; because both run the identical module deterministically, results match.

**No WASM.** Plain TypeScript. A greedy heuristic over tens–low-hundreds of tasks runs in single-digit milliseconds; WASM would add a toolchain, a serialization boundary, and forfeit code sharing for no measured gain. Revisit only if profiling at realistic volume proves the JS solver too slow (unlikely; the local-search phase, if added, would be the first target).

**Server role for shared resources.** For single-user private tasks, server re-derivation is sufficient. Once shared resources exist (team meetings, others' free/busy), the server must additionally **validate the proposed schedule against current persisted state inside a transaction with optimistic locking** (§5.4), because the world can change between client computation and commit. Validation checks hard invariants (§6.2) on the proposed placement — order-independent and cheap — rather than naively recomputing and comparing.

### 3.4 Derived schedule state

The concrete minute-level schedule is **derived**, not authoritative.

- **Authoritative source** = source entities (tasks, appointments, windows, rules) + scheduling metadata (manual floors, defer counters, manual biases) + the command log.
- **Placement cache** = the materialized schedule for the hard horizon. Persisted as a read cache and as the baseline for change detection (to tell a user or counterparty what moved). Recomputed when source changes; may be recomputed client-side optimistically.

A manual edit modifies source constraints; it does **not** freeze an assignment. This is why "manually changed tasks are delayed, not fixed" holds: a repositioned task carries a soft floor and bias (§7.3), and a later re-solve respects those but may still move it.

---

## 4. Domain model

### 4.1 Identity (global)

- **User** — one per human; the global authentication principal. Not tenant-scoped.
- **EmailIdentity** — email → User (many-to-one), one marked primary. Satisfies multiple-emails-per-user.

### 4.2 Tenancy

- **Tenant** — the isolation boundary; every scheduling row carries `tenant_id` and is RLS-protected (§5.2). Each User has a **personal tenant** for private data and may belong to work tenants. Maps to the Better Auth *organization*.
- **Membership** — User ↔ Tenant, with role (`owner` / `admin` / `member`).
- **Group** — tenant-scoped; contains multiple teams.
- **Team** — tenant-scoped; belongs to zero-or-more groups.
- **TeamMembership** — User ↔ Team. A user may be in multiple teams and groups.

### 4.3 Scheduling entities (tenant-scoped)

- **Calendar** (a scheduling *context*) — owned by a User within a Tenant; a user may own several. Carries a **visibility scope** (`private` / `team` / `group`), a **working window**, and a **shareable window** (§9). The engine operates over the union of Calendars a user can access.
- **Category** — e.g. work, exercise, wellness, household. Owns default cooldown and the set of availability windows for its kind of activity.
- **AvailabilityWindow** — a per-weekday time range for a Category within a Calendar (recurring availability).
- **WeekTypeOverride** — replaces the default window set for a date range (holidays, special weeks).
- **Task** — schedulable unit (§4.4).
- **Appointment** — fixed in time (§4.5).
- **AppointmentParticipant** — User ↔ Appointment with status (`proposed` / `confirmed` / `change_requested`); present now for future negotiation.
- **Sequence** — an uninterruptible block grouping member tasks (§6.4).
- **TaskOccurrence** — a per-period demand instance for a recurring task (§8.2).
- **Placement** — a derived concrete assignment `(occurrence → [start, end) on a date)` in the hard horizon; the read cache (§3.4).
- **Command** — append-only mutation record (§12).
- **Notification** — user-facing message (§11).

### 4.4 Task properties

| Property | Notes |
|---|---|
| `category_id` | Determines which windows are eligible. |
| `parent_id` | Adjacency list; depth ≤ 5 (hard cap). |
| `estimated_duration_min` | v1: user-estimated only. No actuals tracking yet. |
| `priority` | Optional; soft constraint. |
| `due_date` + `due_kind` | `due_kind ∈ {soft, hard}`. Hard is enforced (§6.2); soft warns (§6.5). |
| `preferred_range` / `focus_level` | Optional; soft. Matched against slot / window focus profile. |
| `cooldown_override_min` | Optional; overrides category default. Non-compressible. |
| `sequence_id` | Optional membership in an uninterruptible block. |
| `recurrence` | Optional per-period demand rule (§8.2). |
| `manual_floor` | Set by a manual reposition; soft not-before (§7.3). |
| `manual_bias` | Preferred datetime from a manual reposition. |
| `estimated_week` | For backlog tasks beyond the hard horizon. |
| `defer_count`, `last_defer_reason`, `last_defer_at` | Deferral tracking (§6.6). |
| `status` | `active` / `completed` / `cancelled`. |
| `version`, `updated_at` | Optimistic locking (§5.4). |

**Inheritance.** Priority, due date, preferred range/focus, category, and cooldown may be set on any node and **inherited by descendants, nearest-ancestor-wins**. Setting a value locally creates an override; clearing it reverts to inherited. Only **leaf tasks are placed**; a parent's duration and completion roll up from its leaves.

**Due-date constraint.** A child's effective due date must be ≤ its inherited/effective parent due date (a subtask cannot be due after its container). Enforced as a data constraint.

### 4.5 Appointment properties

Fixed `[start, end)`; `recurrence` as RRULE (§8.1); `is_internal` (all participants are app users) vs external; participants (§4.3); status. Internal appointments participate in cross-user change notification (§7.2); external appointments are the user's responsibility to renegotiate.

---

## 5. Persistence

### 5.1 Conventions

- **Intervals are half-open** `[start, end)` everywhere; a 09:00–10:00 event and a 10:00–11:00 event do not conflict.
- **Instants stored as `timestamptz` (UTC).**
- **Recurrence rules store an explicit timezone.** "Every weekday 09:00" is a wall-clock rule; DST shifts the underlying instant, so the timezone must travel with the rule, not be inferred from a stored offset.
- **Time granularity is minutes** internally. The UI drag grid snaps to 15-minute blocks with a text field for exact minutes (§13).
- **IDs: UUID v7** (time-ordered) — aids index locality and deterministic tie-breaks (§6.3).

### 5.2 Multi-tenancy

Shared schema; every scheduling table carries `tenant_id`; **Postgres row-level security** filters by the tenant context set per request. The application, acting as the authenticated user, issues one RLS-scoped read per context the user belongs to and merges results in the engine — no cross-tenant bypass; each read runs in an authorized context (§9.3).

### 5.3 Postgres features to use

- **`tstzrange`** for every appointment's span, so overlap questions are asked of the database in one operator.
  Amended after v1 design: appointments **may** overlap one another, and the GiST exclusion constraint that
  forbade it was dropped (migration 0016). A diary has to be able to hold a conference with sessions inside it
  or a call taken on a train, and refusing those made ordinary weeks unrecordable. §6.2 rule 2 is unchanged:
  nothing the scheduler *places* may overlap a fixed block.
- **Recursive CTEs** for the task tree (depth ≤ 5 makes an adjacency list sufficient; `ltree` / closure tables are unnecessary).
- **RLS** for tenant isolation and the user boundary.

### 5.4 Concurrency

Every mutable entity carries `version` (integer) and `updated_at`. Commands carry the expected version; the server rejects on mismatch (optimistic locking). Shared-resource commits validate against current state within a transaction (§3.3).

---

## 6. Scheduling engine

### 6.1 Horizon model

- **Hard horizon = current week + next week.** Tasks here are placed to specific datetimes.
- **Beyond the horizon = coarse weekly planning.** Tasks sit in the **backlog** with an `estimated_week`, displayed as "likely week X," not a specific date. The coarse planner is the same algorithm at week granularity: bin-pack remaining tasks into future weeks by capacity (§6.6) and due date.
- **Rationale:** bounds solver cost; matches reality (much changes within two weeks; later tasks are re-planned regardless).
- **Promotion trigger:** a backlog task materializes into concrete slots (a) at week rollover via a scheduled job, and (b) on demand when the user opens the next week.

### 6.2 Hard constraints (validator-enforced; a schedule violating any is invalid)

1. A task is placed within an availability window of its category (respecting week-type overrides).
2. No overlap between any two placements the user views as unified (task–task, task–appointment). Appointments are fixed.
3. The task's cooldown (non-compressible) is reserved after it; treated as part of its footprint for overlap.
4. `hard` due date: placement end ≤ due date.
5. Sequence contiguity: members of an uninterruptible sequence are placed contiguously within a single window, in order if ordered, with no foreign task interleaved.
6. Manual floor: a manually repositioned task is not placed before its `manual_floor`.
7. Depth ≤ 5; child effective due date ≤ inherited parent due date (data constraints).

### 6.3 Determinism

Determinism is a hard requirement.

- `now` is an explicit input; no wall-clock reads or randomness inside the solve.
- All reads are ordered; every tie breaks by a total order ending in entity id.
- Ordering uses integer-minute arithmetic; floating-point values never participate in comparisons that decide placement.

### 6.4 Soft constraints (scored; may be violated)

Priority; preferred-time / focus match; earliness / buffer before due date; fragmentation minimization (tight packing); soft due-date targets; manual-reposition bias.

### 6.5 Scoring policy

**Modular by design.** The engine exposes a `ScoringPolicy` interface: a set of **named term functions** each returning a normalized `[0,1]` contribution, plus a **weight vector**, selected by configuration. Terms and weights are swappable without touching the solver, so alternative structures and weightings can be trialed during development. The draft below is the default policy, to be tuned.

**Stage 1 — placement order** (which task picks first). Descending `order_score`:

```
order_score = 0.5·U + 0.3·P + 0.2·C
```

- `U` (urgency): from `slack = due − (now + duration)`; `U = 1 / (1 + max(0, slack_hours))`. Past/near-due → ≈1; ample slack → ≈0; no due date → 0.
- `P` (priority): user value normalized to `[0,1]`.
- `C` (constrainedness, most-constrained-first): `duration / feasible_window_minutes_in_category_over_horizon`, clamped `[0,1]`.
- Tie-break: earlier due date → higher priority → smaller id.

**Stage 2 — slot selection** (given a task, among slots passing all hard filters). Descending `slot_score`:

```
slot_score = 0.5·Pr + 0.2·E − 0.3·F
```

- `Pr` (preferred match): fraction of the placement within the preferred range / focus profile; 0 if no preference.
- `E` (earliness): `1 − (slot_start − horizon_start) / horizon_length`; a mild pull toward buffer.
- `F` (fragmentation): penalty for leaving small unusable gaps; slots flush to a window edge or an existing block score higher (tight packing).
- Tie-break: earliest start → smallest id.

**Post-placement due-date pass** (separate from scoring; guarantees the notification requirement). After placing the horizon, flag every task placed after its due date and every task that could not be placed in-horizon before its due date. `soft` → warning; `hard` → alert (§6.7, §11). This is independent of how scoring resolved.

Weights and normalization constants are the tuning surface (§15).

### 6.6 Capacity, overcommitment, and deferral tracking

**Capacity (draft, low priority).** Per `(category, week)`:

```
Supply = Σ window_minutes − Σ appointment_minutes_in_window − reserved_cooldown
Demand = Σ estimated_durations + cooldowns   (tasks assigned or due in that category/week)
Utilization = Demand / Supply
```

- `> 1.0` → overcommitted (some tasks will backlog); `0.85–1.0` → tight/fragile.
- **Contiguity check** for uninterruptible sequences: `max_contiguous_span(category, week) ≥ longest sequence block` — a category may hold enough total minutes yet no single span large enough.
- Surfaced as the backlog notification plus a per-category utilization indicator.

**Deferral tracking (distinct signal).** Separate from bulk reflow (e.g. the sick-day action), a task repeatedly postponed **by the user** is a distinct signal. Each task carries `defer_count` / `last_defer_reason`. Chronic postponement (e.g. deferred ≥ N times, or aging past its estimated week repeatedly) is surfaced as its own notification ("this task keeps getting pushed"), separate from capacity overcommitment. User-initiated deferrals and involuntary reflows are tracked distinctly.

### 6.7 Infeasibility behavior

A task that cannot be placed in the hard horizon before its due date goes to the **backlog** with an `estimated_week` and a diagnostic. If it carries a due date or hard constraint at risk, an **alert** is raised (not merely a passive backlog entry). Diagnostics name the reason (no feasible window, conflict with a fixed block, insufficient remaining capacity, no contiguous span for a sequence).

---

## 7. Commands (user actions / intent layer)

Commands are the single write path (§3.2) and the future NL surface. Each is a named, serializable object with parameters, a precondition, an effect, a re-derive scope, counterparty effects, and undoability. The GUI emits these directly; a future parser emits the same objects.

### 7.1 Command envelope

```
Command {
  id: uuid            // v7
  type: string        // e.g. "PostponeRestOfDay"
  actor: user_id
  tenant_id
  params: {...}       // typed per command
  expected_version?   // optimistic locking on the target
  issued_at
}
```

The server validates, applies to source, re-derives, persists the placement cache, appends the command to the log, and returns the new schedule + any diagnostics.

### 7.2 Bulk deferral family

- **`PostponeRestOfDay(calendar, date)`** — move all incomplete, not-yet-started task placements on `date` (from `now` forward) into subsequent days; re-derive the horizon (near-term tasks reflow). Appointments on the day: the user is notified; **external** appointments the user must renegotiate; **internal** appointments are moved to the next fitting slot and participants are notified, with the ability to request a manual change. (This covers the sick-day / "not today" case.)
- **`ClearWeek(calendar, week)`** — remove the week's task placements (e.g. vacation); tasks reflow into later weeks or the backlog. Same appointment rules.

### 7.3 Single-task manual actions

- **`MoveTask(task, datetime)`** — manual reposition. Sets `manual_floor = datetime` (soft not-before) and `manual_bias = datetime` (preferred), then re-derives. The task is **delayed, not fixed**: hard constraints or higher-precedence tasks may still move it, but never earlier than the floor. **Floor clears** on completion, on explicit user reset, or on a bulk reschedule (e.g. `PostponeRestOfDay`).
- **`DeferTask(task, target)`** where `target ∈ {tomorrow, next_week, backlog}` — remove the task's current placement and re-insert per target (`tomorrow` = next day's slots; `next_week` = coarse next-week plan; `backlog` = estimated-week). Increments `defer_count`. Sets nothing fixed.
- **`SwapTasks(taskA, taskB)`** — exchange time positions if each fits the other's constraints; otherwise fall back to `SwapForward` semantics below.
- **`SwapForward(task)`** — "I don't want to work on this now": defer `task` to its next feasible slot and pull the next feasible task into the vacated slot.
- **`CompleteTask(task, actual_end?)`** — mark done; free the slot and cooldown; clear any floor; re-derive the remainder of the day so downstream eligible tasks may use freed time (respecting floors).
- **`ExtendTask(task, new_estimate)`** — a task overran or the estimate changed; adjust duration; downstream reflows.
- **`PromoteFromBacklog(task)` / `MoveToBacklog(task)`** — cross the horizon boundary explicitly.
- **`CancelTask(task)`** — set `cancelled`; free its footprint; re-derive.

### 7.4 Ad-hoc blocks

- **`AddAppointment(...)`** — insert a fixed block (hard constraint); tasks reflow around it.
- **`AddUnavailability(calendar, [start,end))`** — a content-free hard block ("unavailable 14:00–16:00"); behaves like an appointment for scheduling.

### 7.5 Undo / redo

- **`Undo()` / `Redo()`** — reverse / replay the last command (or command group, for bulk actions, atomically), then re-derive. Backed by the command log (§12).

### 7.6 Additional scenarios the design must handle

These are consequences of the model, listed so implementation covers them: a task finishing early (`CompleteTask` with an earlier `actual_end`, pulling the day forward); an estimate proving wrong mid-day (`ExtendTask`); inserting an urgent same-day task (normal create → immediate re-derive within the horizon); changing a task's category (re-place within the new category's windows); and repeated small deferrals accumulating into the chronic-postponement signal (§6.6).

---

## 8. Recurrence — two engines

Recurrence for appointments and for tasks are **separate mechanisms sharing one UI concept**.

### 8.1 Appointment recurrence — datetime expansion

RRULE (RFC 5545) expansion with `EXDATE` and modified-occurrence exceptions. A recurring appointment is a template; each occurrence is a distinct instance that can be individually moved, cancelled, or completed. Editing exposes **"this occurrence only"** vs **"this and all future occurrences."**

### 8.2 Task recurrence — per-period demand generator

A recurring task is a **demand rule** ("exercise 3× per week"), not a datetime rule. Each period, the generator spawns a `TaskOccurrence` placed **flexibly** within its category by the scheduler. Occurrences inherit the parent task's properties.

**Missed-instance policy.** If a period's occurrence is not placed or not completed within the period: **default = rollover** as debt into the next period; **per-task configurable expiry**. (Example: a missed workout should not distort the next day's structure — configure expiry; a missed invoice should carry over — rollover.)

---

## 9. Visibility and multi-context

### 9.1 Two windows per calendar

- **Working window** — when the scheduler may place tasks for this calendar.
- **Shareable window** — what busy time is exposed to *other users*.

### 9.2 Free/busy exposure (between users)

Free/busy is the currency between **different users**, not between one user's own contexts.

- A calendar exposes free/busy to another user **clipped to its shareable window**. A private event entirely outside the shareable window produces **no** busy block for that viewer; a partially overlapping event is clipped to the intersection.
- **Operational definition of "serves a purpose":** a private block is exposed to a viewing context only if it falls within that context's shareable/working window — only there could it constrain that context's scheduling. Elsewhere it is hidden.
- **Hiding a personal task is the default.** Personal tasks are excluded from what any other-user relationship exposes, unless they fall within the shareable window, where they surface as opaque busy (no detail).
- Detail (beyond free/busy) is exposed only per the calendar's visibility scope (`team` / `group`) to members of that team/group.

### 9.3 Cross-context scheduling for one user

All of a single user's own calendars across tenants are data that user is authorized to read; the engine merges per-context RLS-scoped reads (§5.2) and may use full detail.

- **Default = conflict-avoidance:** each context schedules its own tasks, treating the other context's committed time as immovable busy. This preserves the separation the requirements emphasize.
- **Optional / future = co-optimization** in a single solve (feasible since it is the same user's data, but couples contexts more tightly).

### 9.4 Working-window divergence notice

If a user's working window diverges from their team's working window, notify the user. This requires storing both a per-user working window and the team working window and comparing them.

---

## 10. Authentication and authorization

### 10.1 Authentication (boilerplate — use it)

**Better Auth**, self-hosted against the app's Postgres, framework-agnostic (works with Hono), TS-native typed client.

- **organization plugin** → Tenant / Membership / roles (`owner` / `admin` / `member`).
- **SSO plugin** (OIDC + SAML 2.0), linked per-organization for the enterprise path (company domain → organization).
- 2FA / passkeys available as needed.

(Do not use Lucia — deprecated March 2025, now a learning resource — or Auth.js, which is Next-oriented and in maintenance.)

### 10.2 Authorization (mostly application-specific)

- **Coarse RBAC** via organization roles now.
- **Per-resource visibility** via `owner` + `visibility_scope` columns and predicate checks now. RLS enforces tenant isolation and the user boundary.
- **Fine-grained / relationship-based authorization** (hide specific tasks from a team, per-resource team/group sharing, membership in multiple teams, groups-contain-teams) role-explodes on RBAC. Introduce a ReBAC engine (**OpenFGA** default, or SpiceDB / Permify) **when** team/group sharing rules multiply. Because resources already carry owner + scope, this migration is additive rather than a rewrite.

---

## 11. Notifications and presence

- **Channels:** in-app when the user is online; email when offline.
- **Presence:** last-seen heartbeat determines online/offline (sufficient for v1).
- **Job queue:** `pg-boss` (Postgres-backed) drives reminders, the week-rollover promotion job (§6.1), asynchronous reschedules, and notification dispatch.
- **Notification types:** backlog additions (informational); due-date-at-risk on soft due dates (warning); hard-due-date or hard-constraint conflict (alert); chronic postponement (§6.6); internal-appointment change (to counterparties, §7.2); working-window divergence (§9.4).

---

## 12. Undo, history, and audit

One append-only **command log** serves all three:

- **Undo/redo** — reverse/replay the last command or atomic command group, then re-derive.
- **History** — a view over the log.
- **Audit** — the same log, with configurable retention. Built lightly now so a fuller implementation is easy later.

This is **not** full event-sourcing: mutable entity tables plus a reversible-change log are sufficient and lighter. Each command records enough to reverse it.

---

## 13. Internationalization and settings

- Date/time formatting, first-day-of-week, locale, and timezone are user settings.
- UI drag grid snaps to 15-minute blocks; a text field allows exact minutes.
- All display respects the user's timezone; storage remains UTC (§5.1).

---

## 14. Cross-cutting / non-functional

- **Scheduler testing:** the pure-function scheduler is covered by **property-based tests** (fast-check) asserting the invariants: no two placements overlap, every placement lies within its category window, cooldowns are respected, no hard due date is violated, sequence blocks are contiguous, and identical inputs yield identical output (determinism). Golden tests pin scoring outputs so weight changes are visible in diffs.
- **Accessibility:** target WCAG 2.2 AA. The calendar grid must be keyboard-navigable; every drag-and-drop action needs a keyboard-accessible equivalent (drag-drop is among the hardest calendar interactions to make accessible — design for it from the start).
- **Deployment:** Docker images for dev and prod; nginx reverse proxy; Drizzle Kit migrations; a defined Postgres backup strategy.
- **Security baselines:** parameterized queries (via Drizzle), CORS, XSS prevention in the Vue layer, rate limiting, and no personal/sensitive data in URLs or query strings.

---

## 15. Tuning surface (to verify during development)

Parameters expected to change; centralize them in configuration:

- Stage 1 weights `{U:0.5, P:0.3, C:0.2}` and the urgency normalization `1/(1+slack_hours)`.
- Stage 2 weights `{Pr:0.5, E:0.2, F:0.3}` and the fragmentation penalty definition.
- Priority → `[0,1]` mapping (number of levels and their values).
- Capacity thresholds (`>1.0`, `0.85–1.0`) and the capacity horizon (day / week / rolling).
- Chronic-postponement threshold `N` (§6.6).
- Default cooldown per category.
- Hard-horizon length (default two weeks) and the promotion trigger timing.
- The entire `ScoringPolicy` term structure is replaceable, not just its weights (§6.5).

---

## 16. Glossary

- **Availability window** — a per-weekday time range for a category within a calendar during which its tasks may be scheduled.
- **Backlog** — tasks beyond the hard horizon, held with an estimated week rather than a specific date.
- **Calendar / context** — a scheduling context owned by a user within a tenant, with a visibility scope and working/shareable windows.
- **Command** — a named, serializable intent object; the single write path.
- **Cooldown** — a non-compressible reserved gap after a task.
- **Hard horizon** — the current + next week, scheduled to specific datetimes.
- **Internal appointment** — an appointment whose participants are all app users (enables cross-user change notification).
- **Placement** — a derived concrete assignment of an occurrence to `[start, end)` on a date; the read cache.
- **Sequence** — an uninterruptible set of tasks scheduled contiguously.
- **Soft / hard constraint** — soft constraints are scored and may be violated; hard constraints are enforced and invalidate a schedule if broken.
- **Tenant** — the multi-tenancy isolation boundary (`tenant_id` + RLS); each user has a personal tenant plus work tenants.
- **Working window / shareable window** — when tasks may be placed / what busy time is exposed to other users.

---

*End of draft v0.1.*

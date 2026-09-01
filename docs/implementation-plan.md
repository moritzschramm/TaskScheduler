# Ambitime — Implementation Plan

**Companion to:** `specification.md` (the specification is the source of truth; this plan only sequences it).
**Format:** 17 milestones in 9 phases. Each milestone ends at a **STOP** gate for human code review.

---

## How to use this plan (operating brief for the implementing agent)

1. **The specification is authoritative.** This plan sequences it. On any conflict, the spec wins. If the spec is ambiguous or silent on something a milestone needs, **STOP and ask** — do not guess. This applies with extra force to the one-way-door milestones (M1, M2).
2. **One milestone per run.** Implement a single milestone, meet its Definition of Done, then **STOP**: post a summary (what changed, how to verify, any deviation from spec, follow-ups) and wait for explicit approval before starting the next.
3. **Split if too large.** If a milestone grows beyond one reviewable change during implementation, **STOP** and propose a split rather than proceeding.
4. **Preserve the deferred-feature seams, but do not build deferred features** (spec §2.2). The seams to keep intact throughout: the command layer as the *only* write path; every resource carrying `owner` + `visibility_scope`; appointment participant/status records; and the scheduler as a pure package. Building on these later must be additive, not a refactor.
5. **Keep the scheduler pure.** `packages/scheduler` must never import DB or HTTP code. Its inputs are plain data; its tests run with no infrastructure.
6. **Everything writes through a command.** No code path mutates source state except by applying a command (spec §3.2).
7. **Centralize tuning values** (spec §15) in configuration; never inline them.
8. **Commit granularly** within a milestone with clear messages.

---

## Global conventions (apply to every milestone)

- TypeScript strict mode throughout.
- Zod schemas live in the shared package and are imported by both client and server; types and validation derive from one source.
- Intervals are half-open `[start, end)` everywhere.
- Instants stored as `timestamptz` (UTC); recurrence rules store an explicit timezone (spec §5.1).
- Scheduler ordering uses integer-minute arithmetic; floating-point never decides placement.
- IDs are UUID v7.
- Every mutable entity has a `version` column; commands carry the expected version (optimistic locking).
- RLS tenant context is set per request (and per test) via a Postgres session setting; RLS policies read `current*setting('app.tenant*id')`.
- The scheduler is deterministic: `now` is an explicit input; no wall-clock reads or randomness in the solver.
- No WASM.

## Definition of Done (per-milestone gate)

A milestone is done only when: it builds clean; typecheck and lint pass; all tests are green including the milestone's required tests; no scope has bled beyond the milestone; the relevant spec invariants hold; and a written STOP summary has been posted (changes, verification steps, deviations, follow-ups). Then wait for approval.

---

## Milestone map

| # | Milestone | Phase | Flag |
|---|---|---|---|
| M0 | Project skeleton + walking skeleton | 0 Foundations | |
| M1 | Identity & tenancy schema + RLS | 1 Data & tenancy | **one-way door** |
| M2 | Scheduling-domain schema + constraints | 1 Data & tenancy | **one-way door** |
| M3 | Scheduler I — types, validator, determinism | 2 Scheduler core | **high risk** |
| M4 | Scheduler II — placement, scoring, horizon, backlog | 2 Scheduler core | **high risk** |
| M5 | Scheduler III — sequences, capacity, deferral signals | 2 Scheduler core | **high risk** |
| M6 | Command layer, derived state, persistence | 3 Write path | |
| M7 | Remaining commands + undo/redo | 3 Write path | |
| M8 | Authentication & tenant context | 4 Auth | |
| M9 | API layer (Hono RPC) | 5 API | |
| M10 | Client shell + read-only calendar | 6 Client | |
| M11 | CRUD + hierarchy + configuration UI | 6 Client | |
| M12 | Manual actions + optimistic client compute | 6 Client | |
| M13 | Surfacing: capacity, backlog, alerts, divergence | 6 Client | |
| M14 | Recurrence — two engines | 7 Recurrence | |
| M15 | Jobs, presence, notification delivery | 8 Jobs | |
| M16 | Cross-cutting: i18n, a11y, audit, hardening | 9 Hardening | |

**Sequencing rationale.** Tenancy is placed first as a one-way door and reviewed before anything builds on it. The scheduler is built headless and property-tested (M3–M5) before any wiring, front-loading the highest-risk component into infra-free reviews. The command/persistence layer (M6–M7) is testable over a test DB with an injected tenant context, before auth exists. Auth (M8) precedes the API (M9) so the API uses real context. The client is split into render → CRUD → interaction → surfacing. Recurrence (M14) and jobs (M15) layer onto a working core loop.

---

## Phase 0 — Foundations

### M0 — Project skeleton + walking skeleton
**Goal:** Repo, tooling, and a minimal end-to-end path all working, to derisk the toolchain in the first review.
**Depends on:** —
**In scope:**
- pnpm workspace with packages: `shared` (types + Zod), `scheduler` (empty pure package), `server` (Hono), `client` (Vue).
- Strict TS configs, ESLint, Prettier.
- Dockerfiles + `docker-compose` for postgres, server, client, nginx (reverse proxy).
- Drizzle wired with one trivial migration; a `/health` Hono endpoint that executes a real Postgres query.
- A Vue page that calls `/health` through nginx and renders the DB-connectivity result.
- CI running build, typecheck, lint, test.

**Out of scope:** Any domain logic, auth, real schema.
**Acceptance (you verify):** `docker compose up` brings up all services; the client page confirms DB connectivity via `/health`; CI is green.
**Tests required:** A smoke test hitting `/health`.
**Review focus:** Workspace layout, container/nginx wiring, CI config.
→ **STOP for review.**

---

## Phase 1 — Data & tenancy

### M1 — Identity & tenancy schema + RLS *(one-way door — review with extra care)*
**Goal:** Global identity and tenant isolation foundations.
**Depends on:** M0
**In scope:**
- Tables: `User` (global principal), `EmailIdentity` (email→User, one primary), `Tenant`, `Membership` (User↔Tenant, role owner/admin/member), `Group` (tenant-scoped), `Team` (tenant-scoped, belongs to 0..n groups), `TeamMembership` (User↔Team).
- Personal-tenant creation as part of user creation.
- RLS policies keyed on `current*setting('app.tenant*id')`; a request/test helper that sets the setting.
- Migrations.

**Out of scope:** Auth provider (M8), scheduling tables (M2), team/group UI.
**Acceptance (you verify):** Migrations apply; a test proves a query under tenant A cannot read tenant B rows (negative + positive); a user can hold memberships in multiple tenants and multiple teams/groups.
**Tests required:** RLS isolation tests; membership/cardinality constraint tests.
**Review focus:** Tenant boundary and RLS policies; personal-tenant bootstrap; that User is global; team↔group cardinalities.
→ **STOP for review.**

### M2 — Scheduling-domain schema + constraints *(one-way door — review with extra care)*
**Goal:** All scheduling entities and DB-level invariants.
**Depends on:** M1
**In scope:**
- Tables per spec §4.3–4.5: `Calendar` (visibility scope, working + shareable windows), `Category` (default cooldown), `AvailabilityWindow`, `WeekTypeOverride`, `Task` (all columns in spec §4.4, incl. `parent*id`, estimate, priority, `due*date`+`due*kind`, preferred/focus, `cooldown*override`, `sequence*id`, recurrence, `manual*floor`/`manual*bias`, `estimated*week`, defer fields, `status`, `version`), `Appointment` (`during tstzrange`, `is_internal`, status, recurrence), `AppointmentParticipant` (status), `Sequence`, `TaskOccurrence`, `Placement` (derived cache), `Command` (append-only), `Notification`.
- Constraints: GiST exclusion on appointment non-overlap per calendar (spec §5.3); depth ≤ 5 enforcement (trigger or maintained depth column); child effective due ≤ inherited parent due (trigger/check); version columns.
- Recursive-CTE read query for the task tree.

**Out of scope:** Any behavior/logic — schema, constraints, and read queries only.
**Acceptance (you verify):** Migrations apply; constraint tests reject overlapping appointments, a depth-6 tree, and a child due after its parent; the recursive CTE returns a subtree.
**Tests required:** Constraint-rejection tests; tree-read test.
**Review focus:** Column completeness vs spec §4.4/§4.5; that `Placement` is a cache with **no** exclusion constraint (it is recomputed); exclusion scoped to appointments only; enforcement mechanisms for depth and due-date.
→ **STOP for review.**

---

## Phase 2 — Scheduler core (pure package, headless)

### M3 — Scheduler I: types, validator, determinism *(high risk)*
**Goal:** The hard-constraint validator and the determinism foundation, with zero infrastructure.
**Depends on:** — *(reads no DB; uses plain-data fixtures. May run in parallel with Phase 1.)*
**In scope:**
- In `packages/scheduler`: plain-data input/output types (tasks, appointments, windows, rules, `now`, horizon → placements + diagnostics).
- The hard-constraint validator (spec §6.2): window membership, no overlap, cooldown footprint, hard due date, sequence contiguity, manual floor.
- Integer-minute arithmetic; determinism utilities (total ordering with id tie-break; no wall-clock/random).

**Out of scope:** Placement algorithm and scoring (M4).
**Acceptance (you verify):** Against hand-built fixtures, the validator accepts valid schedules and rejects each invariant violation with a *specific* diagnostic; the determinism harness demonstrates stable ordering.
**Tests required:** Unit test per invariant; a property test that validation is order-insensitive.
**Review focus:** No DB/HTTP imports in the package; validator matches §6.2 exactly; diagnostics are specific and actionable.
→ **STOP for review.**

### M4 — Scheduler II: placement, scoring, horizon, backlog *(high risk)*
**Goal:** Deterministic greedy placement with the modular scoring policy and the two-week horizon.
**Depends on:** M3
**In scope:**
- Greedy algorithm: order tasks by Stage-1 score, place each into the best Stage-2 slot passing all hard filters (spec §6.5).
- `ScoringPolicy` interface: named term functions + weight vector, selected by config; implement the default policy from §6.5.
- Horizon model: hard current + next week to datetimes; beyond → backlog with `estimated_week` via coarse weekly bin-pack (§6.1).
- Infeasibility → backlog + diagnostics (§6.7).
- Centralized tuning config holding the §15 values.

**Out of scope:** Sequences, capacity, deferral (M5); recurrence.
**Acceptance (you verify):** Property tests pass for every invariant on randomized inputs (no overlap, within window, cooldown respected, no hard-due violation); the determinism property (identical input → identical output) passes; golden tests pin default-policy outputs; changing weights via config visibly changes output; over-capacity inputs push tasks to the backlog with diagnostics rather than violating a hard constraint.
**Tests required:** fast-check property suite; determinism property; golden scoring tests.
**Review focus:** `ScoringPolicy` modularity (term *structure* swappable, not just weights); horizon/backlog boundary; that soft constraints never override hard ones.
→ **STOP for review.**

### M5 — Scheduler III: sequences, capacity, deferral signals *(high risk)*
**Goal:** Uninterruptible sequences, capacity computation, and the chronic-postponement signal.
**Depends on:** M4
**In scope:**
- Sequence placement: collapse a sequence to a composite of summed duration + internal cooldowns; place contiguously within one window; ordered/unordered; then expand (spec §6.4).
- Capacity/utilization per `(category, week)` including the contiguous-span check (§6.6).
- Deferral-signal computation (chronic-postponement threshold `N`) as a pure function over task metadata.

**Out of scope:** Wiring to commands/UI.
**Acceptance (you verify):** Property tests show sequence members are always contiguous, in order when ordered, never interleaved with a foreign task, and never split across windows; capacity flags overcommitment and the "enough total minutes but no contiguous span" case; the deferral signal fires at threshold.
**Tests required:** Extended property suite; capacity unit tests including the contiguity edge case.
**Review focus:** Composite-placement approach; contiguity checked in capacity, not just totals.
→ **STOP for review.**

---

## Phase 3 — Command layer, derived state, persistence

### M6 — Command layer, derived state, persistence
**Goal:** The single write path, derived recomputation, and the placement cache — headless.
**Depends on:** M2, M5
**In scope:**
- Command envelope (spec §7.1); append-only `Command` log.
- Apply pipeline: validate → mutate source in a transaction → re-derive via the scheduler → persist the `Placement` cache → append the command; optimistic locking (version check).
- Test harness that sets the tenant context.
- Implement: create/edit task and appointment commands; bulk-defer commands (`PostponeRestOfDay`, `ClearWeek`); core single-task actions (`MoveTask` with floor+bias, `DeferTask`, `CompleteTask`).

**Out of scope:** Remaining manual actions (M7); HTTP; auth.
**Acceptance (you verify):** Integration tests over a test DB (injected tenant context) show: creating tasks yields a valid derived schedule; `MoveTask` sets a soft floor honored by re-derive but overridable by hard constraints; `PostponeRestOfDay` reflows the day and clears floors per §7.3; an optimistic-lock conflict is rejected.
**Tests required:** Command integration tests; derived-state consistency (re-derive is a pure function of source); floor-clearing behavior.
**Review focus:** That source + log is authoritative and `Placement` is recomputed; transactional apply; floor semantics match §7.3.
→ **STOP for review.**

### M7 — Remaining commands + undo/redo
**Goal:** Complete the command vocabulary and reversible history.
**Depends on:** M6
**In scope:**
- Commands: `SwapTasks` / `SwapForward`, `ExtendTask`, `PromoteFromBacklog` / `MoveToBacklog`, `AddUnavailability`, `CancelTask` (spec §7.3–7.4).
- `Undo` / `Redo` across single commands and atomic command groups (bulk actions revert atomically); each command records enough to reverse.

**Out of scope:** HTTP/UI.
**Acceptance (you verify):** Integration tests cover each command's pre/post semantics (§7); undo reverses a bulk `PostponeRestOfDay` atomically; redo replays.
**Tests required:** Per-command semantics; undo/redo including group atomicity.
**Review focus:** Reversibility completeness; that undo is log-driven, not ad-hoc.
→ **STOP for review.**

---

## Phase 4 — Auth

### M8 — Authentication & tenant context
**Goal:** Real identity via Better Auth, wired to the RLS context.
**Depends on:** M1
**In scope:**
- Better Auth self-hosted on Postgres; organization plugin mapped to `Tenant`/`Membership`/roles.
- Session management; middleware that sets the tenant context from the authenticated session / active context; personal-tenant linkage.
- SSO plugin *configured but not enterprise-onboarded* (scaffold the OIDC/SAML config surface, spec §10.1).

**Out of scope:** Enterprise SSO onboarding, 2FA/passkeys (available, not required), fine-grained authz engine.
**Acceptance (you verify):** Sign-up/sign-in works; requests run under the correct tenant context; switching the active context changes RLS scope; a user with memberships in two tenants sees only the active one's data.
**Tests required:** Auth-flow and context-enforcement integration tests.
**Review focus:** Session→context wiring; organization plugin ↔ tenancy mapping; that RLS now derives context from real auth.
→ **STOP for review.**

---

## Phase 5 — API

### M9 — API layer (Hono RPC)
**Goal:** Typed endpoints exposing commands and reads.
**Depends on:** M6, M7, M8
**In scope:**
- Hono RPC routes for each command and for reads (derived schedule / calendar, backlog, notifications, capacity).
- Shared Zod validation (one source, both sides).
- The authoritative server-side re-derive path; the **validation-in-transaction commit hook wired even for single-user**, so shared-resource support (spec §3.3) is a later addition rather than a refactor.
- Error/diagnostic surfacing through the API.

**Out of scope:** Client UI; real-time.
**Acceptance (you verify):** An API client (or tests) can create tasks/appointments, issue manual commands, and read a derived schedule matching the scheduler's output; validation rejects bad payloads via shared Zod; optimistic-lock and infeasibility diagnostics surface through the API.
**Tests required:** API integration tests per endpoint; a type-level check that the client can consume the RPC contract.
**Review focus:** RPC typing / shared Zod; that the API mutates only via commands; the transactional commit hook is present.
→ **STOP for review.**

---

## Phase 6 — Client

### M10 — Client shell + read-only calendar
**Goal:** Render the derived schedule and task/backlog state.
**Depends on:** M9
**In scope:** Vue app shell; auth-aware routing; a week-view calendar grid rendering appointments + task placements from the API; task list and backlog panels (estimated-week display); read-only.
**Out of scope:** Any mutation/editing (M11+).
**Acceptance (you verify):** After seeding via the API, the client displays the correct week schedule, appointments, task placements, and backlog with estimated weeks; timezone rendering is correct.
**Tests required:** Component tests for grid rendering; an e2e smoke (seed via API → render).
**Review focus:** Grid correctness; timezone handling; that reads come from the derived cache.
→ **STOP for review.**

### M11 — CRUD + hierarchy + configuration UI
**Goal:** Create and manage domain objects through the UI.
**Depends on:** M10
**In scope:** Task create/edit (all properties); hierarchy UI (depth ≤ 5, indentation, inheritance display with a local-override affordance); appointment create/edit; category / availability-window / week-type-override configuration; two-window (working + shareable) config. Each action emits a command.
**Out of scope:** Manual scheduling gestures + optimistic compute (M12).
**Acceptance (you verify):** A user can build categories, windows, a task tree with inherited-then-overridden properties, and appointments entirely via UI; child-due ≤ parent-due is enforced in the UI; changes persist and reschedule.
**Tests required:** Component + e2e for CRUD and inheritance override.
**Review focus:** Hierarchy UX vs §4.4; inheritance/override correctness; command emission (no direct writes).
→ **STOP for review.**

### M12 — Manual actions + optimistic client compute
**Goal:** The interactive rescheduling surface with instant feedback.
**Depends on:** M11
**In scope:**
- Drag-to-move on a 15-minute grid with an exact-minute text override (→ `MoveTask`); defer (tomorrow/next-week/backlog), swap / swap-forward, complete, extend, postpone-rest-of-day, add-unavailability — all as command emissions.
- **Optimistic client-side scheduling** importing the shared scheduler package: compute and display immediately, then reconcile with the server's authoritative re-derive (accept the server result on the rare mismatch).
- Undo/redo UI.

**Out of scope:** Recurrence UI (M14), notification surfacing (M13).
**Acceptance (you verify):** Dragging a task updates instantly and persists; postpone-rest-of-day reflows the day instantly then confirms with the server; the optimistic result matches the server re-derive in normal cases; undo works from the UI.
**Tests required:** e2e per gesture; a test asserting client optimistic output equals server output for a fixed scenario (determinism across the boundary).
**Review focus:** Shared-module reuse (no duplicated logic); reconciliation strategy; 15-minute grid + text override; visible floor semantics.
→ **STOP for review.**

### M13 — Surfacing: capacity, backlog, alerts, divergence
**Goal:** Make the engine's signals visible and actionable.
**Depends on:** M12
**In scope:** Backlog notifications; soft-due warnings vs hard-due/hard-constraint alerts; a per-category utilization indicator; the chronic-postponement signal; the working-window divergence notice (compare user vs team window); an in-app notification center.
**Out of scope:** Email/jobs (M15); team UI.
**Acceptance (you verify):** Over-capacity and at-risk scenarios produce the correct in-app warnings/alerts; a repeatedly deferred task surfaces the postponement signal; a divergent working window triggers the notice.
**Tests required:** e2e per signal type.
**Review focus:** Warning-vs-alert distinction (§6.5/§6.7); that signals derive from scheduler diagnostics.
→ **STOP for review.**

---

## Phase 7 — Recurrence

### M14 — Recurrence: two engines
**Goal:** Recurring appointments and recurring task demand.
**Depends on:** M6, M12
**In scope:**
- Appointment RRULE engine: expansion, `EXDATE` / modified occurrences, "this occurrence" vs "this and all future" editing (spec §8.1).
- Task per-period demand generator: occurrence spawning, flexible placement via the scheduler (§8.2).
- Missed-instance policy: default rollover, per-task configurable expiry.

**Out of scope:** None beyond spec.
**Acceptance (you verify):** A recurring appointment expands correctly and supports per-occurrence and this-and-future edits; a "3×/week" task spawns weekly occurrences placed flexibly; a missed occurrence rolls over by default and expires when configured.
**Tests required:** RRULE expansion/exception tests; demand-generation + missed-instance tests; the scheduler property suite still passes with occurrences present.
**Review focus:** The two mechanisms remain separate (§8); DST / timezone-carrying recurrence; edit semantics.
→ **STOP for review.**

---

## Phase 8 — Jobs & notifications

### M15 — Jobs, presence, notification delivery
**Goal:** Background processing and multi-channel notifications.
**Depends on:** M13, M14
**In scope:** pg-boss integration; last-seen heartbeat + online/offline presence; in-app-when-online / email-when-offline dispatch; the week-rollover promotion job (materialize backlog → hard horizon; on-demand promotion already exists); async reschedule jobs; internal-appointment change notification to participants (participant/status records from M2).
**Out of scope:** Real-time push, native mobile.
**Acceptance (you verify):** A scheduled job promotes backlog tasks at week rollover; an offline user receives email while an online user receives in-app; moving an internal appointment notifies participants with a change-request affordance.
**Tests required:** Job-execution tests; presence-routing tests; internal-appointment notification test.
**Review focus:** Queue reliability; presence logic; promotion-trigger timing (§6.1).
→ **STOP for review.**

---

## Phase 9 — Cross-cutting hardening

### M16 — i18n, settings, accessibility, audit, hardening
**Goal:** Production-readiness passes.
**Depends on:** All prior.
**In scope:**
- i18n (date/time formatting, first-day-of-week, locale, timezone) + settings UI; an end-to-end timezone-correctness audit.
- Accessibility pass: keyboard-navigable calendar grid, a keyboard-equivalent for every drag action, WCAG 2.2 AA.
- Audit view over the command log (retention-configurable, spec §12).
- Security hardening (CORS, rate limiting, XSS in Vue, no sensitive data in URLs) and a documented Postgres backup strategy.

**Out of scope:** Deferred features (external sync, real-time, PWA/offline, NL interface, mobile, ReBAC engine) — spec §2.2.
**Acceptance (you verify):** Locale/timezone settings change formatting correctly; the calendar is fully operable by keyboard including equivalents for every drag action; the audit view reconstructs history from the log; rate limiting and CORS are verified.
**Tests required:** i18n formatting tests; accessibility (axe) checks + keyboard e2e; audit-reconstruction test.
**Review focus:** Accessibility coverage of drag alternatives; audit completeness; the hardening checklist.
→ **STOP for review.**

---

## After M16

The v1 scope (spec §2.1) is complete. The deferred features (spec §2.2) become their own plans, each additive on the seams this build preserved: teams/groups UI and internal-appointment negotiation (participant/status already modeled); external calendar sync and iCalendar import/export; real-time updates; offline/PWA; the natural-language command interface (emits existing commands); a native mobile client; and a fine-grained authorization engine (resources already carry owner + scope).

*End of implementation plan.*

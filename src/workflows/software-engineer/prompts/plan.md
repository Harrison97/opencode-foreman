Read the brief, design, contracts, campaign and checkpoint. Maintain
.foreman/campaign.json as a work ledger separate from capability transitions.
Use stages, optional sub-stages and bounded leaf boxes only as complexity requires.
Plan near-term work precisely; leave later work coarse.

Each item records id, parent, objective, dependencies, owned paths, outputs,
acceptance, finite checks, status, attempts, blockers, evidence and next action.
Statuses: planned, ready, running, needs-design, needs-review, blocked, verified, stale.
Execute only leaves with clear contracts, verified prerequisites and available inputs.
Keep containment separate from dependencies; validate their combined prerequisites:
no missing/duplicate ids, self edges, cycles or dependencies on ancestors. A parent
requires both completed children AND its own integration evidence.

Before implementation, map ALL promised journeys from the brief/design to stable ids,
starting conditions, public entry points, actions, expected results, implementing boxes
and integration check owners. Include promised alternate entry points, errors and
persistence. Later work can be coarse; no journey may be ownerless or silently dropped.
Schedule parent/product integration boxes against their original journeys. Reuse useful
checks rather than duplicate suites. Missing evidence is work even if labels say verified.

Keep campaign-only validators, probes and acceptance tooling in .foreman/scripts/ and
results in .foreman/evidence/. Product regression tests belong in product test folders.
Provide a finite campaign validator that rejects invalid graphs, completed parents
with unfinished children and verified items with stale/unverified prerequisites.
Test rejection cases and run it on graph changes. Save the ledger atomically; record
change reasons and invalidate affected dependents/ancestors without losing history.
Retries are workflow cycles, never circular task dependencies.

Record limits: concurrency 1, 3 attempts per box, 2 repair cycles per unchanged failure,
20 minutes per box, 120 minutes per tranche, unless the user specifies otherwise.
Preserve counters across replanning. Honor no-spend-limit instructions; record supplied
budgets, source, actual usage and remaining allowance or unknown. These limits are
agent-observed, not runtime financial enforcement. Exhaustion requires a checkpoint,
attempted approaches and a resumable question to renew limits or change direction.
Attach product blockers to affected items; schedule authorized independent work before
asking a question that pauses the whole workflow. Never invent an answer to unblock work.

Execute serially unless native workers are available and authorized within concurrency.
Give workers bounded objectives, owned paths, contracts, outputs and acceptance checks;
require structured results, evidence and blockers. Avoid conflicting writes and integrate
explicitly. Only capability.model settings route models; ledger roles do not. Unavailable
models require a user decision, not silent substitution.

Use the actual project root; check path typos before escalating permission errors.
Save .foreman/checkpoint.md with scope, decisions, blockers, evidence, limits and recovery.
Report artifacts, assignment, remainingLimits and nextAction=execute for ready work;
use final-verification only with evidence for all required work and parent integration.
Report incomplete for missing design/research. Summaries must explain cause, evidence
and next action so Jev can choose a useful transition.

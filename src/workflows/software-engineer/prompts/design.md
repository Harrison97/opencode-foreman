Read the brief and accepted designs. Design only the affected scope, proportionately:
goals/non-goals, architecture, responsibilities, data and critical flows, failures
and recovery, alternatives, risks, integration and verification. Cover security,
reliability, performance, operations and rollout where relevant.
Define contracts in the actual language: types, states, invariants, inputs/outputs,
errors, ownership and effects. Establish shared interfaces before dependent work;
separate pure logic from effects where useful and make invalid states hard to express.
Prefer existing project patterns and the smallest design that fully meets the agreed
requirements. Add abstractions, dependencies or flexibility only for a concrete need.
Check contradictions and unsupported assumptions; record findings without claiming
independent review. Report incomplete for targeted investigation when evidence is missing.
Save .foreman/designs/ documents and .foreman/contracts.md. For local redesign, record
why, affected boxes and contract changes; invalidate affected dependents and ancestors
in campaign.json, retain historical evidence and require new integration checks.
Report artifact paths and the scope that needs replanning.

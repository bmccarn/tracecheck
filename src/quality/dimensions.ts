export type Dimension = {
  key: string; label: string; criterion: string; conditional: boolean; importance: number;
  concerns: Record<string, { description: string; action: string }>;
};

// Quality signals describe the supplied implementation. They are distinct from
// source-anchored defect findings and do not assert a reproduced failure.
const definitions: Array<[string, string, string, number, Array<[string, string, string]>]> = [
  ['correctness', 'Correctness and requirement fit', 'Requested outcomes, edge inputs, invariants, and preservation of existing behavior.', 5, [
    ['contract', 'The implementation may not deliver an explicit requirement.', 'Trace the requirement through the implementation and demonstrate its outcome.'],
    ['boundary', 'A boundary input or state may produce the wrong result.', 'Check the disputed boundary with a minimal example.'],
    ['regression', 'An existing behavior may have changed unintentionally.', 'Compare the affected behavior with its earlier contract.'],
  ]],
  ['cognitiveComplexity', 'Cognitive complexity', 'How much control flow and state a reader must hold at once; distinguish inherent domain difficulty from accidental complexity.', 3, [
    ['branching', 'Branch interactions make behavior difficult to follow.', 'Simplify the decision sequence while preserving the domain cases.'],
    ['state', 'Implicit state transitions make the operation hard to reason about.', 'Expose the state transition and its owner.'],
    ['indirection', 'Following one behavior requires unnecessary navigation.', 'Remove an unhelpful hop or bring related logic together.'],
  ]],
  ['readability', 'Readability and intent', 'Whether names, expressions, ordering, and comments explain the actual behavior to a maintainer.', 2, [
    ['names', 'Names conceal an important distinction.', 'Rename the specific concept to reveal its role.'],
    ['flow', 'Expression or statement organization obscures intent.', 'Express the same behavior in a clearer sequence.'],
    ['explanation', 'An unusual implementation lacks a useful explanation.', 'Explain the non-obvious reason close to the decision.'],
  ]],
  ['modularity', 'Modularity and cohesion', 'Whether responsibilities that change together live together and independent responsibilities have useful boundaries.', 3, [
    ['mixed', 'One module combines responsibilities with different reasons to change.', 'Separate the responsibilities at their actual change boundary.'],
    ['split', 'One cohesive behavior is unnecessarily dispersed.', 'Bring the related behavior under a coherent interface.'],
    ['ownership', 'Responsibility for a domain decision is unclear.', 'Assign the decision to one explicit owner.'],
  ]],
  ['coupling', 'Coupling and dependencies', 'Dependency direction, hidden global inputs, cycles, and how many implementation details consumers must understand.', 3, [
    ['hidden', 'Behavior depends on inputs that the interface conceals.', 'Make the required dependency explicit.'],
    ['leak', 'Consumers depend on internal representation.', 'Expose the needed operation rather than the representation.'],
    ['direction', 'Dependencies run across the intended boundary.', 'Correct the ownership or dependency direction.'],
  ]],
  ['changeability', 'Changeability', 'The number and predictability of edits required for an evidenced future change, including duplicated decisions and cascading dependencies.', 3, [
    ['scattered', 'A single decision must be changed in several places.', 'Give that decision one authoritative location.'],
    ['cascade', 'A local change propagates unexpectedly across modules.', 'Isolate the source of the propagation.'],
    ['rigid', 'An already-known variation requires disproportionate rework.', 'Provide a small extension point for that known variation.'],
  ]],
  ['abstractionQuality', 'Abstraction and API design', 'How much useful complexity an interface hides relative to the surface it exposes; match abstractions to established needs.', 3, [
    ['surface', 'An interface adds surface without hiding useful complexity.', 'Collapse or deepen the interface.'],
    ['premature', 'Generality exceeds the requirements supported by evidence.', 'Prefer the simplest interface that serves current needs.'],
    ['leaky', 'Callers must coordinate details the abstraction should own.', 'Move the coordination behind the interface.'],
  ]],
  ['projectStructure', 'Project and file structure', 'Discoverability of affected features and coherent placement in the supplied repository layout, not arbitrary file-size targets.', 2, [
    ['placement', 'The location makes the feature difficult to discover.', 'Place the behavior with the domain that owns it.'],
    ['fragmentation', 'Directory or file boundaries split a cohesive concept.', 'Consolidate related pieces where it improves navigation.'],
    ['catchall', 'A generic bucket obscures domain-specific ownership.', 'Move the behavior to a named domain module.'],
  ]],
  ['duplication', 'Duplication and reuse', 'Repeated knowledge that must remain synchronized; distinguish it from incidental syntactic similarity.', 2, [
    ['knowledge', 'Independent copies represent the same domain rule.', 'Centralize the shared rule without combining unrelated policies.'],
    ['existing', 'An existing suitable implementation appears bypassed.', 'Reuse the established implementation where the contracts match.'],
    ['forced', 'Reuse binds concepts that should evolve independently.', 'Separate the distinct policies despite their current similarity.'],
  ]],
  ['maintainability', 'Maintainability', 'Recurring effort to understand, diagnose, modify, and extend this implementation in its actual project.', 3, [
    ['understanding', 'Routine understanding requires disproportionate effort.', 'Make the main behavior and its dependencies explicit.'],
    ['diagnosis', 'The structure makes isolating failures difficult.', 'Create a clearer diagnostic boundary.'],
    ['modification', 'Normal edits are unusually fragile.', 'Remove the specific source of fragility.'],
  ]],
  ['testQuality', 'Testability and test quality', 'Assertions that distinguish intended behavior from regressions, representative failure cases, isolation, and repeatability.', 4, [
    ['coverage', 'An important changed behavior has no demonstrated regression protection.', 'Add a focused behavior test for the specific risk.'],
    ['assertions', 'Tests can pass without establishing the required outcome.', 'Assert the externally relevant result or side effect.'],
    ['brittleness', 'Tests depend on unstable timing or implementation details.', 'Control nondeterminism and test the contract.'],
  ]],
  ['reliability', 'Reliability and error handling', 'Failure propagation, cleanup, retry safety, deadlines, concurrency, and recoverable state transitions.', 4, [
    ['failure', 'A failure is lost or converted into a misleading outcome.', 'Preserve the failure contract at the appropriate boundary.'],
    ['lifecycle', 'Resources or state may remain inconsistent after interruption.', 'Define cleanup and recovery for the interruption path.'],
    ['retry', 'Retries or concurrent work can violate the operation contract.', 'Establish bounded retries and safe state transitions.'],
  ]],
  ['security', 'Security', 'Evidence of unsafe trust-boundary crossings, authorization gaps, injection, credential exposure, or excessive privilege.', 5, [
    ['trust', 'Untrusted data may control a sensitive operation.', 'Validate the boundary and separate data from executable instructions.'],
    ['access', 'An operation may lack an established permission check.', 'Verify the required identity and resource authorization.'],
    ['exposure', 'Sensitive data or privileges may be exposed unnecessarily.', 'Reduce exposure to what the operation requires.'],
  ]],
  ['consistency', 'Consistency and conventions', 'Fit with supplied local architecture, language practices, naming, and existing solutions; local evidence takes precedence over personal taste.', 2, [
    ['pattern', 'The change departs from an established solution without a stated reason.', 'Follow the local pattern or record the constraint requiring deviation.'],
    ['competing', 'A second convention creates avoidable decision overhead.', 'Use one convention for equivalent behavior.'],
    ['internal', 'Related code within the change follows conflicting rules.', 'Align the related pieces around one coherent rule.'],
  ]],
  ['documentation', 'Documentation and explainability', 'Clarity of changed public contracts, setup, constraints, and design rationale; useful information rather than volume.', 2, [
    ['contract', 'A changed public contract is unclear.', 'Document inputs, outcomes, and failure behavior.'],
    ['setup', 'Required configuration or operation is not explained.', 'Add the smallest complete usage example.'],
    ['rationale', 'A consequential constraint or choice is unexplained.', 'Record why the choice is necessary.'],
  ]],
  ['performance', 'Performance and resource efficiency', 'Evidenced hot paths, repeated I/O, algorithmic cost, and resource consumption; only assess when the supplied workload makes this relevant.', 3, [
    ['repeat', 'Costly work appears repeated unnecessarily.', 'Reuse or batch the evidenced repeated operation.'],
    ['complexity', 'Algorithmic cost is disproportionate to the stated workload.', 'Measure the path and choose a proportionate algorithm.'],
    ['resource', 'A resource is consumed beyond the operation needs.', 'Bound or reduce the identified resource use.'],
  ]],
  ['scalability', 'Scalability and flexibility', 'Capacity for stated growth or established variation; hypothetical scale alone is not evidence.', 2, [
    ['bottleneck', 'A known growth requirement hits a concrete bottleneck.', 'Address that bottleneck with a bounded design change.'],
    ['variation', 'A documented variation is obstructed by a fixed assumption.', 'Make the specific variation explicit.'],
    ['speculation', 'Complexity is added for growth the requirements do not establish.', 'Remove the unsupported scaling machinery.'],
  ]],
  ['compatibility', 'Compatibility and API stability', 'Preservation or deliberate migration of public contracts and supported integrations when such consumers are evidenced.', 4, [
    ['consumer', 'An existing consumer may lose required behavior.', 'Preserve the behavior or provide an explicit migration.'],
    ['migration', 'A state or interface transition lacks a compatible path.', 'Define and test the transition across supported versions.'],
    ['version', 'The code assumes an unsupported capability or version.', 'Check the declared support range and handle the actual boundary.'],
  ]],
  ['observability', 'Observability and operability', 'Whether evidenced operational failures can be detected and diagnosed using useful, proportionate, non-sensitive signals.', 3, [
    ['invisible', 'A meaningful operational failure lacks a useful signal.', 'Expose the failure where an operator can act on it.'],
    ['context', 'Signals omit information required for diagnosis.', 'Include the relevant operation and failure context safely.'],
    ['noise', 'Signals create noise or unnecessary sensitive-data exposure.', 'Keep only actionable information at an appropriate level.'],
  ]],
];

export const dimensions: readonly Dimension[] = definitions.map(([key, label, criterion, importance, concerns]) => ({
  key, label, criterion, importance, conditional: ['performance', 'scalability', 'compatibility', 'observability'].includes(key),
  concerns: Object.fromEntries(concerns.map(([id, description, action]) => [id, { description, action }])),
}));
export const dimensionKeys = dimensions.map(dimension => dimension.key);

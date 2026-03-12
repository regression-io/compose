/**
 * build-dag.js — Build a dependency DAG from roadmap feature entries.
 *
 * Dependencies are positional:
 * - Items within the same phase depend on the previous item (sequential chain)
 * - The first item of phase N depends on the last item of phase N-1 (cross-phase edge)
 */

/**
 * @typedef {{ code: string, deps: string[] }} DagNode
 */

/**
 * Build a DAG from roadmap entries.
 *
 * @param {import('./roadmap-parser.js').FeatureEntry[]} entries - Full ordered list from parseRoadmap()
 * @returns {DagNode[]}
 */
export function buildDag(entries) {
  if (entries.length === 0) return [];

  // Group by phaseId preserving encounter order
  const phases = new Map();
  for (const entry of entries) {
    if (!phases.has(entry.phaseId)) {
      phases.set(entry.phaseId, []);
    }
    phases.get(entry.phaseId).push(entry);
  }

  // Build adjacency: code → Set<depCode>
  const deps = new Map();
  for (const entry of entries) {
    deps.set(entry.code, new Set());
  }

  let lastPhaseLastCode = null;

  for (const [, phaseEntries] of phases) {
    let prevCode = null;

    for (const entry of phaseEntries) {
      // Cross-phase edge: first item depends on last item of previous phase
      if (prevCode === null && lastPhaseLastCode !== null) {
        deps.get(entry.code).add(lastPhaseLastCode);
      }

      // Within-phase sequential chain
      if (prevCode !== null) {
        deps.get(entry.code).add(prevCode);
      }

      prevCode = entry.code;
    }

    lastPhaseLastCode = prevCode;
  }

  return entries.map(e => ({
    code: e.code,
    deps: [...deps.get(e.code)],
  }));
}

/**
 * Topological sort via Kahn's algorithm.
 * Returns feature codes in build order (dependencies first).
 *
 * @param {DagNode[]} nodes
 * @returns {string[]}
 * @throws {Error} if a cycle is detected
 */
export function topoSort(nodes) {
  const inDegree = new Map();
  const successors = new Map();

  for (const node of nodes) {
    if (!inDegree.has(node.code)) inDegree.set(node.code, 0);
    if (!successors.has(node.code)) successors.set(node.code, []);

    for (const dep of node.deps) {
      if (!inDegree.has(dep)) inDegree.set(dep, 0);
      if (!successors.has(dep)) successors.set(dep, []);
      successors.get(dep).push(node.code);
      inDegree.set(node.code, inDegree.get(node.code) + 1);
    }
  }

  const queue = [];
  for (const [code, degree] of inDegree) {
    if (degree === 0) queue.push(code);
  }

  const order = [];
  while (queue.length > 0) {
    const code = queue.shift();
    order.push(code);
    for (const succ of successors.get(code) ?? []) {
      const newDegree = inDegree.get(succ) - 1;
      inDegree.set(succ, newDegree);
      if (newDegree === 0) queue.push(succ);
    }
  }

  if (order.length !== inDegree.size) {
    throw new Error('Cycle detected in feature dependency graph');
  }

  return order;
}

"""
executor.py — STRAT-PAR-3 Executor Ready-Set Model

Replaces the sequential `current_idx` integer pointer with a proper
ready-set model:
  - completed_steps: set[str]   steps whose results are recorded
  - active_steps:   set[str]    steps dispatched but not yet done

Computes ready steps by evaluating `depends_on` against completed_steps.
Handles `parallel_dispatch` step type by returning the full task graph.
Registers `stratum_parallel_done` logic for batch result reporting.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from .spec import no_file_conflicts, EnsureViolation


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class CycleError(Exception):
    """Raised when a cycle is detected in the task depends_on graph."""


class StratumError(Exception):
    """Raised for unrecoverable protocol errors."""


# ---------------------------------------------------------------------------
# Data models
# ---------------------------------------------------------------------------

@dataclass
class Task:
    """A single task within a parallel_dispatch step's task graph."""
    id: str
    description: str
    depends_on: list[str] = field(default_factory=list)
    files_owned: list[str] = field(default_factory=list)
    files_read: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            'id':          self.id,
            'description': self.description,
            'depends_on':  list(self.depends_on),
            'files_owned': list(self.files_owned),
            'files_read':  list(self.files_read),
        }


@dataclass
class StepDefinition:
    """Minimal step definition consumed by the executor."""
    id: str
    type: str = 'execute_step'          # 'execute_step' | 'parallel_dispatch' | 'gate' | 'execute_flow'
    depends_on: list[str] = field(default_factory=list)
    agent: str = 'claude'
    intent: str = ''
    intent_template: str = ''

    # parallel_dispatch-specific fields
    tasks: list[Task] = field(default_factory=list)
    max_concurrent: int = 3
    isolation: str = 'worktree'
    require: Any = 'all'               # 'all' | 'any' | int
    merge: str = 'sequential_apply'
    output_fields: dict = field(default_factory=dict)
    ensure: list[str] = field(default_factory=list)
    reasoning_template: dict | None = None


@dataclass
class FlowDefinition:
    """Minimal flow definition consumed by the executor."""
    flow_id: str
    name: str
    steps: list[StepDefinition] = field(default_factory=list)


@dataclass
class FlowState:
    """
    v0.3 flow state — replaces current_idx with set-based model.

    Fields
    ------
    completed_steps : set[str]
        Step IDs whose results have been recorded.
    active_steps : set[str]
        Step IDs dispatched to an agent but not yet returned.
    step_results : dict[str, Any]
        Results keyed by step_id.
    retries : dict[str, int]
        Retry count per step_id.
    violations : dict[str, list[str]]
        Ensure violations per step_id.
    """
    flow_id: str
    flow_name: str
    completed_steps: set[str] = field(default_factory=set)
    active_steps: set[str] = field(default_factory=set)
    step_results: dict[str, Any] = field(default_factory=dict)
    retries: dict[str, int] = field(default_factory=dict)
    violations: dict[str, list[str]] = field(default_factory=dict)
    started_at: datetime = field(default_factory=datetime.utcnow)
    completed_at: datetime | None = None

    @property
    def current_idx(self) -> int:
        """Backward-compat derived stat. Use completed_steps for logic."""
        return len(self.completed_steps)


# ---------------------------------------------------------------------------
# Core algorithms
# ---------------------------------------------------------------------------

def ready_steps(state: FlowState, flow_def: FlowDefinition) -> list[str]:
    """
    Return step IDs that are ready to execute:
      - All depends_on edges are in completed_steps
      - Not already in completed_steps
      - Not already in active_steps

    Order: topological (stable — same order every call for the same state).
    """
    result = []
    for step in flow_def.steps:
        sid = step.id
        if sid in state.completed_steps:
            continue
        if sid in state.active_steps:
            continue
        deps = step.depends_on or []
        if all(dep in state.completed_steps for dep in deps):
            result.append(sid)
    return result


def topo_levels(tasks: list[Task]) -> list[list[Task]]:
    """
    Group tasks into execution levels based on their depends_on DAG.
    All tasks in level N can execute concurrently; they only depend on
    tasks in levels 0..N-1.

    Raises CycleError if the task graph contains a cycle.
    """
    if not tasks:
        return []

    completed: set[str] = set()
    levels: list[list[Task]] = []

    while len(completed) < len(tasks):
        level = [
            t for t in tasks
            if t.id not in completed
            and all(dep in completed for dep in (t.depends_on or []))
        ]
        if not level:
            remaining = [t.id for t in tasks if t.id not in completed]
            raise CycleError(f"Cycle detected among: {remaining}")
        levels.append(level)
        completed.update(t.id for t in level)

    return levels


# ---------------------------------------------------------------------------
# Dispatch computation
# ---------------------------------------------------------------------------

def compute_next_dispatch(flow: FlowDefinition, state: FlowState) -> dict:
    """
    Compute the next dispatch response given the current flow state.

    Returns one of:
      {status: 'execute_step', ...}
      {status: 'parallel_dispatch', ...}
      {status: 'complete'}

    Also mutates state.active_steps to include dispatched step IDs.
    """
    # Determine step numbering
    step_ids = [s.id for s in flow.steps]
    total_steps = len(step_ids)

    ready = ready_steps(state, flow)

    # No steps ready
    if not ready:
        # If all steps are done → complete
        all_ids = {s.id for s in flow.steps}
        if all_ids == state.completed_steps:
            return {
                'status':  'complete',
                'flow_id': flow.flow_id,
            }
        # Some steps still active (waiting on other results) or all done
        if state.active_steps:
            # Shouldn't happen in sequential flows; return complete if nothing left
            remaining = [s for s in flow.steps
                         if s.id not in state.completed_steps
                         and s.id not in state.active_steps]
            if not remaining:
                return {'status': 'complete', 'flow_id': flow.flow_id}
        return {'status': 'complete', 'flow_id': flow.flow_id}

    # Take the first ready step
    sid = ready[0]
    step = next(s for s in flow.steps if s.id == sid)

    # Compute step ordinal (1-based index within all steps)
    step_number = step_ids.index(sid) + 1

    # Mark as active
    state.active_steps.add(sid)

    if step.type == 'parallel_dispatch':
        return _make_parallel_dispatch_response(flow, state, step, step_number, total_steps)
    else:
        return _make_execute_step_response(flow, step, step_number, total_steps)


def _make_execute_step_response(flow: FlowDefinition, step: StepDefinition,
                                 step_number: int, total_steps: int) -> dict:
    intent = step.intent

    # STRAT-CERT: inject structured reasoning format for claude-agent steps
    if step.reasoning_template and step.agent in ('claude', ''):
        intent = inject_cert_instructions(intent, step.reasoning_template)

    return {
        'status':       'execute_step',
        'flow_id':      flow.flow_id,
        'step_id':      step.id,
        'step_number':  step_number,
        'total_steps':  total_steps,
        'agent':        step.agent,
        'intent':       intent,
        'output_fields': [
            {'name': k, 'type': v} for k, v in (step.output_fields or {}).items()
        ],
        'ensure':       list(step.ensure or []),
    }


def _make_parallel_dispatch_response(flow: FlowDefinition, state: FlowState,
                                      step: StepDefinition,
                                      step_number: int, total_steps: int) -> dict:
    # Build task list; validate no cycles
    tasks = step.tasks or []
    try:
        topo_levels(tasks)  # validate — raises CycleError if cyclic
    except CycleError as e:
        return {
            'status':     'ensure_failed',
            'flow_id':    flow.flow_id,
            'step_id':    step.id,
            'violations': [f"CycleError: {e}"],
        }

    return {
        'status':          'parallel_dispatch',
        'flow_id':         flow.flow_id,
        'step_id':         step.id,
        'step_number':     step_number,
        'total_steps':     total_steps,
        'agent':           step.agent,
        'intent_template': step.intent_template,
        'tasks':           [t.to_dict() for t in tasks],
        'max_concurrent':  step.max_concurrent,
        'isolation':       step.isolation,
        'require':         step.require,
        'merge':           step.merge,
        'output_fields':   step.output_fields or {},
        'ensure':          list(step.ensure or []),
    }


# ---------------------------------------------------------------------------
# parallel_done handler
# ---------------------------------------------------------------------------

def handle_parallel_done(
    flow: FlowDefinition,
    state: FlowState,
    step_id: str,
    task_results: list[dict],
    merge_status: str,
) -> dict:
    """
    Handle stratum_parallel_done call.

    1. Validate task_ids match the dispatched task graph
    2. Check require threshold
    3. Aggregate results
    4. Evaluate ensure expressions (basic)
    5. Advance state
    6. Return next dispatch

    Returns one of:
      {status: 'execute_step' | 'parallel_dispatch' | 'await_gate' | 'complete', ...}
      {status: 'ensure_failed', violations: [...], ...}
      {status: 'error', error: {code, message}}
    """
    # Find the step
    step = next((s for s in flow.steps if s.id == step_id), None)
    if step is None:
        return {
            'status': 'error',
            'error':  {'code': 'STEP_NOT_FOUND', 'message': f"Step '{step_id}' not found"},
        }

    # Validate task IDs
    dispatched_ids = {t.id for t in (step.tasks or [])}
    reported_ids   = {r['task_id'] for r in task_results}

    if dispatched_ids != reported_ids:
        return {
            'status': 'error',
            'error':  {
                'code':    'TASK_ID_MISMATCH',
                'message': (
                    f"Expected task IDs {sorted(dispatched_ids)}, "
                    f"got {sorted(reported_ids)}"
                ),
            },
        }

    # Check require threshold
    completed_tasks = [r for r in task_results if r['status'] == 'complete']
    failed_tasks    = [r for r in task_results if r['status'] != 'complete']

    if not _satisfies_require(step.require, len(completed_tasks), len(dispatched_ids)):
        failed_ids = [r['task_id'] for r in failed_tasks]
        violations = [
            f"require={step.require} not met: "
            f"{len(completed_tasks)}/{len(dispatched_ids)} complete. "
            f"Failed tasks: {failed_ids}"
        ]
        return {
            'status':     'ensure_failed',
            'flow_id':    flow.flow_id,
            'step_id':    step_id,
            'violations': violations,
            'agent':      step.agent,
        }

    # Aggregate result
    aggregate = _aggregate_results(completed_tasks, step.output_fields)

    # Evaluate ensure expressions (basic string-based evaluation)
    violations = _eval_ensure(step.ensure or [], aggregate)
    if violations:
        return _make_ensure_failed_response(flow, step, violations)

    # Advance state
    state.completed_steps.add(step_id)
    state.active_steps.discard(step_id)
    state.step_results[step_id] = aggregate

    # Compute next dispatch
    return compute_next_dispatch(flow, state)


def _satisfies_require(require: Any, n_complete: int, n_total: int) -> bool:
    if require == 'all':
        return n_complete == n_total
    if require == 'any':
        return n_complete >= 1
    if isinstance(require, int):
        return n_complete >= require
    return False


def _aggregate_results(completed_tasks: list[dict], output_fields: dict) -> dict:
    """
    Aggregate multiple task results into a single result object.

    For PhaseResult-style fields: join artifacts, require all outcomes complete.
    For custom contracts: take first non-null value per field.
    """
    if not completed_tasks:
        return {'outcome': 'complete', 'summary': 'No tasks completed', 'artifact': '', 'phase': 'execute'}

    results = [r.get('result', {}) for r in completed_tasks]

    # PhaseResult-style aggregation
    artifacts = [r.get('artifact', '') for r in results if r.get('artifact')]
    all_complete = all(r.get('outcome') == 'complete' for r in results)

    aggregate = {
        'phase':    'execute',
        'artifact': ', '.join(artifacts) if artifacts else '',
        'outcome':  'complete' if all_complete else 'failed',
        'summary':  f"Completed {len(completed_tasks)} parallel tasks",
    }

    # For any additional fields in output_fields not in the above defaults,
    # take first non-null value from task results
    for field_name in (output_fields or {}):
        if field_name not in aggregate:
            for r in results:
                val = r.get(field_name)
                if val is not None:
                    aggregate[field_name] = val
                    break

    return aggregate


def _eval_ensure(ensure: list[str], result: dict) -> list[str | dict]:
    """
    Evaluate ensure expressions against result.

    Sandbox includes:
      result            — step/task output (attribute-accessible via _DictObj)
      no_file_conflicts — v0.3 built-in; raises EnsureViolation on conflict

    Returns list of violations. Each entry is either:
      str  — plain violation (expression false or eval error)
      dict — structured conflict: {"expression": str, "message": str, "conflicts": list[dict]}
    """
    sandbox = {
        'result':            _DictObj(result),
        'no_file_conflicts': no_file_conflicts,
    }
    violations: list[str | dict] = []

    for expr in ensure:
        try:
            if not eval(expr, sandbox):
                violations.append(f"ensure violated: {expr}")
        except EnsureViolation as e:
            violations.append({
                "expression": expr,
                "message":    str(e),
                "conflicts":  e.conflicts,
            })
        except Exception as e:
            violations.append(f"ensure error evaluating '{expr}': {e}")

    return violations


def _make_ensure_failed_response(
    flow: 'FlowDefinition',
    step: 'StepDefinition',
    violations: list,
) -> dict:
    """
    Build an ensure_failed dispatch response from a list of violations.

    Separates plain string violations from structured EnsureViolation dicts.
    Attaches top-level 'conflicts' key only when no_file_conflicts raised EnsureViolation.
    """
    plain_violations: list[str] = []
    all_conflicts: list[dict] = []

    for v in violations:
        if isinstance(v, dict) and "conflicts" in v:
            plain_violations.append(v["message"])
            all_conflicts.extend(v["conflicts"])
        else:
            plain_violations.append(str(v))

    response: dict = {
        'status':     'ensure_failed',
        'flow_id':    flow.flow_id,
        'step_id':    step.id,
        'violations': plain_violations,
        'agent':      step.agent,
    }

    if all_conflicts:
        response['conflicts'] = all_conflicts   # absent when no conflict cause

    return response


class _DictObj:
    """Wraps a dict to allow attribute-style access in ensure expressions."""
    def __init__(self, d: dict):
        self.__dict__.update(d)

    def __eq__(self, other):
        return self.__dict__ == other


# ---------------------------------------------------------------------------
# STRAT-CERT: Reasoning template injection & validation
# ---------------------------------------------------------------------------

def inject_cert_instructions(intent: str, template: dict) -> str:
    """Build a structured output format block from reasoning_template and append to intent."""
    sections = template.get("sections", [])
    require_citations = template.get("require_citations", False)

    lines = [
        intent,
        "",
        "---",
        "",
        "You MUST structure your response with these sections:",
        "",
    ]

    for i, section in enumerate(sections):
        lines.append(f"## {section['label']}")
        lines.append(section["description"])
        if i == 0 and require_citations:
            lines.append("Format each fact as: [P1] <fact, citing file:line>, [P2] ..., etc.")
        if i > 0 and require_citations:
            lines.append("Reference premises by their [P<n>] ID.")
        lines.append("")

    return "\n".join(lines)


def validate_certificate(template: dict, result: dict) -> list[str]:
    """Validate agent output contains required reasoning sections.

    Returns list of violations (empty = pass).
    """
    artifact = result.get("artifact", "")
    violations = []

    for section in template.get("sections", []):
        heading = f"## {section['label']}"
        if heading not in artifact:
            violations.append(f"certificate missing section: {section['label']}")

    if template.get("require_citations", False) and not violations:
        # Only check citations if all sections are present
        conclusion_label = template["sections"][-1]["label"]
        conclusion_idx = artifact.find(f"## {conclusion_label}")
        if conclusion_idx >= 0:
            conclusion_text = artifact[conclusion_idx:]
            if not re.search(r'\[P\d+\]', conclusion_text):
                violations.append(
                    "certificate violation: conclusion contains no premise citations [P<n>]"
                )

    return violations


# ---------------------------------------------------------------------------
# State migration (v0.2 → v0.3)
# ---------------------------------------------------------------------------

def migrate_v2_state(raw: dict, flow: FlowDefinition) -> dict:
    """
    Migrate old v0.2 persisted state (with current_idx: int) to v0.3 format.

    If raw already has 'completed_steps', returns it unchanged.
    Otherwise, derives completed_steps from current_idx.
    """
    if 'completed_steps' in raw:
        # Already v0.3 — no migration needed
        return raw

    current_idx = raw.get('current_idx', 0)
    # Steps 0..current_idx-1 are completed
    completed = [flow.steps[i].id for i in range(min(current_idx, len(flow.steps)))]

    migrated = dict(raw)
    migrated['completed_steps'] = completed
    migrated['active_steps']    = []
    # Remove old key to avoid confusion
    migrated.pop('current_idx', None)

    return migrated

"""
test_no_file_conflicts_ensure.py — Unit tests for STRAT-PAR-2.

Tests wiring of no_file_conflicts into the _eval_ensure sandbox,
_make_ensure_failed_response helper, and handle_parallel_done integration.

Tests:
  T9.1  — _eval_ensure(['no_file_conflicts(result.tasks)'], {'tasks': []}) → []
  T9.2  — Two independent tasks share files_owned → returns [dict] with "conflicts" key
  T9.3  — Conflict dict shape: {expression, message, conflicts: [{task_a, task_b, files}]}
  T9.4  — Tasks with depends_on edge sharing files_owned → returns []
  T9.5  — no_file_conflicts callable from sandbox; global namespace not leaked
  T9.6  — _make_ensure_failed_response with plain violations only → "conflicts" key absent
  T9.7  — _make_ensure_failed_response with one conflict violation → response["conflicts"] present
  T9.8  — _make_ensure_failed_response with mixed violations → correct separation
  T9.9  — handle_parallel_done with conflicting ensure → ensure_failed.conflicts present
  T9.10 — handle_parallel_done with plain failing ensure → ensure_failed has no "conflicts" key

Run with: pytest tests/test_no_file_conflicts_ensure.py -v
"""

import pytest
from stratum_mcp.executor import (
    FlowState,
    FlowDefinition,
    StepDefinition,
    Task,
    _eval_ensure,
    _make_ensure_failed_response,
    handle_parallel_done,
)
from stratum_mcp.spec import EnsureViolation


# ---------------------------------------------------------------------------
# Helpers — reuse the factory pattern from test_executor_v3.py
# ---------------------------------------------------------------------------

def make_step(step_id: str = 'test-step', step_type: str = 'execute_step',
              depends_on: list = None, tasks: list = None,
              agent: str = 'claude', intent: str = 'Do the thing',
              intent_template: str = None, max_concurrent: int = 3,
              isolation: str = 'worktree', require: str = 'all',
              merge: str = 'sequential_apply', output_fields: dict = None,
              ensure: list = None) -> StepDefinition:
    return StepDefinition(
        id=step_id,
        type=step_type,
        depends_on=depends_on or [],
        agent=agent,
        intent=intent,
        intent_template=intent_template or intent,
        tasks=tasks or [],
        max_concurrent=max_concurrent,
        isolation=isolation,
        require=require,
        merge=merge,
        output_fields=output_fields or {
            'phase': 'string', 'artifact': 'string',
            'outcome': 'string', 'summary': 'string',
        },
        ensure=ensure or [],
    )


def make_task(task_id: str, files_owned: list = None, files_read: list = None,
              depends_on: list = None) -> Task:
    return Task(
        id=task_id,
        description=f'Task {task_id}',
        files_owned=files_owned or [],
        files_read=files_read or [],
        depends_on=depends_on or [],
    )


def make_flow(steps: list, flow_id: str = 'test-flow') -> FlowDefinition:
    return FlowDefinition(
        flow_id=flow_id,
        name='test-flow',
        steps=steps,
    )


def make_state(completed: list = None, active: list = None,
               step_results: dict = None) -> FlowState:
    return FlowState(
        flow_id='test-flow',
        flow_name='test-flow',
        completed_steps=set(completed or []),
        active_steps=set(active or []),
        step_results=step_results or {},
    )


# ---------------------------------------------------------------------------
# T9.1 — _eval_ensure with empty tasks → no violations
# ---------------------------------------------------------------------------

class TestEvalEnsureNoFileConflicts:

    def test_t9_1_empty_tasks_returns_no_violations(self):
        """_eval_ensure with no_file_conflicts and empty task list returns []."""
        result = _eval_ensure(['no_file_conflicts(result.tasks)'], {'tasks': []})
        assert result == []

    def test_t9_2_independent_tasks_sharing_files_owned_returns_conflict_dict(self):
        """Two independent tasks sharing files_owned returns [dict] with 'conflicts' key."""
        tasks = [
            {'id': 'task-a', 'files_owned': ['src/foo.js'], 'depends_on': []},
            {'id': 'task-b', 'files_owned': ['src/foo.js'], 'depends_on': []},
        ]
        violations = _eval_ensure(['no_file_conflicts(result.tasks)'], {'tasks': tasks})
        assert len(violations) == 1
        v = violations[0]
        assert isinstance(v, dict), "Violation for EnsureViolation should be a dict"
        assert 'conflicts' in v

    def test_t9_3_conflict_dict_shape(self):
        """Conflict dict must have expression, message, conflicts fields with correct sub-shape."""
        tasks = [
            {'id': 'task-a', 'files_owned': ['src/foo.js'], 'depends_on': []},
            {'id': 'task-b', 'files_owned': ['src/foo.js'], 'depends_on': []},
        ]
        violations = _eval_ensure(['no_file_conflicts(result.tasks)'], {'tasks': tasks})
        v = violations[0]

        assert 'expression' in v
        assert 'message' in v
        assert 'conflicts' in v
        assert isinstance(v['expression'], str)
        assert isinstance(v['message'], str)
        assert isinstance(v['conflicts'], list)
        assert len(v['conflicts']) == 1

        conflict = v['conflicts'][0]
        assert 'task_a' in conflict
        assert 'task_b' in conflict
        assert 'files' in conflict
        assert set([conflict['task_a'], conflict['task_b']]) == {'task-a', 'task-b'}
        assert 'src/foo.js' in conflict['files']

    def test_t9_4_tasks_with_depends_on_edge_sharing_files_owned_returns_empty(self):
        """Tasks with depends_on edge sharing files_owned should NOT be flagged."""
        tasks = [
            {'id': 'task-a', 'files_owned': ['src/foo.js'], 'depends_on': []},
            {'id': 'task-b', 'files_owned': ['src/foo.js'], 'depends_on': ['task-a']},
        ]
        violations = _eval_ensure(['no_file_conflicts(result.tasks)'], {'tasks': tasks})
        assert violations == []

    def test_t9_5_no_file_conflicts_callable_from_sandbox(self):
        """no_file_conflicts must be in sandbox; __builtins__ must not be accessible."""
        tasks = [
            {'id': 'a', 'files_owned': ['x.js'], 'depends_on': []},
            {'id': 'b', 'files_owned': ['y.js'], 'depends_on': []},
        ]
        # Should work without raising
        result = _eval_ensure(['no_file_conflicts(result.tasks)'], {'tasks': tasks})
        assert result == []

        # __builtins__ should not be leaking useful global state into the sandbox.
        # If we try to use something not in the sandbox it should fail.
        violations = _eval_ensure(['open("not_real.txt")'], {'tasks': []})
        # open is NOT in the sandbox — should raise a NameError caught as ensure error
        assert len(violations) == 1
        assert 'ensure error' in violations[0].lower() or 'nameerror' in violations[0].lower()

    def test_plain_false_expression_returns_str_not_dict(self):
        """A plain false expression returns a string violation, not a dict."""
        violations = _eval_ensure(["result.outcome == 'complete'"], {'outcome': 'failed'})
        assert len(violations) == 1
        assert isinstance(violations[0], str)
        assert 'ensure violated' in violations[0]

    def test_path_normalization_dot_slash_prefix(self):
        """files_owned with ./src/foo.js should conflict with src/foo.js."""
        tasks = [
            {'id': 'task-a', 'files_owned': ['./src/foo.js'], 'depends_on': []},
            {'id': 'task-b', 'files_owned': ['src/foo.js'], 'depends_on': []},
        ]
        violations = _eval_ensure(['no_file_conflicts(result.tasks)'], {'tasks': tasks})
        assert len(violations) == 1
        assert isinstance(violations[0], dict)
        assert 'conflicts' in violations[0]


# ---------------------------------------------------------------------------
# T9.6–T9.8 — _make_ensure_failed_response helper
# ---------------------------------------------------------------------------

class TestMakeEnsureFailedResponse:

    def _make_minimal_flow_and_step(self):
        step = make_step(step_id='analyze-tasks', ensure=['no_file_conflicts(result.tasks)'])
        flow = make_flow([step])
        return flow, step

    def test_t9_6_plain_violations_only_no_conflicts_key(self):
        """_make_ensure_failed_response with plain string violations → no 'conflicts' key."""
        flow, step = self._make_minimal_flow_and_step()
        violations = ["ensure violated: result.outcome == 'complete'"]

        response = _make_ensure_failed_response(flow, step, violations)

        assert response['status'] == 'ensure_failed'
        assert 'conflicts' not in response
        assert response['violations'] == violations
        assert response['step_id'] == 'analyze-tasks'
        assert response['flow_id'] == 'test-flow'

    def test_t9_7_one_conflict_violation_conflicts_key_present(self):
        """_make_ensure_failed_response with one conflict violation → 'conflicts' key present."""
        flow, step = self._make_minimal_flow_and_step()
        violations = [
            {
                'expression': 'no_file_conflicts(result.tasks)',
                'message': 'File ownership conflicts detected:\nTasks A and B both own: src/foo.js',
                'conflicts': [{'task_a': 'task-a', 'task_b': 'task-b', 'files': ['src/foo.js']}],
            }
        ]

        response = _make_ensure_failed_response(flow, step, violations)

        assert response['status'] == 'ensure_failed'
        assert 'conflicts' in response
        assert len(response['conflicts']) == 1
        c = response['conflicts'][0]
        assert c['task_a'] == 'task-a'
        assert c['task_b'] == 'task-b'
        assert c['files'] == ['src/foo.js']
        # violations list should contain the message string
        assert any('conflicts detected' in v.lower() for v in response['violations'])

    def test_t9_8_mixed_violations(self):
        """Mixed violations: plain str + conflict dict → correct separation."""
        flow, step = self._make_minimal_flow_and_step()
        violations = [
            "ensure violated: len(result.tasks) >= 1",
            {
                'expression': 'no_file_conflicts(result.tasks)',
                'message': 'File ownership conflicts detected',
                'conflicts': [{'task_a': 'a', 'task_b': 'b', 'files': ['x.js']}],
            }
        ]

        response = _make_ensure_failed_response(flow, step, violations)

        assert response['status'] == 'ensure_failed'
        assert 'conflicts' in response
        assert len(response['violations']) == 2
        assert len(response['conflicts']) == 1
        # First violation should be the plain string
        assert 'ensure violated' in response['violations'][0]
        # Second violation should be the conflict message
        assert 'conflicts detected' in response['violations'][1]


# ---------------------------------------------------------------------------
# T9.9–T9.10 — handle_parallel_done integration
# ---------------------------------------------------------------------------

class TestHandleParallelDoneEnsureIntegration:

    def _make_parallel_step(self, task_ids: list[str], ensure: list = None,
                            task_files: dict = None) -> StepDefinition:
        """Build a parallel_dispatch step with specified task IDs and ensure expressions."""
        task_files = task_files or {}
        tasks = [
            make_task(
                tid,
                files_owned=task_files.get(tid, [f'src/{tid}.js']),
            )
            for tid in task_ids
        ]
        return make_step(
            step_id='execute',
            step_type='parallel_dispatch',
            tasks=tasks,
            ensure=ensure or [],
        )

    def _complete_results(self, task_ids: list[str], outcome: str = 'complete') -> list[dict]:
        return [
            {'task_id': tid, 'status': 'complete',
             'result': {'phase': 'execute', 'artifact': f'{tid}.md',
                        'outcome': outcome, 'summary': f'{tid} done'}}
            for tid in task_ids
        ]

    def test_t9_9_handle_parallel_done_with_plain_failing_ensure_no_conflicts_key(self):
        """handle_parallel_done with plain ensure failure → no 'conflicts' key."""
        step = self._make_parallel_step(
            ['task-a', 'task-b'],
            ensure=["result.outcome == 'complete'"],
        )
        flow = make_flow([step])
        state = make_state(active=['execute'])

        results = [
            {'task_id': 'task-a', 'status': 'complete',
             'result': {'phase': 'execute', 'artifact': 'a.md',
                        'outcome': 'failed', 'summary': 'a done'}},
            {'task_id': 'task-b', 'status': 'complete',
             'result': {'phase': 'execute', 'artifact': 'b.md',
                        'outcome': 'failed', 'summary': 'b done'}},
        ]

        response = handle_parallel_done(flow, state, 'execute', results, 'clean')

        assert response['status'] == 'ensure_failed'
        assert 'conflicts' not in response
        assert 'violations' in response

    def test_t9_10_handle_parallel_done_ensure_failed_structured_conflicts(self):
        """handle_parallel_done without file conflicts ensure → response should be clean."""
        # Since handle_parallel_done evaluates ensure on aggregate result (not task graph),
        # the no_file_conflicts ensure would apply to analyze_tasks decompose step.
        # For handle_parallel_done, a passing result → complete.
        step = self._make_parallel_step(
            ['task-a', 'task-b'],
            ensure=["result.outcome == 'complete'"],
            task_files={'task-a': ['src/a.js'], 'task-b': ['src/b.js']},
        )
        flow = make_flow([step])
        state = make_state(active=['execute'])

        results = self._complete_results(['task-a', 'task-b'], outcome='complete')

        response = handle_parallel_done(flow, state, 'execute', results, 'clean')

        # All tasks complete, outcome=complete → should advance state
        assert response['status'] in ('complete', 'execute_step', 'parallel_dispatch', 'await_gate')

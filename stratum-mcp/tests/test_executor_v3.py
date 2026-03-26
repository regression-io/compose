"""
test_executor_v3.py — Unit tests for STRAT-PAR-3 executor ready-set model.

Tests:
  T1  — FlowState uses completed_steps/active_steps instead of current_idx
  T2  — ready_steps() computes correct ready step IDs
  T3  — topo_levels() groups tasks into dependency levels
  T4  — stratum_step_done returns parallel_dispatch envelope
  T5  — stratum_parallel_done validates and advances state
  T6  — stratum_resume migrates v0.2 current_idx state

Run with: pytest tests/test_executor_v3.py -v
"""

import pytest
from dataclasses import dataclass
from typing import Any

from stratum_mcp.executor import (
    FlowState,
    FlowDefinition,
    StepDefinition,
    Task,
    CycleError,
    ready_steps,
    topo_levels,
    compute_next_dispatch,
    handle_parallel_done,
    migrate_v2_state,
)


# ---------------------------------------------------------------------------
# Helpers — build minimal FlowDefinition / StepDefinition objects
# ---------------------------------------------------------------------------

def make_step(id: str, step_type: str = 'execute_step', depends_on: list = None,
              tasks: list = None, agent: str = 'claude',
              intent: str = 'Do the thing', intent_template: str = None,
              max_concurrent: int = 3, isolation: str = 'worktree',
              require: str = 'all', merge: str = 'sequential_apply',
              output_fields: dict = None, ensure: list = None) -> 'StepDefinition':
    return StepDefinition(
        id=id,
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
        output_fields=output_fields or {'phase': 'string', 'artifact': 'string',
                                         'outcome': 'string', 'summary': 'string'},
        ensure=ensure or [],
    )


def make_flow(steps: list, flow_id: str = 'flow-test') -> 'FlowDefinition':
    return FlowDefinition(flow_id=flow_id, name='test_flow', steps=steps)


def make_state(completed: set = None, active: set = None,
               results: dict = None) -> 'FlowState':
    return FlowState(
        flow_id='flow-test',
        flow_name='test_flow',
        completed_steps=set(completed or []),
        active_steps=set(active or []),
        step_results=dict(results or {}),
        retries={},
        violations={},
    )


def make_task(id: str, description: str = 'Do something',
              depends_on: list = None, files_owned: list = None,
              files_read: list = None) -> 'Task':
    return Task(
        id=id,
        description=description,
        depends_on=depends_on or [],
        files_owned=files_owned or [],
        files_read=files_read or [],
    )


# ---------------------------------------------------------------------------
# T1 — FlowState stores completed_steps / active_steps (not current_idx)
# ---------------------------------------------------------------------------

class TestFlowStateFields:
    def test_flowstate_has_completed_steps_field(self):
        state = make_state(completed={'s0', 's1'})
        assert state.completed_steps == {'s0', 's1'}

    def test_flowstate_has_active_steps_field(self):
        state = make_state(active={'s2'})
        assert state.active_steps == {'s2'}

    def test_flowstate_no_current_idx_field(self):
        """current_idx must not be a stored field — only a computed property."""
        state = make_state()
        # The FlowState dataclass must not have current_idx as a __init__ parameter
        import inspect
        params = list(inspect.signature(FlowState.__init__).parameters.keys())
        assert 'current_idx' not in params, \
            "current_idx must be removed as a stored field from FlowState"

    def test_current_idx_derived_property(self):
        """current_idx property returns len(completed_steps)."""
        state = make_state(completed={'s0', 's1', 's2'})
        assert state.current_idx == 3

    def test_current_idx_empty(self):
        state = make_state()
        assert state.current_idx == 0

    def test_completed_and_active_sets_are_independent(self):
        state = make_state(completed={'s0', 's1'}, active={'s2'})
        assert state.completed_steps == {'s0', 's1'}
        assert state.active_steps == {'s2'}
        assert state.completed_steps.isdisjoint(state.active_steps)


# ---------------------------------------------------------------------------
# T2 — ready_steps(state, flow_def)
# ---------------------------------------------------------------------------

class TestReadySteps:
    def test_sequential_first_step_is_ready(self):
        """Fresh state: first step (no deps) is ready."""
        flow = make_flow([make_step('s0'), make_step('s1', depends_on=['s0'])])
        state = make_state()
        assert ready_steps(state, flow) == ['s0']

    def test_sequential_second_step_after_first_complete(self):
        flow = make_flow([make_step('s0'), make_step('s1', depends_on=['s0'])])
        state = make_state(completed={'s0'})
        assert ready_steps(state, flow) == ['s1']

    def test_sequential_all_complete_returns_empty(self):
        flow = make_flow([make_step('s0'), make_step('s1', depends_on=['s0'])])
        state = make_state(completed={'s0', 's1'})
        assert ready_steps(state, flow) == []

    def test_ready_steps_sequential_four_step(self):
        """4-step linear flow: at each stage only one step is ready."""
        steps = [
            make_step('a'),
            make_step('b', depends_on=['a']),
            make_step('c', depends_on=['b']),
            make_step('d', depends_on=['c']),
        ]
        flow = make_flow(steps)

        assert ready_steps(make_state(), flow) == ['a']
        assert ready_steps(make_state(completed={'a'}), flow) == ['b']
        assert ready_steps(make_state(completed={'a', 'b'}), flow) == ['c']
        assert ready_steps(make_state(completed={'a', 'b', 'c'}), flow) == ['d']
        assert ready_steps(make_state(completed={'a', 'b', 'c', 'd'}), flow) == []

    def test_ready_steps_parallel_two_independent_after_shared_dep(self):
        """Two independent steps both appear when their common dep completes."""
        steps = [
            make_step('root'),
            make_step('branch_a', depends_on=['root']),
            make_step('branch_b', depends_on=['root']),
        ]
        flow = make_flow(steps)

        result = ready_steps(make_state(completed={'root'}), flow)
        assert set(result) == {'branch_a', 'branch_b'}, \
            f"Expected both branches ready, got {result}"

    def test_ready_steps_blocked_by_active(self):
        """A step blocked by an active (not completed) dep is excluded."""
        steps = [make_step('s0'), make_step('s1', depends_on=['s0'])]
        flow = make_flow(steps)

        # s0 active but not complete — s1 must NOT appear
        state = make_state(active={'s0'})
        result = ready_steps(state, flow)
        assert 's1' not in result

    def test_ready_steps_excludes_completed(self):
        """Completed steps are never returned as ready."""
        flow = make_flow([make_step('s0'), make_step('s1', depends_on=['s0'])])
        state = make_state(completed={'s0'})
        result = ready_steps(state, flow)
        assert 's0' not in result

    def test_ready_steps_excludes_active(self):
        """Active steps are never returned as ready."""
        steps = [make_step('s0'), make_step('s1', depends_on=['s0'])]
        flow = make_flow(steps)
        state = make_state(active={'s0'})
        result = ready_steps(state, flow)
        assert 's0' not in result


# ---------------------------------------------------------------------------
# T3 — topo_levels(tasks)
# ---------------------------------------------------------------------------

class TestTopoLevels:
    def test_empty_tasks(self):
        assert topo_levels([]) == []

    def test_single_task_no_deps(self):
        tasks = [make_task('t1')]
        result = topo_levels(tasks)
        assert len(result) == 1
        assert result[0][0].id == 't1'

    def test_two_levels(self):
        """t1, t2 independent (level 0); t3 depends on both (level 1)."""
        tasks = [
            make_task('t1'),
            make_task('t2'),
            make_task('t3', depends_on=['t1', 't2']),
        ]
        result = topo_levels(tasks)
        assert len(result) == 2

        level0_ids = {t.id for t in result[0]}
        level1_ids = {t.id for t in result[1]}
        assert level0_ids == {'t1', 't2'}
        assert level1_ids == {'t3'}

    def test_three_levels(self):
        """Chain: t1 → t2 → t3, each in its own level."""
        tasks = [
            make_task('t1'),
            make_task('t2', depends_on=['t1']),
            make_task('t3', depends_on=['t2']),
        ]
        result = topo_levels(tasks)
        assert len(result) == 3
        assert result[0][0].id == 't1'
        assert result[1][0].id == 't2'
        assert result[2][0].id == 't3'

    def test_cycle_detection_direct(self):
        """Direct cycle t1 → t2 → t1 raises CycleError."""
        tasks = [
            make_task('t1', depends_on=['t2']),
            make_task('t2', depends_on=['t1']),
        ]
        with pytest.raises(CycleError):
            topo_levels(tasks)

    def test_cycle_detection_indirect(self):
        """Indirect cycle t1 → t2 → t3 → t1 raises CycleError."""
        tasks = [
            make_task('t1', depends_on=['t3']),
            make_task('t2', depends_on=['t1']),
            make_task('t3', depends_on=['t2']),
        ]
        with pytest.raises(CycleError):
            topo_levels(tasks)


# ---------------------------------------------------------------------------
# T4 — compute_next_dispatch returns parallel_dispatch envelope
# ---------------------------------------------------------------------------

class TestComputeNextDispatch:
    def test_returns_execute_step_for_sequential(self):
        """Sequential flow: next dispatch is execute_step."""
        steps = [make_step('s0'), make_step('s1', depends_on=['s0'])]
        flow = make_flow(steps)
        state = make_state(completed={'s0'})

        result = compute_next_dispatch(flow, state)
        assert result['status'] == 'execute_step'
        assert result['step_id'] == 's1'

    def test_returns_complete_when_all_done(self):
        """All steps complete: returns {status: 'complete'}."""
        steps = [make_step('s0'), make_step('s1', depends_on=['s0'])]
        flow = make_flow(steps)
        state = make_state(completed={'s0', 's1'})

        result = compute_next_dispatch(flow, state)
        assert result['status'] == 'complete'

    def test_returns_parallel_dispatch_for_parallel_step(self):
        """When next ready step is parallel_dispatch type, return that envelope."""
        tasks = [
            make_task('t1', description='Implement feature A',
                      files_owned=['src/a.py'], files_read=[]),
            make_task('t2', description='Implement feature B',
                      files_owned=['src/b.py'], files_read=['src/a.py'],
                      depends_on=['t1']),
        ]
        par_step = make_step('execute', step_type='parallel_dispatch',
                              depends_on=['plan'],
                              tasks=tasks, intent_template='Do: {task.description}')
        steps = [make_step('plan'), par_step]
        flow = make_flow(steps)
        state = make_state(completed={'plan'})

        result = compute_next_dispatch(flow, state)

        assert result['status'] == 'parallel_dispatch'
        assert result['step_id'] == 'execute'
        assert 'tasks' in result
        assert len(result['tasks']) == 2
        assert result['intent_template'] == 'Do: {task.description}'

    def test_parallel_dispatch_response_shape(self):
        """parallel_dispatch response includes all required fields."""
        tasks = [make_task('t1', files_owned=['src/foo.py'])]
        par_step = make_step('run', step_type='parallel_dispatch',
                              tasks=tasks, agent='claude',
                              max_concurrent=2, isolation='worktree',
                              require='all', merge='sequential_apply',
                              ensure=['result.outcome == "complete"'])
        flow = make_flow([par_step])
        state = make_state()

        result = compute_next_dispatch(flow, state)

        assert result['status'] == 'parallel_dispatch'
        assert result['flow_id'] == flow.flow_id
        assert result['step_id'] == 'run'
        assert result['agent'] == 'claude'
        assert result['max_concurrent'] == 2
        assert result['isolation'] == 'worktree'
        assert result['require'] == 'all'
        assert result['merge'] == 'sequential_apply'
        assert 'tasks' in result
        assert 'output_fields' in result

    def test_step_marked_active_after_dispatch(self):
        """The dispatched step is added to active_steps."""
        steps = [make_step('s0'), make_step('s1', depends_on=['s0'])]
        flow = make_flow(steps)
        state = make_state(completed={'s0'})

        compute_next_dispatch(flow, state)
        assert 's1' in state.active_steps

    def test_parallel_step_marked_active(self):
        tasks = [make_task('t1')]
        par_step = make_step('run', step_type='parallel_dispatch', tasks=tasks)
        flow = make_flow([par_step])
        state = make_state()

        compute_next_dispatch(flow, state)
        assert 'run' in state.active_steps

    def test_sequential_flow_identical_to_v2_sequence(self):
        """4-step sequential flow: dispatch sequence matches v0.2 linear order."""
        steps = [
            make_step('explore'),
            make_step('design', depends_on=['explore']),
            make_step('implement', depends_on=['design']),
            make_step('review', depends_on=['implement']),
        ]
        flow = make_flow(steps)
        state = make_state()

        expected_order = ['explore', 'design', 'implement', 'review']
        dispatch_order = []

        for _ in range(4):
            result = compute_next_dispatch(flow, state)
            assert result['status'] == 'execute_step'
            sid = result['step_id']
            dispatch_order.append(sid)
            # Simulate completion
            state.completed_steps.add(sid)
            state.active_steps.discard(sid)
            state.step_results[sid] = {'outcome': 'complete'}

        final = compute_next_dispatch(flow, state)
        assert final['status'] == 'complete'
        assert dispatch_order == expected_order


# ---------------------------------------------------------------------------
# T5 — handle_parallel_done
# ---------------------------------------------------------------------------

class TestHandleParallelDone:
    def _make_flow_with_parallel(self):
        tasks = [
            make_task('t1', description='Task one', files_owned=['src/one.py']),
            make_task('t2', description='Task two', files_owned=['src/two.py']),
        ]
        par_step = make_step('execute', step_type='parallel_dispatch',
                              tasks=tasks, require='all', ensure=[])
        review_step = make_step('review', depends_on=['execute'])
        flow = make_flow([par_step, review_step])
        state = make_state(active={'execute'})
        return flow, state

    def test_all_complete_advances_state(self):
        flow, state = self._make_flow_with_parallel()
        task_results = [
            {'task_id': 't1', 'status': 'complete',
             'result': {'phase': 'execute', 'artifact': 'src/one.py',
                        'outcome': 'complete', 'summary': 'Done one'}},
            {'task_id': 't2', 'status': 'complete',
             'result': {'phase': 'execute', 'artifact': 'src/two.py',
                        'outcome': 'complete', 'summary': 'Done two'}},
        ]

        result = handle_parallel_done(flow, state, 'execute', task_results, 'clean')

        assert 'execute' in state.completed_steps
        assert 'execute' not in state.active_steps
        assert result['status'] in ('execute_step', 'complete', 'parallel_dispatch')

    def test_all_complete_returns_next_dispatch(self):
        flow, state = self._make_flow_with_parallel()
        task_results = [
            {'task_id': 't1', 'status': 'complete',
             'result': {'phase': 'execute', 'artifact': 'src/one.py',
                        'outcome': 'complete', 'summary': 'Done'}},
            {'task_id': 't2', 'status': 'complete',
             'result': {'phase': 'execute', 'artifact': 'src/two.py',
                        'outcome': 'complete', 'summary': 'Done'}},
        ]

        result = handle_parallel_done(flow, state, 'execute', task_results, 'clean')
        assert result['status'] == 'execute_step'
        assert result['step_id'] == 'review'

    def test_partial_failure_require_all_returns_ensure_failed(self):
        """When require=all and a task fails, return ensure_failed."""
        flow, state = self._make_flow_with_parallel()
        task_results = [
            {'task_id': 't1', 'status': 'complete',
             'result': {'phase': 'execute', 'artifact': 'src/one.py',
                        'outcome': 'complete', 'summary': 'Done'}},
            {'task_id': 't2', 'status': 'failed', 'error': 'Agent hit token limit'},
        ]

        result = handle_parallel_done(flow, state, 'execute', task_results, 'fallback')

        assert result['status'] == 'ensure_failed'
        assert any('t2' in str(v) for v in result.get('violations', [])), \
            f"Expected violation mentioning t2, got: {result.get('violations')}"

    def test_task_id_mismatch_returns_error(self):
        """Wrong task IDs → TASK_ID_MISMATCH error."""
        flow, state = self._make_flow_with_parallel()
        task_results = [
            {'task_id': 'wrong_id', 'status': 'complete',
             'result': {'outcome': 'complete'}},
        ]

        result = handle_parallel_done(flow, state, 'execute', task_results, 'clean')

        assert result['status'] == 'error'
        assert result.get('error', {}).get('code') == 'TASK_ID_MISMATCH'

    def test_aggregate_result_stored_in_step_results(self):
        """Aggregate result is stored in state.step_results[step_id]."""
        flow, state = self._make_flow_with_parallel()
        task_results = [
            {'task_id': 't1', 'status': 'complete',
             'result': {'phase': 'execute', 'artifact': 'src/one.py',
                        'outcome': 'complete', 'summary': 'Done one'}},
            {'task_id': 't2', 'status': 'complete',
             'result': {'phase': 'execute', 'artifact': 'src/two.py',
                        'outcome': 'complete', 'summary': 'Done two'}},
        ]

        handle_parallel_done(flow, state, 'execute', task_results, 'clean')

        assert 'execute' in state.step_results
        agg = state.step_results['execute']
        assert agg.get('outcome') == 'complete'


# ---------------------------------------------------------------------------
# T6 — migrate_v2_state (stratum_resume migration)
# ---------------------------------------------------------------------------

class TestMigrateV2State:
    def test_v2_state_migrated_from_current_idx(self):
        """Old current_idx=3 → completed_steps = {s0, s1, s2}."""
        steps = [
            make_step('s0'), make_step('s1'), make_step('s2'), make_step('s3'),
        ]
        flow = make_flow(steps)

        raw = {'current_idx': 3, 'step_results': {}}
        result = migrate_v2_state(raw, flow)

        assert 'completed_steps' in result
        assert set(result['completed_steps']) == {'s0', 's1', 's2'}
        assert result.get('active_steps', []) == [] or set(result['active_steps']) == set()

    def test_v2_state_no_completed_steps_key_triggers_migration(self):
        """If completed_steps is absent, migrate from current_idx."""
        steps = [make_step('a'), make_step('b'), make_step('c')]
        flow = make_flow(steps)

        raw = {'current_idx': 1, 'step_results': {}}
        result = migrate_v2_state(raw, flow)

        assert set(result['completed_steps']) == {'a'}

    def test_v3_state_not_modified(self):
        """v0.3 state (has completed_steps) is returned unchanged."""
        steps = [make_step('a'), make_step('b')]
        flow = make_flow(steps)

        raw = {
            'completed_steps': ['a'],
            'active_steps': ['b'],
            'step_results': {},
        }
        result = migrate_v2_state(raw, flow)

        assert result['completed_steps'] == ['a']
        assert result['active_steps'] == ['b']

    def test_v2_zero_current_idx_gives_empty_completed(self):
        """current_idx=0 means no steps completed yet."""
        steps = [make_step('s0'), make_step('s1')]
        flow = make_flow(steps)

        raw = {'current_idx': 0, 'step_results': {}}
        result = migrate_v2_state(raw, flow)

        assert set(result['completed_steps']) == set()
        assert result.get('active_steps', []) == [] or set(result['active_steps']) == set()

"""
test_spec_v03.py — Schema validation test matrix for IR v0.3

Tests all 25+ cases from STRAT-PAR-1 plan.md §Task 10 and blueprint §8.

Run with: pytest tests/test_spec_v03.py -v
"""

import pytest
from stratum_mcp.spec import (
    parse_and_validate,
    V03_BUILTIN_CONTRACTS,
    V03_ADDITIONS,
    SCHEMAS,
    expand_intent_template,
    no_file_conflicts,
    IRSemanticError,
    EnsureViolation,
)


# ---------------------------------------------------------------------------
# Minimal specs as Python strings
# ---------------------------------------------------------------------------

# A "decompose" step that emits TaskGraph, followed by parallel_dispatch
MINIMAL_V03_SPEC = """\
version: "0.3"

contracts:
  PhaseResult:
    phase:    {type: string}
    artifact: {type: string}
    outcome:  {type: string}

flows:
  build:
    input:
      featureCode: {type: string}
    output: PhaseResult
    steps:
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break the feature into independent tasks. Return a TaskGraph."
        inputs:
          featureCode: "$.input.featureCode"
        output_contract: TaskGraph

      - id: run_tasks
        type: parallel_dispatch
        source: "$.steps.decompose_tasks.output"
        intent_template: "Implement task: {task.description}\\nOwn: {task.files_owned}\\nRead: {task.files_read}"
        max_concurrent: 3
        isolation: worktree
        require: all
        merge: sequential_apply
        depends_on: [decompose_tasks]
"""

# Full annotated spec with all optional fields
FULL_V03_SPEC = """\
version: "0.3"

contracts:
  PhaseResult:
    phase:    {type: string}
    artifact: {type: string}
    outcome:  {type: string}
    summary:  {type: string}

functions:
  plan_gate:
    mode: gate
    timeout: 3600

flows:
  build:
    input:
      featureCode: {type: string}
      description: {type: string}
    output: PhaseResult
    steps:
      - id: plan
        agent: claude
        intent: "Write an implementation plan."
        inputs:
          featureCode: "$.input.featureCode"
        output_contract: PhaseResult
        retries: 2

      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break the feature into independent tasks. Return a TaskGraph."
        inputs:
          featureCode: "$.input.featureCode"
        output_contract: TaskGraph
        retries: 1
        skip_if: "false"
        depends_on: [plan]

      - id: run_tasks
        type: parallel_dispatch
        source: "$.steps.decompose_tasks.output"
        intent_template: "Implement: {task.description}\\nFiles: {task.files_owned}\\nInput: {input.featureCode}"
        max_concurrent: 4
        isolation: worktree
        require: all
        merge: sequential_apply
        depends_on: [decompose_tasks]
"""

# A v0.2 spec (the existing build pipeline) validated by the v0.3 parser
V02_SPEC = """\
version: "0.2"

contracts:
  PhaseResult:
    phase:    {type: string}
    artifact: {type: string}
    outcome:  {type: string, values: [complete, skipped, failed]}
    summary:  {type: string}

functions:
  design_gate:
    mode: gate
    timeout: 3600

flows:
  build:
    input:
      featureCode: {type: string}
      description: {type: string}
    output: PhaseResult
    steps:
      - id: explore_design
        agent: claude
        intent: "Explore the codebase and write a design doc."
        inputs:
          featureCode: "$.input.featureCode"
          description: "$.input.description"
        output_contract: PhaseResult
        ensure:
          - "result.outcome == 'complete'"
        retries: 2

      - id: design_gate
        function: design_gate
        on_approve: plan
        on_revise: explore_design
        on_kill: null
        depends_on: [explore_design]

      - id: plan
        agent: claude
        intent: "Write an implementation plan."
        inputs:
          featureCode: "$.input.featureCode"
        output_contract: PhaseResult
        retries: 2
        depends_on: [design_gate]
"""


def make_spec(extra_steps="", version="0.3", extra_contracts="", extra_functions=""):
    """Helper to build a spec with custom steps."""
    contracts = f"""
contracts:
  PhaseResult:
    phase:    {{type: string}}
    artifact: {{type: string}}
    outcome:  {{type: string}}
{extra_contracts}"""
    functions = f"""
functions:
  my_gate:
    mode: gate
    timeout: 1800
{extra_functions}""" if extra_functions else ""
    return f"""\
version: "{version}"
{contracts}
{functions}
flows:
  build:
    input:
      featureCode: {{type: string}}
    output: PhaseResult
    steps:
      - id: setup
        agent: claude
        intent: "Setup step."
        inputs:
          featureCode: "$.input.featureCode"
        output_contract: PhaseResult
        retries: 1
{extra_steps}
"""


# ---------------------------------------------------------------------------
# Valid specs — cases 1–8
# ---------------------------------------------------------------------------

class TestValidSpecs:

    def test_case1_minimal_v03_spec(self):
        """Case 1: Minimal v0.3 spec with decompose + parallel_dispatch."""
        result = parse_and_validate(MINIMAL_V03_SPEC)
        assert result is not None, "valid spec should parse without error"

    def test_case2_full_annotated_spec(self):
        """Case 2: Full annotated spec with all optional fields."""
        result = parse_and_validate(FULL_V03_SPEC)
        assert result is not None, "full spec should parse without error"

    def test_case3_v02_spec_passes_v03_parser(self):
        """Case 3: v0.2 spec parsed by v0.3 parser — all steps pass."""
        result = parse_and_validate(V02_SPEC)
        assert result is not None, "v0.2 spec must pass v0.3 validation unchanged"

    def test_case4_decompose_with_skip_if(self):
        """Case 4: decompose step with skip_if is allowed."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: TaskGraph
        skip_if: "True"
        depends_on: [setup]

      - id: run_tasks
        type: parallel_dispatch
        source: "$.steps.decompose_tasks.output"
        intent_template: "Do: {task.description}"
        depends_on: [decompose_tasks]
""")
        result = parse_and_validate(spec)
        assert result is not None

    def test_case5_parallel_dispatch_with_skip_if(self):
        """Case 5: parallel_dispatch with skip_if is allowed."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: TaskGraph
        depends_on: [setup]

      - id: run_tasks
        type: parallel_dispatch
        source: "$.steps.decompose_tasks.output"
        intent_template: "Do: {task.description}"
        skip_if: "False"
        depends_on: [decompose_tasks]
""")
        result = parse_and_validate(spec)
        assert result is not None

    def test_case6_parallel_dispatch_require_integer(self):
        """Case 6: parallel_dispatch with require: 2 (integer require)."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: TaskGraph
        depends_on: [setup]

      - id: run_tasks
        type: parallel_dispatch
        source: "$.steps.decompose_tasks.output"
        intent_template: "Do: {task.description}"
        require: 2
        depends_on: [decompose_tasks]
""")
        result = parse_and_validate(spec)
        assert result is not None

    def test_case7_parallel_dispatch_isolation_branch(self):
        """Case 7: parallel_dispatch with isolation: branch."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: TaskGraph
        depends_on: [setup]

      - id: run_tasks
        type: parallel_dispatch
        source: "$.steps.decompose_tasks.output"
        intent_template: "Do: {task.description}"
        isolation: branch
        depends_on: [decompose_tasks]
""")
        result = parse_and_validate(spec)
        assert result is not None

    def test_case8_parallel_dispatch_merge_manual(self):
        """Case 8: parallel_dispatch with merge: manual."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: TaskGraph
        depends_on: [setup]

      - id: run_tasks
        type: parallel_dispatch
        source: "$.steps.decompose_tasks.output"
        intent_template: "Do: {task.description}"
        merge: manual
        depends_on: [decompose_tasks]
""")
        result = parse_and_validate(spec)
        assert result is not None


# ---------------------------------------------------------------------------
# Decompose rule violations — cases 9–12
# ---------------------------------------------------------------------------

class TestDecomposeRuleViolations:

    def test_case9_d1_wrong_output_contract(self):
        """Case 9: D1 — output_contract must be TaskGraph on decompose step."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: PhaseResult
        depends_on: [setup]
""")
        with pytest.raises(IRSemanticError, match="IR_V03_DECOMPOSE_INCOMPATIBLE_CONTRACT"):
            parse_and_validate(spec)

    def test_case10_d2_no_intent(self):
        """Case 10: D2 — decompose step must have intent field."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        output_contract: TaskGraph
        depends_on: [setup]
""")
        with pytest.raises(IRSemanticError, match="IR_V03_DECOMPOSE_NO_INTENT"):
            parse_and_validate(spec)

    def test_case11_d3_forbidden_source_field(self):
        """Case 11: D3 — decompose step must not have source field."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: TaskGraph
        source: "$.steps.setup.output"
        depends_on: [setup]
""")
        with pytest.raises(IRSemanticError, match="IR_V03_DECOMPOSE_FORBIDDEN_FIELD"):
            parse_and_validate(spec)

    def test_case12_d3_forbidden_max_concurrent_field(self):
        """Case 12: D3 — decompose step must not have max_concurrent field."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: TaskGraph
        max_concurrent: 4
        depends_on: [setup]
""")
        with pytest.raises(IRSemanticError, match="IR_V03_DECOMPOSE_FORBIDDEN_FIELD"):
            parse_and_validate(spec)

    def test_case12b_d4_gate_function_forbidden(self):
        """D4 — decompose step must not reference a gate function."""
        spec = """\
version: "0.3"

contracts:
  PhaseResult:
    phase:   {type: string}
    outcome: {type: string}

functions:
  gate_fn:
    mode: gate
    timeout: 100

flows:
  build:
    input:
      featureCode: {type: string}
    output: PhaseResult
    steps:
      - id: decompose_tasks
        type: decompose
        function: gate_fn
        intent: "Break into tasks."
        output_contract: TaskGraph
"""
        with pytest.raises(IRSemanticError, match="IR_V03_DECOMPOSE_GATE_FORBIDDEN"):
            parse_and_validate(spec)


# ---------------------------------------------------------------------------
# Parallel dispatch rule violations — cases 13–18
# ---------------------------------------------------------------------------

class TestParallelDispatchRuleViolations:

    def test_case13_p1_no_source(self):
        """Case 13: P1 — parallel_dispatch must have source field."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: TaskGraph
        depends_on: [setup]

      - id: run_tasks
        type: parallel_dispatch
        intent_template: "Do: {task.description}"
        depends_on: [decompose_tasks]
""")
        with pytest.raises(IRSemanticError, match="IR_V03_PARALLEL_NO_SOURCE"):
            parse_and_validate(spec)

    def test_case13b_p1_invalid_source_jsonpath(self):
        """P1 — parallel_dispatch source must be a valid JSONPath."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: TaskGraph
        depends_on: [setup]

      - id: run_tasks
        type: parallel_dispatch
        source: "steps.decompose_tasks.output"
        intent_template: "Do: {task.description}"
        depends_on: [decompose_tasks]
""")
        with pytest.raises(IRSemanticError, match="IR_V03_PARALLEL_NO_SOURCE"):
            parse_and_validate(spec)

    def test_case14_p2_no_intent_template(self):
        """Case 14: P2 — parallel_dispatch must have intent_template field."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: TaskGraph
        depends_on: [setup]

      - id: run_tasks
        type: parallel_dispatch
        source: "$.steps.decompose_tasks.output"
        depends_on: [decompose_tasks]
""")
        with pytest.raises(IRSemanticError, match="IR_V03_PARALLEL_NO_TEMPLATE"):
            parse_and_validate(spec)

    def test_case15_p3_has_intent_field(self):
        """Case 15: P3 — parallel_dispatch must NOT have intent field."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: TaskGraph
        depends_on: [setup]

      - id: run_tasks
        type: parallel_dispatch
        source: "$.steps.decompose_tasks.output"
        intent_template: "Do: {task.description}"
        intent: "This should be forbidden"
        depends_on: [decompose_tasks]
""")
        with pytest.raises(IRSemanticError, match="IR_V03_PARALLEL_HAS_INTENT"):
            parse_and_validate(spec)

    def test_case16_p4_source_not_prior(self):
        """Case 16: P4 — source must reference a step that comes before."""
        # run_tasks is BEFORE decompose_tasks in step order
        spec = make_spec(extra_steps="""\
      - id: run_tasks
        type: parallel_dispatch
        source: "$.steps.decompose_tasks.output"
        intent_template: "Do: {task.description}"
        depends_on: [setup]

      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: TaskGraph
        depends_on: [setup]
""")
        with pytest.raises(IRSemanticError, match="IR_V03_PARALLEL_SOURCE_NOT_PRIOR"):
            parse_and_validate(spec)

    def test_case17_p5_source_not_decompose(self):
        """Case 17: P5 — source must reference a decompose step (not a function step)."""
        spec = make_spec(extra_steps="""\
      - id: run_tasks
        type: parallel_dispatch
        source: "$.steps.setup.output"
        intent_template: "Do: {task.description}"
        depends_on: [setup]
""")
        with pytest.raises(IRSemanticError, match="IR_V03_PARALLEL_SOURCE_NOT_DECOMPOSE"):
            parse_and_validate(spec)

    def test_case18_p6_nested_parallel_dispatch(self):
        """Case 18: P6 — nested parallel_dispatch inside parallel_dispatch is forbidden."""
        # NOTE: This tests nesting in the same flow; exact mechanism depends on implementation.
        # The parser should detect that parallel_dispatch cannot be inside parallel_dispatch.
        spec = """\
version: "0.3"

contracts:
  PhaseResult:
    phase:    {type: string}
    artifact: {type: string}
    outcome:  {type: string}

flows:
  inner:
    input:
      source_data: {type: object}
    output: PhaseResult
    steps:
      - id: nested_parallel
        type: parallel_dispatch
        source: "$.input.source_data"
        intent_template: "Do: {task.description}"

  outer:
    input:
      featureCode: {type: string}
    output: PhaseResult
    steps:
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        inputs:
          featureCode: "$.input.featureCode"
        output_contract: TaskGraph

      - id: outer_parallel
        type: parallel_dispatch
        source: "$.steps.decompose_tasks.output"
        intent_template: "Do: {task.description}"
        flow: inner
        depends_on: [decompose_tasks]
"""
        with pytest.raises(IRSemanticError, match="IR_V03_NESTED_PARALLEL"):
            parse_and_validate(spec)


# ---------------------------------------------------------------------------
# Cross-type violations — cases 19–21
# ---------------------------------------------------------------------------

class TestCrossTypeViolations:

    def test_case19_x1_source_on_function_step(self):
        """Case 19: X1 — v0.3-exclusive fields (source) rejected on function steps."""
        spec = make_spec(extra_steps="""\
      - id: bad_function_step
        agent: claude
        intent: "This step uses source which is v0.3-exclusive."
        source: "$.steps.setup.output"
        output_contract: PhaseResult
        depends_on: [setup]
""")
        with pytest.raises(IRSemanticError, match="IR_V03_FIELD_ON_WRONG_TYPE"):
            parse_and_validate(spec)

    def test_case20_x3_user_contract_named_taskgraph(self):
        """Case 20: X3 — user-defined contract named TaskGraph is forbidden in v0.3."""
        spec = """\
version: "0.3"

contracts:
  PhaseResult:
    phase:    {type: string}
    artifact: {type: string}
    outcome:  {type: string}
  TaskGraph:
    custom: {type: string}

flows:
  build:
    input:
      featureCode: {type: string}
    output: PhaseResult
    steps:
      - id: setup
        agent: claude
        intent: "Setup."
        output_contract: PhaseResult
"""
        with pytest.raises(IRSemanticError, match="IR_V03_TASKGRAPH_RESERVED"):
            parse_and_validate(spec)

    def test_case21_x4_no_file_conflicts_as_function_name(self):
        """Case 21: X4 — no_file_conflicts as user function name is forbidden in v0.3."""
        spec = """\
version: "0.3"

contracts:
  PhaseResult:
    phase:    {type: string}
    outcome:  {type: string}

functions:
  no_file_conflicts:
    mode: gate
    timeout: 100

flows:
  build:
    input:
      featureCode: {type: string}
    output: PhaseResult
    steps:
      - id: setup
        agent: claude
        intent: "Setup."
        output_contract: PhaseResult
"""
        with pytest.raises(IRSemanticError, match="IR_V03_BUILTIN_RESERVED"):
            parse_and_validate(spec)

    def test_case21b_x4_no_file_conflicts_as_contract_name(self):
        """X4 — no_file_conflicts as user contract name is forbidden in v0.3."""
        spec = """\
version: "0.3"

contracts:
  no_file_conflicts:
    outcome: {type: string}
  PhaseResult:
    outcome: {type: string}

flows:
  build:
    input:
      featureCode: {type: string}
    output: PhaseResult
    steps:
      - id: setup
        agent: claude
        intent: "Setup."
        output_contract: PhaseResult
"""
        with pytest.raises(IRSemanticError, match="IR_V03_BUILTIN_RESERVED"):
            parse_and_validate(spec)

    def test_case_x2_cross_flow_source(self):
        """X2 — parallel_dispatch source must not reference a step in a different flow."""
        # 'outer' flow references 'decompose_tasks' which lives in 'inner' flow — forbidden.
        spec = """\
version: "0.3"

contracts:
  PhaseResult:
    phase:    {type: string}
    artifact: {type: string}
    outcome:  {type: string}

flows:
  inner:
    input:
      featureCode: {type: string}
    output: PhaseResult
    steps:
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        inputs:
          featureCode: "$.input.featureCode"
        output_contract: TaskGraph

  outer:
    input:
      featureCode: {type: string}
    output: PhaseResult
    steps:
      - id: run_tasks
        type: parallel_dispatch
        source: "$.steps.decompose_tasks.output"
        intent_template: "Do: {task.description}"
"""
        with pytest.raises(IRSemanticError, match="IR_V03_PARALLEL_CROSS_FLOW_SOURCE"):
            parse_and_validate(spec)


# ---------------------------------------------------------------------------
# Default application — cases 22–25 (no error, verify applied defaults)
# ---------------------------------------------------------------------------

class TestDefaultApplication:
    """P7–P10: When optional fields are absent, defaults are silently applied."""

    def _parse_get_step(self, spec_str, step_id):
        """Parse spec and return the validated step dict with defaults applied."""
        result = parse_and_validate(spec_str)
        # result should be the validated spec dict; find the step by id
        for flow_name, flow_def in result.get("flows", {}).items():
            for step in flow_def.get("steps", []):
                if step.get("id") == step_id:
                    return step
        raise KeyError(f"Step '{step_id}' not found in validated spec")

    def test_case22_default_max_concurrent(self):
        """Case 22: parallel_dispatch with no max_concurrent defaults to 3."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: TaskGraph
        depends_on: [setup]

      - id: run_tasks
        type: parallel_dispatch
        source: "$.steps.decompose_tasks.output"
        intent_template: "Do: {task.description}"
        depends_on: [decompose_tasks]
""")
        step = self._parse_get_step(spec, "run_tasks")
        assert step.get("max_concurrent") == 3, (
            f"Expected default max_concurrent=3, got {step.get('max_concurrent')}"
        )

    def test_case23_default_isolation(self):
        """Case 23: parallel_dispatch with no isolation defaults to 'worktree'."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: TaskGraph
        depends_on: [setup]

      - id: run_tasks
        type: parallel_dispatch
        source: "$.steps.decompose_tasks.output"
        intent_template: "Do: {task.description}"
        depends_on: [decompose_tasks]
""")
        step = self._parse_get_step(spec, "run_tasks")
        assert step.get("isolation") == "worktree", (
            f"Expected default isolation='worktree', got {step.get('isolation')}"
        )

    def test_case24_default_require(self):
        """Case 24: parallel_dispatch with no require defaults to 'all'."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: TaskGraph
        depends_on: [setup]

      - id: run_tasks
        type: parallel_dispatch
        source: "$.steps.decompose_tasks.output"
        intent_template: "Do: {task.description}"
        depends_on: [decompose_tasks]
""")
        step = self._parse_get_step(spec, "run_tasks")
        assert step.get("require") == "all", (
            f"Expected default require='all', got {step.get('require')}"
        )

    def test_case25_default_merge(self):
        """Case 25: parallel_dispatch with no merge defaults to 'sequential_apply'."""
        spec = make_spec(extra_steps="""\
      - id: decompose_tasks
        type: decompose
        agent: claude
        intent: "Break into tasks."
        output_contract: TaskGraph
        depends_on: [setup]

      - id: run_tasks
        type: parallel_dispatch
        source: "$.steps.decompose_tasks.output"
        intent_template: "Do: {task.description}"
        depends_on: [decompose_tasks]
""")
        step = self._parse_get_step(spec, "run_tasks")
        assert step.get("merge") == "sequential_apply", (
            f"Expected default merge='sequential_apply', got {step.get('merge')}"
        )


# ---------------------------------------------------------------------------
# Bonus: SCHEMAS["0.2"] snapshot test — case 26
# ---------------------------------------------------------------------------

class TestBackwardCompatibilitySnapshot:

    def test_case26_schemas_02_unchanged(self):
        """Case 26: SCHEMAS['0.2'] must be byte-for-byte identical before and after v0.3 additions."""
        from stratum_mcp.spec import SCHEMAS, V02_SNAPSHOT
        import json
        v02_serialized = json.dumps(SCHEMAS["0.2"], sort_keys=True)
        snapshot_serialized = json.dumps(V02_SNAPSHOT, sort_keys=True)
        assert v02_serialized == snapshot_serialized, (
            "SCHEMAS['0.2'] was mutated — backward compatibility invariant violated"
        )


# ---------------------------------------------------------------------------
# no_file_conflicts() unit tests
# ---------------------------------------------------------------------------

class TestNoFileConflicts:

    def test_empty_tasks_returns_true(self):
        """no_file_conflicts([]) returns True."""
        assert no_file_conflicts([]) is True

    def test_independent_tasks_overlapping_files_owned_raises(self):
        """Two independent tasks with overlapping files_owned raise EnsureViolation."""
        tasks = [
            {"id": "task-001", "files_owned": ["src/foo.jsx"], "depends_on": []},
            {"id": "task-002", "files_owned": ["src/foo.jsx"], "depends_on": []},
        ]
        with pytest.raises(EnsureViolation) as exc_info:
            no_file_conflicts(tasks)
        violation = exc_info.value
        assert "task-001" in str(violation) or "task-002" in str(violation)
        assert "src/foo.jsx" in str(violation)

    def test_dependent_tasks_overlapping_files_owned_returns_true(self):
        """Tasks where one depends_on the other with overlapping files_owned: no conflict."""
        tasks = [
            {"id": "task-001", "files_owned": ["src/foo.jsx"], "depends_on": []},
            {"id": "task-002", "files_owned": ["src/foo.jsx"], "depends_on": ["task-001"]},
        ]
        # task-002 depends on task-001, so no parallel conflict
        result = no_file_conflicts(tasks)
        assert result is True

    def test_files_read_overlap_is_not_a_conflict(self):
        """Two tasks with overlapping files_read only: not a conflict."""
        tasks = [
            {"id": "task-001", "files_owned": [], "files_read": ["src/shared.js"], "depends_on": []},
            {"id": "task-002", "files_owned": [], "files_read": ["src/shared.js"], "depends_on": []},
        ]
        result = no_file_conflicts(tasks)
        assert result is True

    def test_three_tasks_one_conflict(self):
        """Three tasks where only two have a conflict."""
        tasks = [
            {"id": "task-001", "files_owned": ["src/a.js"], "depends_on": []},
            {"id": "task-002", "files_owned": ["src/b.js"], "depends_on": []},
            {"id": "task-003", "files_owned": ["src/a.js"], "depends_on": []},
        ]
        with pytest.raises(EnsureViolation):
            no_file_conflicts(tasks)

    def test_conflict_detail_includes_file_list(self):
        """EnsureViolation from no_file_conflicts includes conflicting file list."""
        tasks = [
            {"id": "task-001", "files_owned": ["src/foo.jsx", "src/bar.jsx"], "depends_on": []},
            {"id": "task-002", "files_owned": ["src/foo.jsx"], "depends_on": []},
        ]
        with pytest.raises(EnsureViolation) as exc_info:
            no_file_conflicts(tasks)
        violation = exc_info.value
        # The violation must expose the conflicting files
        assert hasattr(violation, "conflicts") or "conflicts" in str(violation)


# ---------------------------------------------------------------------------
# expand_intent_template() unit tests
# ---------------------------------------------------------------------------

class TestExpandIntentTemplate:

    def test_task_id_token(self):
        """{{task.id}} expands to task id."""
        result = expand_intent_template(
            "Implement {task.id}",
            task={"id": "task-001", "description": "foo"},
            flow_inputs={}
        )
        assert result == "Implement task-001"

    def test_task_description_token(self):
        """{{task.description}} expands to task description."""
        result = expand_intent_template(
            "Do: {task.description}",
            task={"id": "t1", "description": "Replace BoardView"},
            flow_inputs={}
        )
        assert result == "Do: Replace BoardView"

    def test_task_files_owned_token(self):
        """{{task.files_owned}} expands to comma-separated list."""
        result = expand_intent_template(
            "Own: {task.files_owned}",
            task={"id": "t1", "description": "foo", "files_owned": ["src/a.js", "src/b.js"]},
            flow_inputs={}
        )
        assert result == "Own: src/a.js, src/b.js"

    def test_task_files_owned_empty_list_expands_to_empty_string(self):
        """{{task.files_owned}} with empty list expands to '' (not '[]')."""
        result = expand_intent_template(
            "Own: {task.files_owned}",
            task={"id": "t1", "description": "foo", "files_owned": []},
            flow_inputs={}
        )
        assert result == "Own: "

    def test_task_files_read_token(self):
        """{{task.files_read}} expands to comma-separated list."""
        result = expand_intent_template(
            "Read: {task.files_read}",
            task={"id": "t1", "description": "foo", "files_read": ["src/utils.js"]},
            flow_inputs={}
        )
        assert result == "Read: src/utils.js"

    def test_task_depends_on_token(self):
        """{{task.depends_on}} expands to comma-separated deps."""
        result = expand_intent_template(
            "After: {task.depends_on}",
            task={"id": "t2", "description": "bar", "depends_on": ["task-001"]},
            flow_inputs={}
        )
        assert result == "After: task-001"

    def test_task_index_token(self):
        """{{task.index}} expands to the zero-based index."""
        result = expand_intent_template(
            "Index: {task.index}",
            task={"id": "t1", "description": "foo", "_index": 3},
            flow_inputs={}
        )
        assert result == "Index: 3"

    def test_task_index_token_defaults_to_zero_when_absent(self):
        """{{task.index}} defaults to '0' when _index is not in the task dict."""
        result = expand_intent_template(
            "Index: {task.index}",
            task={"id": "t1", "description": "foo"},
            flow_inputs={}
        )
        assert result == "Index: 0", (
            "When _index is absent, {task.index} must expand to '0', not be left as-is"
        )

    def test_input_field_token(self):
        """{{input.featureCode}} expands from flow_inputs."""
        result = expand_intent_template(
            "Feature: {input.featureCode}",
            task={"id": "t1", "description": "foo"},
            flow_inputs={"featureCode": "STRAT-PAR-1"}
        )
        assert result == "Feature: STRAT-PAR-1"

    def test_unrecognized_token_left_as_is(self):
        """Unrecognized tokens like {{task.foo}} are left as-is in output."""
        result = expand_intent_template(
            "Mystery: {task.foo}",
            task={"id": "t1", "description": "foo"},
            flow_inputs={}
        )
        assert result == "Mystery: {task.foo}"

    def test_multiple_tokens_in_template(self):
        """Multiple tokens all expand correctly."""
        result = expand_intent_template(
            "Task {task.id}: {task.description} — own {task.files_owned}",
            task={
                "id": "task-007",
                "description": "Replace LoginForm",
                "files_owned": ["src/LoginForm.jsx"],
            },
            flow_inputs={}
        )
        assert result == "Task task-007: Replace LoginForm — own src/LoginForm.jsx"

    def test_pure_function_no_side_effects(self):
        """expand_intent_template is pure — does not mutate task or flow_inputs."""
        task = {"id": "t1", "description": "foo", "files_owned": ["a.js"]}
        flow_inputs = {"featureCode": "X-1"}
        task_before = dict(task)
        inputs_before = dict(flow_inputs)
        expand_intent_template("{task.id} {input.featureCode}", task=task, flow_inputs=flow_inputs)
        assert task == task_before
        assert flow_inputs == inputs_before


# ---------------------------------------------------------------------------
# Module-level structure tests
# ---------------------------------------------------------------------------

class TestModuleStructure:

    def test_v03_builtin_contracts_has_taskgraph(self):
        """V03_BUILTIN_CONTRACTS defines the TaskGraph contract."""
        assert "TaskGraph" in V03_BUILTIN_CONTRACTS
        tg = V03_BUILTIN_CONTRACTS["TaskGraph"]
        assert "tasks" in tg

    def test_taskgraph_tasks_item_has_required_fields(self):
        """TaskGraph items require id and description."""
        items = V03_BUILTIN_CONTRACTS["TaskGraph"]["tasks"]["items"]
        assert "id" in items.get("required", [])
        assert "description" in items.get("required", [])

    def test_taskgraph_optional_fields_have_defaults(self):
        """depends_on, files_owned, files_read have default []."""
        props = V03_BUILTIN_CONTRACTS["TaskGraph"]["tasks"]["items"]["properties"]
        assert props["depends_on"]["default"] == []
        assert props["files_owned"]["default"] == []
        assert props["files_read"]["default"] == []

    def test_v03_additions_step_type_enum(self):
        """V03_ADDITIONS step.type enum includes decompose and parallel_dispatch."""
        step_type = V03_ADDITIONS["step.type"]
        assert "decompose" in step_type["enum"]
        assert "parallel_dispatch" in step_type["enum"]
        # Must also include existing types
        assert "function" in step_type["enum"]
        assert "inline" in step_type["enum"]
        assert "flow" in step_type["enum"]

    def test_v03_additions_has_field_schemas(self):
        """V03_ADDITIONS contains JSON Schema fragments for all new step fields."""
        assert "step.source" in V03_ADDITIONS, "step.source schema must be in V03_ADDITIONS"
        assert "step.max_concurrent" in V03_ADDITIONS, "step.max_concurrent schema must be in V03_ADDITIONS"
        assert "step.isolation" in V03_ADDITIONS, "step.isolation schema must be in V03_ADDITIONS"
        assert "step.require" in V03_ADDITIONS, "step.require schema must be in V03_ADDITIONS"
        assert "step.merge" in V03_ADDITIONS, "step.merge schema must be in V03_ADDITIONS"
        assert "step.intent_template" in V03_ADDITIONS, "step.intent_template schema must be in V03_ADDITIONS"

    def test_v03_additions_max_concurrent_has_minimum(self):
        """step.max_concurrent schema has minimum: 1."""
        assert V03_ADDITIONS["step.max_concurrent"].get("minimum") == 1

    def test_v03_additions_require_uses_one_of(self):
        """step.require schema uses oneOf covering string enum and integer."""
        require_schema = V03_ADDITIONS["step.require"]
        assert "oneOf" in require_schema
        one_of = require_schema["oneOf"]
        enum_schemas = [s for s in one_of if "enum" in s]
        int_schemas  = [s for s in one_of if s.get("type") == "integer"]
        assert enum_schemas, "oneOf must include an enum option (all/any)"
        assert int_schemas,  "oneOf must include an integer option"
        assert "all" in enum_schemas[0]["enum"]
        assert "any" in enum_schemas[0]["enum"]

    def test_v03_additions_merge_enum(self):
        """step.merge schema enum covers exactly sequential_apply and manual."""
        merge_schema = V03_ADDITIONS["step.merge"]
        assert set(merge_schema.get("enum", [])) == {"sequential_apply", "manual"}

    def test_v03_additions_isolation_enum(self):
        """step.isolation schema enum covers exactly worktree and branch."""
        isolation_schema = V03_ADDITIONS["step.isolation"]
        assert set(isolation_schema.get("enum", [])) == {"worktree", "branch"}

    def test_schemas_has_v03_entry(self):
        """SCHEMAS dict contains a '0.3' entry."""
        assert "0.3" in SCHEMAS

    def test_schemas_v02_is_present(self):
        """SCHEMAS dict still contains '0.2' entry."""
        assert "0.2" in SCHEMAS

    def test_schemas_v02_not_modified(self):
        """SCHEMAS['0.2'] does NOT contain decompose or parallel_dispatch."""
        v02_step_types = SCHEMAS["0.2"].get("step", {}).get("type", {}).get("enum", [])
        assert "decompose" not in v02_step_types, "SCHEMAS['0.2'] must not be mutated"
        assert "parallel_dispatch" not in v02_step_types, "SCHEMAS['0.2'] must not be mutated"

    def test_schemas_v03_has_new_types(self):
        """SCHEMAS['0.3'] step type enum includes decompose and parallel_dispatch."""
        v03_step_types = SCHEMAS["0.3"].get("step", {}).get("type", {}).get("enum", [])
        assert "decompose" in v03_step_types
        assert "parallel_dispatch" in v03_step_types

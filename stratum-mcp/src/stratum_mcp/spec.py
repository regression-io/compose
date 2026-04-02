"""
spec.py — IR v0.3 Schema Validator

Implements parse_and_validate() for IR versions 0.2 and 0.3.

v0.3 adds two new step types as a backward-compatible superset of v0.2:
  - decompose       : agent step that emits a TaskGraph
  - parallel_dispatch: consumes a TaskGraph and runs tasks concurrently

Exports
-------
parse_and_validate(yaml_str) -> dict
expand_intent_template(template, task, flow_inputs) -> str
no_file_conflicts(tasks) -> bool   (raises EnsureViolation on conflict)
IRSemanticError
EnsureViolation
SCHEMAS
V03_BUILTIN_CONTRACTS
V03_ADDITIONS
V02_SNAPSHOT
"""

from __future__ import annotations

import copy
import json
import logging
import re
from typing import Any

import yaml

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Exceptions
# ---------------------------------------------------------------------------

class IRSemanticError(Exception):
    """Raised when an IR spec violates a semantic rule."""

    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"[{code}] {message}")


class EnsureViolation(Exception):
    """Raised by no_file_conflicts() when parallel task file conflicts are found."""

    def __init__(self, message: str, conflicts: list[dict] | None = None):
        self.conflicts = conflicts or []
        super().__init__(message)


# ---------------------------------------------------------------------------
# Schema definitions
# ---------------------------------------------------------------------------

# v0.2 schema — frozen; must never be mutated by v0.3 additions.
_V02_STEP_TYPE_ENUM = ["function", "inline", "flow"]

_V02_SCHEMA: dict = {
    "version": "0.2",
    "step": {
        "type": {
            "enum": list(_V02_STEP_TYPE_ENUM),  # defensive copy
        },
        "allowed_fields": [
            "id", "type", "agent", "intent", "inputs", "output_contract",
            "ensure", "retries", "depends_on", "skip_if",
            # gate-step fields
            "function", "on_approve", "on_revise", "on_kill",
            # flow-step fields
            "flow",
        ],
    },
}

# Immutable snapshot used for backward-compatibility assertions
V02_SNAPSHOT: dict = copy.deepcopy(_V02_SCHEMA)

# v0.3 additions — defines new types, their JSON Schema fragments, and
# internal enforcement metadata.
V03_ADDITIONS: dict = {
    # Extended step type enum (superset of v0.2)
    "step.type": {
        "enum": list(_V02_STEP_TYPE_ENUM) + ["decompose", "parallel_dispatch"],
    },
    # JSON Schema fragments for new optional step fields (plan Task 2)
    "step.source":          {"type": "string"},
    "step.max_concurrent":  {"type": "integer", "minimum": 1},
    "step.isolation":       {"enum": ["worktree", "branch"]},
    "step.require":         {"oneOf": [
                                {"enum": ["all", "any"]},
                                {"type": "integer", "minimum": 1},
                            ]},
    "step.merge":           {"enum": ["sequential_apply", "manual"]},
    "step.intent_template": {"type": "string"},
    # Internal: fields exclusive to parallel_dispatch (for D3 / X1 enforcement)
    "parallel_dispatch.exclusive_fields": [
        "source",
        "max_concurrent",
        "isolation",
        "require",
        "merge",
        "intent_template",
    ],
    # Internal: default values for optional parallel_dispatch fields (P7–P10)
    "parallel_dispatch.defaults": {
        "max_concurrent": 3,
        "isolation": "worktree",
        "require": "all",
        "merge": "sequential_apply",
    },
}

CERT_DEFAULT_SECTIONS: list[dict] = [
    {
        "id": "premises",
        "label": "Premises",
        "description": "State every verifiable fact you are using. Each premise must cite a file:line.",
    },
    {
        "id": "trace",
        "label": "Trace",
        "description": "Walk through the logic step by step. Reference premises by [P<n>] ID.",
    },
    {
        "id": "conclusion",
        "label": "Conclusion",
        "description": "State your finding. Every claim must reference at least one premise.",
    },
]


def _apply_cert_defaults(step: dict) -> None:
    """Apply default sections to reasoning_template if sections not specified."""
    template = step.get("reasoning_template")
    if template is None:
        return
    if "sections" not in template:
        template["sections"] = copy.deepcopy(CERT_DEFAULT_SECTIONS)
    if "require_citations" not in template:
        template["require_citations"] = False
    # Reject empty sections
    if not template.get("sections"):
        raise IRSemanticError(
            "IR_V03_CERT_EMPTY_SECTIONS",
            "reasoning_template must have at least one section"
        )
    # Validate section structure
    for i, section in enumerate(template.get("sections", [])):
        if not isinstance(section, dict):
            raise IRSemanticError(
                "IR_V03_CERT_INVALID_SECTION",
                f"reasoning_template section {i} must be a mapping, got {type(section).__name__}"
            )
        for field in ("id", "label", "description"):
            if field not in section:
                raise IRSemanticError(
                    "IR_V03_CERT_INVALID_SECTION",
                    f"reasoning_template section {i} is missing required field '{field}'"
                )


# Built-in v0.3 contracts — user specs cannot redefine these names
V03_BUILTIN_CONTRACTS: dict = {
    "TaskGraph": {
        "tasks": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["id", "description"],
                "properties": {
                    "id":          {"type": "string"},
                    "description": {"type": "string"},
                    "depends_on":  {"type": "array", "items": {"type": "string"}, "default": []},
                    "files_owned": {"type": "array", "items": {"type": "string"}, "default": []},
                    "files_read":  {"type": "array", "items": {"type": "string"}, "default": []},
                },
            },
        },
    },
}

# Reserved built-in function names in v0.3
_V03_BUILTIN_FUNCTION_NAMES = {"no_file_conflicts"}

# v0.3 schema — extends v0.2 with new step types
_V03_SCHEMA: dict = {
    "version": "0.3",
    "step": {
        "type": {
            "enum": list(V03_ADDITIONS["step.type"]["enum"]),
        },
        "allowed_fields": list(_V02_SCHEMA["step"]["allowed_fields"]) + [
            "source",
            "max_concurrent",
            "isolation",
            "require",
            "merge",
            "intent_template",
            "reasoning_template",
        ],
    },
}

SCHEMAS: dict = {
    "0.2": _V02_SCHEMA,
    "0.3": _V03_SCHEMA,
}


# ---------------------------------------------------------------------------
# parse_and_validate
# ---------------------------------------------------------------------------

def parse_and_validate(yaml_str: str) -> dict:
    """
    Parse a YAML spec string and validate it according to its version.

    Returns the validated spec dict (with defaults applied for v0.3 specs).
    Raises IRSemanticError on any validation failure.
    """
    spec = yaml.safe_load(yaml_str)
    version = str(spec.get("version", "0.2"))

    if version not in SCHEMAS:
        raise IRSemanticError(
            "IR_UNKNOWN_VERSION",
            f"Unknown spec version '{version}'. Known versions: {list(SCHEMAS.keys())}"
        )

    if version == "0.2":
        _validate_v02(spec)
    elif version == "0.3":
        _validate_v03(spec)

    return spec


# ---------------------------------------------------------------------------
# v0.2 validation
# ---------------------------------------------------------------------------

def _validate_v02(spec: dict) -> None:
    """Validate a v0.2 spec. Minimal — just ensure structure is parseable."""
    # v0.2 accepts all existing step structures without further semantic checks.
    # This is intentionally lenient to ensure backward compatibility.
    pass


# ---------------------------------------------------------------------------
# v0.3 validation
# ---------------------------------------------------------------------------

def _validate_v03(spec: dict) -> None:
    """Validate a v0.3 spec, applying all semantic rules."""
    _check_reserved_contract_names(spec)
    _check_reserved_builtin_names(spec)
    _check_nested_parallel(spec)

    for flow_name, flow_def in spec.get("flows", {}).items():
        steps = flow_def.get("steps", [])
        _validate_v03_flow_steps(steps, flow_name, spec)


def _check_reserved_contract_names(spec: dict) -> None:
    """X3: User-defined contracts must not be named 'TaskGraph'."""
    user_contracts = spec.get("contracts", {})
    for name in user_contracts:
        if name in V03_BUILTIN_CONTRACTS:
            raise IRSemanticError(
                "IR_V03_TASKGRAPH_RESERVED",
                f"Contract name '{name}' is reserved as a v0.3 built-in. "
                f"Remove it from the 'contracts' section."
            )


def _check_reserved_builtin_names(spec: dict) -> None:
    """X4: User-defined identifiers must not shadow v0.3 built-ins."""
    user_functions = spec.get("functions", {})
    user_contracts = spec.get("contracts", {})

    for name in user_functions:
        if name in _V03_BUILTIN_FUNCTION_NAMES:
            raise IRSemanticError(
                "IR_V03_BUILTIN_RESERVED",
                f"Function name '{name}' is reserved as a v0.3 built-in. "
                f"Choose a different name."
            )

    for name in user_contracts:
        if name in _V03_BUILTIN_FUNCTION_NAMES:
            raise IRSemanticError(
                "IR_V03_BUILTIN_RESERVED",
                f"Contract name '{name}' is reserved as a v0.3 built-in. "
                f"Choose a different name."
            )


def _check_nested_parallel(spec: dict) -> None:
    """P6: A parallel_dispatch step must not dispatch into a flow that contains
    another parallel_dispatch step (nested parallel is forbidden)."""
    flows = spec.get("flows", {})

    # Build a set of flow names that contain a parallel_dispatch step
    flows_with_parallel: set[str] = set()
    for flow_name, flow_def in flows.items():
        for step in flow_def.get("steps", []):
            if _step_type(step) == "parallel_dispatch":
                flows_with_parallel.add(flow_name)
                break

    # Now check: if a parallel_dispatch step references a sub-flow that itself
    # has a parallel_dispatch, that is a nested parallel.
    for flow_name, flow_def in flows.items():
        for step in flow_def.get("steps", []):
            if _step_type(step) == "parallel_dispatch":
                sub_flow = step.get("flow")
                if sub_flow and sub_flow in flows_with_parallel:
                    raise IRSemanticError(
                        "IR_V03_NESTED_PARALLEL",
                        f"Step '{step.get('id')}' in flow '{flow_name}' dispatches "
                        f"into flow '{sub_flow}' which itself contains a "
                        f"parallel_dispatch step. Nested parallel dispatch is forbidden."
                    )


def _validate_v03_flow_steps(steps: list, flow_name: str, spec: dict) -> None:
    """Validate all steps in a flow according to v0.3 rules."""
    # Build a map of step_id → step for source validation
    step_map: dict[str, dict] = {}
    step_order: list[str] = []

    # X2: collect step IDs that belong to OTHER flows so we can distinguish
    # a cross-flow reference (X2) from a same-flow forward reference (P4).
    other_flow_step_ids: set[str] = set()
    for other_flow_name, other_flow_def in spec.get("flows", {}).items():
        if other_flow_name == flow_name:
            continue
        for other_step in other_flow_def.get("steps", []):
            sid = other_step.get("id", "")
            if sid:
                other_flow_step_ids.add(sid)

    for step in steps:
        sid = step.get("id", "")
        step_type = _step_type(step)

        match step_type:
            case "decompose":
                _validate_decompose_step(step, flow_name, spec)
            case "parallel_dispatch":
                _validate_parallel_dispatch_step(
                    step, flow_name, step_map, step_order, other_flow_step_ids
                )
                _apply_parallel_defaults(step)
            case _:
                # v0.2 step types: check for v0.3-exclusive fields on non-v0.3 steps
                _check_no_exclusive_fields(step, flow_name)

        # CERT-1: reasoning_template only valid on intent-bearing steps
        if "reasoning_template" in step:
            if step_type in ("parallel_dispatch", "function", "flow"):
                raise IRSemanticError(
                    "IR_V03_CERT_ON_WRONG_TYPE",
                    f"Step '{sid}' in flow '{flow_name}' has 'reasoning_template' "
                    f"which is not valid on {step_type} steps. "
                    f"Use it on execute_step or decompose steps only."
                )

        _apply_cert_defaults(step)

        step_map[sid] = step
        step_order.append(sid)


def _step_type(step: dict) -> str:
    """Return the effective type of a step dict."""
    if "type" in step:
        return step["type"]
    if "function" in step:
        return "function"
    if "flow" in step:
        return "flow"
    # Default: regular agent-executed step (v0.2-style)
    return "execute_step"


def _validate_decompose_step(step: dict, flow_name: str, spec: dict) -> None:
    """Apply rules D1, D2, D3 to a decompose step."""
    sid = step.get("id", "<unknown>")

    # D1: output_contract must be TaskGraph
    output_contract = step.get("output_contract")
    if output_contract != "TaskGraph":
        raise IRSemanticError(
            "IR_V03_DECOMPOSE_INCOMPATIBLE_CONTRACT",
            f"Decompose step '{sid}' in flow '{flow_name}' must have "
            f"output_contract: TaskGraph, but got: {output_contract!r}"
        )

    # D2: intent is required
    if not step.get("intent"):
        raise IRSemanticError(
            "IR_V03_DECOMPOSE_NO_INTENT",
            f"Decompose step '{sid}' in flow '{flow_name}' must have an 'intent' field."
        )

    # D3: parallel_dispatch-exclusive fields are forbidden on decompose
    forbidden = V03_ADDITIONS["parallel_dispatch.exclusive_fields"]
    for field in forbidden:
        if field in step:
            raise IRSemanticError(
                "IR_V03_DECOMPOSE_FORBIDDEN_FIELD",
                f"Decompose step '{sid}' in flow '{flow_name}' must not have "
                f"field '{field}' (exclusive to parallel_dispatch)."
            )

    # D4: decompose must not use a gate function
    function_name = step.get("function")
    if function_name:
        function_def = spec.get("functions", {}).get(function_name, {})
        if function_def.get("mode") == "gate":
            raise IRSemanticError(
                "IR_V03_DECOMPOSE_GATE_FORBIDDEN",
                f"Decompose step '{sid}' in flow '{flow_name}' must not use "
                f"gate function '{function_name}'."
            )


def _validate_parallel_dispatch_step(
    step: dict,
    flow_name: str,
    step_map: dict[str, dict],
    step_order: list[str],
    other_flow_step_ids: set[str] | None = None,
) -> None:
    """Apply rules P1–P6 and X2 to a parallel_dispatch step."""
    sid = step.get("id", "<unknown>")

    # P1: source is required
    source = step.get("source")
    if not isinstance(source, str) or not source.startswith("$."):
        raise IRSemanticError(
            "IR_V03_PARALLEL_NO_SOURCE",
            f"Parallel dispatch step '{sid}' in flow '{flow_name}' "
            f"must have a valid JSONPath 'source' field."
        )

    # P2: intent_template is required
    if not step.get("intent_template"):
        raise IRSemanticError(
            "IR_V03_PARALLEL_NO_TEMPLATE",
            f"Parallel dispatch step '{sid}' in flow '{flow_name}' "
            f"must have an 'intent_template' field."
        )

    # P3: intent field must NOT be present
    if "intent" in step:
        raise IRSemanticError(
            "IR_V03_PARALLEL_HAS_INTENT",
            f"Parallel dispatch step '{sid}' in flow '{flow_name}' "
            f"must not have an 'intent' field. Use 'intent_template' instead."
        )

    # P4, P5, X2: source must reference a decompose step in the SAME flow
    # that appears BEFORE this step.
    referenced_id = _extract_source_step_id(source)
    if referenced_id is None:
        raise IRSemanticError(
            "IR_V03_PARALLEL_NO_SOURCE",
            f"Parallel dispatch step '{sid}' in flow '{flow_name}' "
            f"must reference a prior decompose step via '$.steps.<id>.output'."
        )

    if referenced_id not in step_order:
        # X2: check if the referenced step lives in a different flow
        if other_flow_step_ids and referenced_id in other_flow_step_ids:
            raise IRSemanticError(
                "IR_V03_PARALLEL_CROSS_FLOW_SOURCE",
                f"Parallel dispatch step '{sid}' in flow '{flow_name}' "
                f"references source step '{referenced_id}' which does not "
                f"belong to the same flow."
            )

        # P4: step doesn't appear before this one in the current flow
        raise IRSemanticError(
            "IR_V03_PARALLEL_SOURCE_NOT_PRIOR",
            f"Parallel dispatch step '{sid}' in flow '{flow_name}' "
            f"references source step '{referenced_id}' which does not "
            f"appear before it in the flow."
        )

    referenced_step = step_map.get(referenced_id)
    if referenced_step is not None:
        ref_type = _step_type(referenced_step)
        if ref_type != "decompose":
            raise IRSemanticError(
                "IR_V03_PARALLEL_SOURCE_NOT_DECOMPOSE",
                f"Parallel dispatch step '{sid}' in flow '{flow_name}' "
                f"references source step '{referenced_id}' which has type "
                f"'{ref_type}', not 'decompose'."
            )
    else:
        # Referenced step exists in order but not in map — treat as not-prior
        raise IRSemanticError(
            "IR_V03_PARALLEL_SOURCE_NOT_PRIOR",
            f"Parallel dispatch step '{sid}' in flow '{flow_name}' "
            f"references source step '{referenced_id}' which does not "
            f"appear before it in the flow."
        )


def _extract_source_step_id(source: str) -> str | None:
    """
    Extract the step ID from a JSONPath source reference.

    Supported patterns:
      $.steps.<step_id>.output   → returns <step_id>
      $.steps.<step_id>.*        → returns <step_id>

    Returns None if the pattern is not recognised.
    """
    # Match $.steps.<step_id>.output or similar
    m = re.match(r'^\$\.steps\.([A-Za-z0-9_-]+)', source)
    if m:
        return m.group(1)
    return None


def _check_no_exclusive_fields(step: dict, flow_name: str) -> None:
    """X1: v0.3-exclusive fields must not appear on non-parallel_dispatch steps."""
    sid = step.get("id", "<unknown>")
    exclusive = V03_ADDITIONS["parallel_dispatch.exclusive_fields"]
    for field in exclusive:
        if field in step:
            raise IRSemanticError(
                "IR_V03_FIELD_ON_WRONG_TYPE",
                f"Step '{sid}' in flow '{flow_name}' has field '{field}' "
                f"which is only valid on parallel_dispatch steps."
            )


def _apply_parallel_defaults(step: dict) -> None:
    """P7–P10: Apply default values to optional parallel_dispatch fields."""
    defaults = V03_ADDITIONS["parallel_dispatch.defaults"]
    for key, default_val in defaults.items():
        if key not in step:
            step[key] = default_val


# ---------------------------------------------------------------------------
# expand_intent_template
# ---------------------------------------------------------------------------

def expand_intent_template(
    template: str,
    task: dict,
    flow_inputs: dict,
) -> str:
    """
    Expand a parallel_dispatch intent template with task and flow input values.

    Supported tokens:
      {task.id}           → task['id']
      {task.description}  → task['description']
      {task.files_owned}  → comma-separated list (or '' for empty)
      {task.files_read}   → comma-separated list (or '' for empty)
      {task.depends_on}   → comma-separated list
      {task.index}        → task['_index'] (zero-based)
      {input.<field>}     → flow_inputs[<field>]

    Unknown tokens are left unchanged.
    """
    result = template

    # Build replacement map
    replacements: dict[str, str] = {}

    # task.* tokens
    replacements["{task.id}"] = str(task.get("id", ""))
    replacements["{task.description}"] = str(task.get("description", ""))
    replacements["{task.files_owned}"] = _list_to_str(task.get("files_owned", []))
    replacements["{task.files_read}"] = _list_to_str(task.get("files_read", []))
    replacements["{task.depends_on}"] = _list_to_str(task.get("depends_on", []))
    # task.index — always substitute; _index is injected by executor (default: 0)
    replacements["{task.index}"] = str(task.get("_index", 0))

    # input.* tokens
    for key, val in flow_inputs.items():
        replacements[f"{{input.{key}}}"] = str(val)

    # Apply replacements (longer keys first to avoid partial matches)
    for token, value in sorted(replacements.items(), key=lambda x: -len(x[0])):
        result = result.replace(token, value)

    # Warn on any tokens that were not recognised (left as-is in the output)
    unrecognized = re.findall(r'\{[^}]+\}', result)
    if unrecognized:
        logger.warning(
            "intent_template: unrecognized tokens left as-is: %s", unrecognized
        )

    return result


def _list_to_str(lst: Any) -> str:
    """Convert a list to a comma-separated string, or '' for empty/None."""
    if not lst:
        return ""
    if isinstance(lst, list):
        return ", ".join(str(x) for x in lst)
    return str(lst)


# ---------------------------------------------------------------------------
# no_file_conflicts
# ---------------------------------------------------------------------------

def no_file_conflicts(tasks: list[dict]) -> bool:
    """
    Validate that no two independent tasks own overlapping files.

    Two tasks are "independent" if neither has the other in its depends_on
    (directly or transitively — for now we only check direct depends_on).

    Returns True if no conflicts are found.
    Raises EnsureViolation if conflicting file ownership is detected.
    """
    if not tasks:
        return True

    def _norm(path: str) -> str:
        """Normalize a file path by stripping a leading './' prefix."""
        return path[2:] if path.startswith('./') else path

    # Build dependency set: task_id → set of task_ids it depends on
    deps: dict[str, set[str]] = {}
    for t in tasks:
        tid = t.get("id", "")
        deps[tid] = set(t.get("depends_on") or [])

    def are_ordered(a: str, b: str) -> bool:
        """Return True if a depends_on b or b depends_on a (direct)."""
        return b in deps.get(a, set()) or a in deps.get(b, set())

    # Check all pairs for file_owned overlap
    conflicts: list[dict] = []
    task_ids = [t.get("id", "") for t in tasks]
    files_owned_map: dict[str, set[str]] = {}
    for t in tasks:
        tid = t.get("id", "")
        files_owned_map[tid] = {_norm(f) for f in (t.get("files_owned") or [])}

    for i, tid_a in enumerate(task_ids):
        for j, tid_b in enumerate(task_ids):
            if j <= i:
                continue
            # If ordered (one depends on the other), no conflict
            if are_ordered(tid_a, tid_b):
                continue
            # Check overlap
            overlap = files_owned_map[tid_a] & files_owned_map[tid_b]
            if overlap:
                conflicts.append({
                    "task_a": tid_a,
                    "task_b": tid_b,
                    "files": sorted(overlap),
                })

    if conflicts:
        # Build a readable message
        conflict_lines = []
        for c in conflicts:
            files_str = ", ".join(c["files"])
            conflict_lines.append(
                f"Tasks '{c['task_a']}' and '{c['task_b']}' both own: {files_str}"
            )
        msg = "File ownership conflicts detected:\n" + "\n".join(conflict_lines)
        raise EnsureViolation(msg, conflicts=conflicts)

    return True

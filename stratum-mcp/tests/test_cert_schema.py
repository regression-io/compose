import pytest
from stratum_mcp.spec import parse_and_validate, IRSemanticError

SPEC_WITH_CERT = """
version: "0.3"
contracts:
  ReviewResult:
    clean: {type: boolean}
flows:
  review:
    steps:
      - id: analyze
        type: decompose
        output_contract: TaskGraph
        intent: "Analyze the code"
        ensure: ["result.tasks is not None"]
        reasoning_template:
          require_citations: true
          sections:
            - id: premises
              label: "Premises"
              description: "List facts from the code."
            - id: trace
              label: "Trace"
              description: "Walk through logic."
            - id: conclusion
              label: "Conclusion"
              description: "State finding with references."
"""


class TestReasoningTemplateSchema:
    def test_valid_spec_with_reasoning_template_accepted(self):
        """reasoning_template on a decompose step should pass validation."""
        result = parse_and_validate(SPEC_WITH_CERT)
        step = result["flows"]["review"]["steps"][0]
        assert step["reasoning_template"]["require_citations"] is True
        assert len(step["reasoning_template"]["sections"]) == 3

    def test_reasoning_template_on_execute_step_accepted(self):
        spec = """
version: "0.3"
contracts:
  Result:
    summary: {type: string}
flows:
  main:
    steps:
      - id: review
        intent: "Review the diff"
        output_contract: Result
        reasoning_template:
          require_citations: true
"""
        result = parse_and_validate(spec)
        step = result["flows"]["main"]["steps"][0]
        assert "reasoning_template" in step

    def test_reasoning_template_on_parallel_dispatch_rejected(self):
        """reasoning_template is not valid on parallel_dispatch steps."""
        spec = """
version: "0.3"
contracts: {}
flows:
  main:
    steps:
      - id: plan
        type: decompose
        output_contract: TaskGraph
        intent: "Plan tasks"
        ensure: ["result.tasks is not None"]
      - id: run
        type: parallel_dispatch
        source: "$.steps.plan.output.tasks"
        intent_template: "Do {task.description}"
        reasoning_template:
          require_citations: true
"""
        with pytest.raises(IRSemanticError, match="reasoning_template"):
            parse_and_validate(spec)

    def test_reasoning_template_on_gate_step_rejected(self):
        """reasoning_template is not valid on gate/function steps."""
        spec = """
version: "0.3"
functions:
  approve:
    mode: gate
    intent: "Approve?"
flows:
  main:
    steps:
      - id: gate
        function: approve
        reasoning_template:
          require_citations: true
"""
        with pytest.raises(IRSemanticError, match="reasoning_template"):
            parse_and_validate(spec)

    def test_minimal_template_gets_default_sections(self):
        """reasoning_template with no sections should get 3 defaults."""
        spec = """
version: "0.3"
contracts:
  Result:
    summary: {type: string}
flows:
  main:
    steps:
      - id: review
        intent: "Review the diff"
        output_contract: Result
        reasoning_template:
          require_citations: true
"""
        result = parse_and_validate(spec)
        step = result["flows"]["main"]["steps"][0]
        sections = step["reasoning_template"]["sections"]
        assert len(sections) == 3
        assert sections[0]["id"] == "premises"
        assert sections[1]["id"] == "trace"
        assert sections[2]["id"] == "conclusion"
        for s in sections:
            assert "label" in s
            assert "description" in s

    def test_custom_sections_preserved(self):
        """Custom sections should not be overwritten by defaults."""
        spec = """
version: "0.3"
contracts:
  Result:
    summary: {type: string}
flows:
  main:
    steps:
      - id: review
        intent: "Review"
        output_contract: Result
        reasoning_template:
          require_citations: false
          sections:
            - id: evidence
              label: "Evidence"
              description: "Gather evidence."
            - id: verdict
              label: "Verdict"
              description: "State verdict."
"""
        result = parse_and_validate(spec)
        step = result["flows"]["main"]["steps"][0]
        sections = step["reasoning_template"]["sections"]
        assert len(sections) == 2
        assert sections[0]["id"] == "evidence"
        assert sections[1]["id"] == "verdict"

    def test_malformed_section_missing_label_rejected(self):
        """Section missing label/description should fail validation."""
        spec = """
version: "0.3"
contracts:
  Result:
    summary: {type: string}
flows:
  main:
    steps:
      - id: review
        intent: "Review"
        output_contract: Result
        reasoning_template:
          require_citations: true
          sections:
            - id: premises
"""
        with pytest.raises(IRSemanticError, match="missing required field"):
            parse_and_validate(spec)

    def test_empty_sections_list_rejected(self):
        """Explicitly passing sections: [] should be rejected."""
        spec = """
version: "0.3"
contracts:
  Result:
    summary: {type: string}
flows:
  main:
    steps:
      - id: review
        intent: "Review"
        output_contract: Result
        reasoning_template:
          require_citations: false
          sections: []
"""
        with pytest.raises(IRSemanticError, match="at least one section"):
            parse_and_validate(spec)

    def test_reasoning_template_on_flow_step_rejected(self):
        """reasoning_template is not valid on flow steps."""
        spec = """
version: "0.3"
contracts: {}
flows:
  sub:
    steps:
      - id: work
        intent: "Do work"
  main:
    steps:
      - id: delegate
        type: flow
        flow: sub
        reasoning_template:
          require_citations: false
"""
        with pytest.raises(IRSemanticError, match="reasoning_template"):
            parse_and_validate(spec)

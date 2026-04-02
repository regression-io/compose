import pytest
from stratum_mcp.executor import (
    compute_next_dispatch,
    FlowDefinition, FlowState, StepDefinition,
    inject_cert_instructions,
    validate_certificate,
    _make_ensure_failed_response,
)


def make_step(id, **kw):
    return StepDefinition(id=id, **kw)

def make_flow(steps, flow_id="f1", name="test"):
    return FlowDefinition(flow_id=flow_id, name=name, steps=steps)

def make_state(flow_id="f1", **kw):
    return FlowState(flow_id=flow_id, flow_name="test", **kw)


SAMPLE_TEMPLATE = {
    "require_citations": True,
    "sections": [
        {"id": "premises", "label": "Premises", "description": "List facts."},
        {"id": "trace", "label": "Trace", "description": "Walk through."},
        {"id": "conclusion", "label": "Conclusion", "description": "State finding."},
    ],
}


class TestInjectCertInstructions:
    def test_inject_appends_section_headings(self):
        result = inject_cert_instructions("Review the code.", SAMPLE_TEMPLATE)
        assert "Review the code." in result
        assert "## Premises" in result
        assert "## Trace" in result
        assert "## Conclusion" in result
        assert "[P1]" in result

    def test_inject_includes_section_descriptions(self):
        result = inject_cert_instructions("Do analysis.", SAMPLE_TEMPLATE)
        assert "List facts." in result
        assert "Walk through." in result
        assert "State finding." in result

    def test_inject_skips_citation_example_when_not_required(self):
        template = {
            "require_citations": False,
            "sections": [
                {"id": "premises", "label": "Premises", "description": "List facts."},
                {"id": "conclusion", "label": "Conclusion", "description": "Done."},
            ],
        }
        result = inject_cert_instructions("Do it.", template)
        assert "## Premises" in result
        assert "## Conclusion" in result
        assert "[P" not in result


class TestDispatchWithCert:
    def test_claude_agent_gets_injected_intent(self):
        step = make_step("s1", intent="Review code", agent="claude",
                         reasoning_template=SAMPLE_TEMPLATE)
        flow = make_flow([step])
        state = make_state()
        resp = compute_next_dispatch(flow, state)
        assert resp["status"] == "execute_step"
        assert "## Premises" in resp["intent"]
        assert "Review code" in resp["intent"]

    def test_codex_agent_gets_raw_intent(self):
        step = make_step("s1", intent="Review code", agent="codex",
                         reasoning_template=SAMPLE_TEMPLATE)
        flow = make_flow([step])
        state = make_state()
        resp = compute_next_dispatch(flow, state)
        assert resp["status"] == "execute_step"
        assert resp["intent"] == "Review code"
        assert "## Premises" not in resp["intent"]

    def test_no_template_no_injection(self):
        step = make_step("s1", intent="Review code")
        flow = make_flow([step])
        state = make_state()
        resp = compute_next_dispatch(flow, state)
        assert resp["intent"] == "Review code"


GOOD_ARTIFACT = """## Premises
[P1] The function `parse()` at `src/parser.py:42` returns a dict.
[P2] The caller at `src/main.py:10` expects a list.

## Trace
Starting from [P1], the return type is dict. At [P2], the caller
iterates over the result, which fails because dict iteration yields keys.

## Conclusion
[P1] and [P2] show a type mismatch. The function returns dict but the
caller expects list. This will produce incorrect output, not a crash.
"""

BAD_MISSING_TRACE = """## Premises
[P1] Something exists.

## Conclusion
It's fine. [P1]
"""

BAD_NO_CITATIONS = """## Premises
[P1] The function exists.

## Trace
The function does stuff.

## Conclusion
Everything looks good.
"""


class TestValidateCertificate:
    def test_valid_certificate_passes(self):
        violations = validate_certificate(SAMPLE_TEMPLATE, {"artifact": GOOD_ARTIFACT})
        assert violations == []

    def test_missing_section_detected(self):
        violations = validate_certificate(SAMPLE_TEMPLATE, {"artifact": BAD_MISSING_TRACE})
        assert len(violations) == 1
        assert "Trace" in violations[0]

    def test_missing_citations_detected(self):
        violations = validate_certificate(SAMPLE_TEMPLATE, {"artifact": BAD_NO_CITATIONS})
        assert len(violations) == 1
        assert "citation" in violations[0].lower()

    def test_citations_not_required_when_disabled(self):
        template = {
            "require_citations": False,
            "sections": [
                {"id": "premises", "label": "Premises", "description": "Facts."},
                {"id": "conclusion", "label": "Conclusion", "description": "Done."},
            ],
        }
        artifact = "## Premises\nSome facts.\n\n## Conclusion\nAll good."
        violations = validate_certificate(template, {"artifact": artifact})
        assert violations == []

    def test_empty_artifact_fails_all_sections(self):
        violations = validate_certificate(SAMPLE_TEMPLATE, {"artifact": ""})
        assert len(violations) == 3

    def test_no_artifact_key_fails(self):
        violations = validate_certificate(SAMPLE_TEMPLATE, {})
        assert len(violations) == 3

    def test_cert_failure_returns_ensure_failed(self):
        """Cert violations should be usable by _make_ensure_failed_response."""
        template = SAMPLE_TEMPLATE
        result = {"artifact": "No structure here, just prose."}
        violations = validate_certificate(template, result)
        assert len(violations) > 0
        step = make_step("s1", reasoning_template=template)
        flow = make_flow([step])
        response = _make_ensure_failed_response(flow, step, violations)
        assert response["status"] == "ensure_failed"
        assert any("certificate" in v for v in response["violations"])

    def test_empty_sections_no_crash(self):
        """validate_certificate with empty sections and require_citations should not crash."""
        template = {"require_citations": True, "sections": []}
        result = {"artifact": "some text"}
        violations = validate_certificate(template, result)
        # No IndexError — should return empty violations (no sections to check)
        assert violations == []

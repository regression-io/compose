import pytest
from stratum_mcp.executor import (
    compute_next_dispatch,
    FlowDefinition, FlowState, StepDefinition,
    inject_cert_instructions,
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

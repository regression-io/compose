from stratum_mcp.cert_templates import (
    DIFF_QUALITY_TEMPLATE,
    CONTRACT_COMPLIANCE_TEMPLATE,
    SECURITY_TEMPLATE,
    FRAMEWORK_TEMPLATE,
    SECURITY_REVIEW_TEMPLATE,
    LOGIC_REVIEW_TEMPLATE,
    PERFORMANCE_REVIEW_TEMPLATE,
)


class TestLensTemplates:
    LENS_TEMPLATES = [
        DIFF_QUALITY_TEMPLATE,
        CONTRACT_COMPLIANCE_TEMPLATE,
        SECURITY_TEMPLATE,
        FRAMEWORK_TEMPLATE,
    ]

    REVIEW_TEMPLATES = [
        SECURITY_REVIEW_TEMPLATE,
        LOGIC_REVIEW_TEMPLATE,
        PERFORMANCE_REVIEW_TEMPLATE,
    ]

    def test_all_templates_have_sections(self):
        for t in self.LENS_TEMPLATES + self.REVIEW_TEMPLATES:
            assert "sections" in t
            assert len(t["sections"]) >= 2

    def test_all_templates_have_require_citations(self):
        for t in self.LENS_TEMPLATES + self.REVIEW_TEMPLATES:
            assert t["require_citations"] is True

    def test_all_sections_have_required_fields(self):
        for t in self.LENS_TEMPLATES + self.REVIEW_TEMPLATES:
            for s in t["sections"]:
                assert "id" in s
                assert "label" in s
                assert "description" in s
                assert len(s["description"]) > 10

    def test_lens_templates_end_with_findings(self):
        for t in self.LENS_TEMPLATES:
            last = t["sections"][-1]
            assert last["id"] in ("conclusion", "findings")

    def test_review_templates_end_with_verdict(self):
        for t in self.REVIEW_TEMPLATES:
            last = t["sections"][-1]
            assert last["id"] in ("conclusion", "verdict")

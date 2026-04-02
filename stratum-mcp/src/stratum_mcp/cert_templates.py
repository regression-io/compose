"""
cert_templates.py — Domain-specific reasoning templates for STRAT-CERT.

STRAT-REV lens templates (4) and stratum-review skill pass templates (3).
Each template forces the agent into Premises -> Trace -> Conclusion structure
with domain-appropriate section descriptions.

See: docs/features/STRAT-CERT/design.md
"""

# ---------------------------------------------------------------------------
# STRAT-REV Lens Templates
# ---------------------------------------------------------------------------

DIFF_QUALITY_TEMPLATE: dict = {
    "require_citations": True,
    "sections": [
        {
            "id": "premises",
            "label": "Premises",
            "description": "List each changed function/block from the diff. Cite file:line for each.",
        },
        {
            "id": "trace",
            "label": "Quality Trace",
            "description": (
                "For each premise, evaluate: naming clarity, duplication, "
                "error handling, dead code. Reference premises by ID."
            ),
        },
        {
            "id": "findings",
            "label": "Findings",
            "description": "List LensFinding items. Each must reference the premise it came from.",
        },
    ],
}

CONTRACT_COMPLIANCE_TEMPLATE: dict = {
    "require_citations": True,
    "sections": [
        {
            "id": "premises",
            "label": "Premises",
            "description": (
                "List each blueprint requirement and the file:line that implements it. "
                "List any blueprint item with NO matching implementation."
            ),
        },
        {
            "id": "trace",
            "label": "Compliance Trace",
            "description": (
                "For each premise pair (requirement <-> implementation), verify: "
                "correct path, correct signature, correct behavior. "
                "For unmatched items, confirm they are truly missing."
            ),
        },
        {
            "id": "findings",
            "label": "Findings",
            "description": (
                "List compliance gaps as LensFinding items. Each must cite the "
                "blueprint requirement [P<n>] and the implementation (or lack thereof)."
            ),
        },
    ],
}

SECURITY_TEMPLATE: dict = {
    "require_citations": True,
    "sections": [
        {
            "id": "premises",
            "label": "Premises",
            "description": (
                "List each security-sensitive operation in the diff: auth checks, "
                "SQL queries, user input handling, crypto, secrets. Cite file:line."
            ),
        },
        {
            "id": "trace",
            "label": "Threat Trace",
            "description": (
                "For each premise, trace the data flow from source to sink. "
                "Identify: is input validated? Is output escaped? "
                "Are secrets hardcoded? Reference premises by ID."
            ),
        },
        {
            "id": "findings",
            "label": "Findings",
            "description": (
                "List vulnerabilities as LensFinding items with OWASP category. "
                "Each must trace back to a specific premise and data flow."
            ),
        },
    ],
}

FRAMEWORK_TEMPLATE: dict = {
    "require_citations": True,
    "sections": [
        {
            "id": "premises",
            "label": "Premises",
            "description": (
                "List each framework API call or pattern used in the diff. "
                "Cite file:line. Note the framework version from package.json/requirements.txt."
            ),
        },
        {
            "id": "trace",
            "label": "Pattern Trace",
            "description": (
                "For each premise, check: is this API deprecated? "
                "Is there a preferred alternative? "
                "Does usage match framework conventions for this version?"
            ),
        },
        {
            "id": "findings",
            "label": "Findings",
            "description": (
                "List anti-patterns and deprecations as LensFinding items. "
                "Each must reference the specific API call [P<n>] "
                "and the framework docs justification."
            ),
        },
    ],
}


# ---------------------------------------------------------------------------
# stratum-review Skill Pass Templates
# ---------------------------------------------------------------------------

SECURITY_REVIEW_TEMPLATE: dict = {
    "require_citations": True,
    "sections": [
        {
            "id": "premises",
            "label": "Premises",
            "description": (
                "List every entry point, user input, external data source, "
                "auth check, and secret in the changed files. Cite file:line."
            ),
        },
        {
            "id": "trace",
            "label": "Attack Trace",
            "description": (
                "For each entry point [P<n>], trace untrusted data through the "
                "call chain to its sink. Note each sanitization/validation step "
                "or lack thereof."
            ),
        },
        {
            "id": "verdict",
            "label": "Verdict",
            "description": (
                "List vulnerabilities found with severity. Each must cite "
                "the entry point premise and the specific trace gap."
            ),
        },
    ],
}

LOGIC_REVIEW_TEMPLATE: dict = {
    "require_citations": True,
    "sections": [
        {
            "id": "premises",
            "label": "Premises",
            "description": (
                "List each function's stated contract (params, return, side effects) "
                "and each branch/edge case in the changed code. Cite file:line."
            ),
        },
        {
            "id": "trace",
            "label": "Correctness Trace",
            "description": (
                "For each function [P<n>], walk through: null/empty inputs, "
                "boundary values, error paths, concurrent access. "
                "Does the implementation match the contract?"
            ),
        },
        {
            "id": "verdict",
            "label": "Verdict",
            "description": (
                "List logic bugs and contract violations. Each must reference "
                "the specific premise and the input that breaks it."
            ),
        },
    ],
}

PERFORMANCE_REVIEW_TEMPLATE: dict = {
    "require_citations": True,
    "sections": [
        {
            "id": "premises",
            "label": "Premises",
            "description": (
                "List each loop, query, allocation, I/O call, and data structure "
                "choice in the changed code. Cite file:line. "
                "Note expected data scale if available."
            ),
        },
        {
            "id": "trace",
            "label": "Scaling Trace",
            "description": (
                "For each premise, analyze: time complexity, memory growth, "
                "N+1 patterns, unnecessary copies, missing indices. "
                "State the scaling factor."
            ),
        },
        {
            "id": "verdict",
            "label": "Verdict",
            "description": (
                "List performance risks with estimated impact at scale. "
                "Each must cite the specific operation [P<n>] and its complexity."
            ),
        },
    ],
}

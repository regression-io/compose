import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { injectCertInstructions, DEFAULT_CERT_SECTIONS } from '../lib/cert-inject.js';

describe('DEFAULT_CERT_SECTIONS', () => {
  it('has exactly 3 sections', () => {
    assert.equal(DEFAULT_CERT_SECTIONS.length, 3);
  });

  it('sections are premises, trace, conclusion', () => {
    assert.equal(DEFAULT_CERT_SECTIONS[0].id, 'premises');
    assert.equal(DEFAULT_CERT_SECTIONS[1].id, 'trace');
    assert.equal(DEFAULT_CERT_SECTIONS[2].id, 'conclusion');
  });

  it('each section has id, label, description', () => {
    for (const s of DEFAULT_CERT_SECTIONS) {
      assert.ok(s.id);
      assert.ok(s.label);
      assert.ok(s.description);
    }
  });
});

describe('injectCertInstructions', () => {
  const template = {
    require_citations: true,
    sections: [
      { id: 'premises', label: 'Premises', description: 'List facts.' },
      { id: 'trace', label: 'Quality Trace', description: 'Trace logic.' },
      { id: 'findings', label: 'Findings', description: 'List findings.' },
    ],
  };

  it('prepends the original intent', () => {
    const result = injectCertInstructions('Review this diff.', template);
    assert.ok(result.startsWith('Review this diff.'));
  });

  it('includes all section headings', () => {
    const result = injectCertInstructions('intent', template);
    assert.ok(result.includes('## Premises'));
    assert.ok(result.includes('## Quality Trace'));
    assert.ok(result.includes('## Findings'));
  });

  it('includes section descriptions', () => {
    const result = injectCertInstructions('intent', template);
    assert.ok(result.includes('List facts.'));
    assert.ok(result.includes('Trace logic.'));
    assert.ok(result.includes('List findings.'));
  });

  it('includes citation instructions when require_citations is true', () => {
    const result = injectCertInstructions('intent', template);
    assert.ok(result.includes('[P1]'));
    assert.ok(result.includes('[P<n>]'));
  });

  it('omits citation instructions when require_citations is false', () => {
    const noCite = { ...template, require_citations: false };
    const result = injectCertInstructions('intent', noCite);
    assert.ok(!result.includes('[P1]'));
    assert.ok(!result.includes('[P<n>]'));
  });

  it('includes reasoning JSON field instruction', () => {
    const result = injectCertInstructions('intent', template);
    assert.ok(result.includes('`reasoning`'));
  });

  it('uses default sections when template.sections is absent', () => {
    const minimal = { require_citations: true };
    const result = injectCertInstructions('intent', minimal);
    assert.ok(result.includes('## Premises'));
    assert.ok(result.includes('## Trace'));
    assert.ok(result.includes('## Conclusion'));
  });

  it('uses default sections when template.sections is empty array', () => {
    const empty = { require_citations: true, sections: [] };
    const result = injectCertInstructions('intent', empty);
    assert.ok(result.includes('## Premises'));
    assert.ok(result.includes('## Trace'));
    assert.ok(result.includes('## Conclusion'));
  });
});

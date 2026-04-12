import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { resolveTemplatePath } from '../lib/build.js';

const TMP = join(import.meta.dirname, '.tmp-template-test');

describe('resolveTemplatePath', () => {
  beforeEach(() => {
    mkdirSync(join(TMP, 'pipelines'), { recursive: true });
  });

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true });
  });

  it('resolves from project pipelines/ when file exists there', () => {
    writeFileSync(join(TMP, 'pipelines', 'custom.stratum.yaml'), 'version: "0.3"');
    const result = resolveTemplatePath('custom', TMP);
    assert.equal(result, join(TMP, 'pipelines', 'custom.stratum.yaml'));
  });

  it('falls back to bundled presets/ when not in project pipelines/', () => {
    writeFileSync(join(TMP, '..', '..', 'presets', 'team-review.stratum.yaml'), 'version: "0.3"');
    const result = resolveTemplatePath('team-review', TMP);
    assert.ok(result.includes('presets'), 'should resolve to presets dir');
  });

  it('prefers project pipelines/ over bundled presets/', () => {
    writeFileSync(join(TMP, 'pipelines', 'team-review.stratum.yaml'), 'version: "0.3"');
    const result = resolveTemplatePath('team-review', TMP);
    assert.equal(result, join(TMP, 'pipelines', 'team-review.stratum.yaml'));
  });

  it('defaults template name to build when not provided', () => {
    writeFileSync(join(TMP, 'pipelines', 'build.stratum.yaml'), 'version: "0.3"');
    const result = resolveTemplatePath(undefined, TMP);
    assert.equal(result, join(TMP, 'pipelines', 'build.stratum.yaml'));
  });

  it('returns project path for clear error when template not found anywhere', () => {
    const result = resolveTemplatePath('nonexistent', TMP);
    assert.equal(result, join(TMP, 'pipelines', 'nonexistent.stratum.yaml'));
  });
});

/**
 * pipeline-routes.js — Pipeline authoring REST routes.
 *
 * Routes:
 *   GET  /api/pipeline/templates          — list available pipeline templates
 *   GET  /api/pipeline/templates/:id/spec — full YAML spec for a template
 *   POST /api/pipeline/draft              — create a draft from template or inline spec
 *   GET  /api/pipeline/draft              — get current draft
 *   POST /api/pipeline/draft/approve      — approve and persist current draft
 *   POST /api/pipeline/draft/reject       — reject and discard current draft
 */

import { readdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Read all *.stratum.yaml files from the pipelines dir and return those
 * with a valid metadata block.
 */
function loadTemplates(pipelinesDir) {
  const templates = [];
  let files;
  try {
    files = readdirSync(pipelinesDir).filter(f => f.endsWith('.stratum.yaml'));
  } catch {
    return templates;
  }

  for (const file of files) {
    try {
      const raw = readFileSync(join(pipelinesDir, file), 'utf-8');
      const parsed = YAML.parse(raw);
      if (parsed?.metadata?.id) {
        templates.push({
          id: parsed.metadata.id,
          label: parsed.metadata.label || parsed.metadata.id,
          description: parsed.metadata.description || '',
          category: parsed.metadata.category || 'general',
          steps: typeof parsed.metadata.steps === 'number' ? parsed.metadata.steps : 0,
          estimated_minutes: typeof parsed.metadata.estimated_minutes === 'number' ? parsed.metadata.estimated_minutes : 0,
          _file: file,
        });
      }
    } catch {
      // skip unparseable files
    }
  }
  return templates;
}

/**
 * Extract steps from a parsed spec, version-aware.
 * v0.3: workflow.steps or flows.<name>.steps
 * v0.1: flows.<name>.steps or functions (as step list)
 */
function extractSteps(parsed) {
  // v0.3 with workflow.steps
  if (parsed?.workflow?.steps) {
    return parsed.workflow.steps.map(s => ({ id: s.id, ...s }));
  }

  // flows.<name>.steps (both v0.1 and v0.3)
  if (parsed?.flows) {
    for (const flowName of Object.keys(parsed.flows)) {
      const flow = parsed.flows[flowName];
      if (Array.isArray(flow?.steps) && flow.steps.length > 0) {
        return flow.steps.map(s => ({ id: s.id, ...s }));
      }
    }
  }

  // Fallback: list functions as pseudo-steps (v0.1 function-only specs)
  if (parsed?.functions) {
    return Object.keys(parsed.functions).map(id => ({ id }));
  }

  return [];
}

// ---------------------------------------------------------------------------
// In-memory draft state (single draft at a time)
// ---------------------------------------------------------------------------

let currentDraft = null;

const DRAFT_FILE = 'pipeline-draft.json';

function saveDraft(dataDir, draft) {
  currentDraft = draft;
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, DRAFT_FILE), JSON.stringify(draft, null, 2));
}

function loadDraft(dataDir) {
  if (currentDraft) return currentDraft;
  const p = join(dataDir, DRAFT_FILE);
  if (!existsSync(p)) return null;
  try {
    currentDraft = JSON.parse(readFileSync(p, 'utf-8'));
    return currentDraft;
  } catch {
    return null;
  }
}

function clearDraft(dataDir) {
  currentDraft = null;
  const p = join(dataDir, DRAFT_FILE);
  try { if (existsSync(p)) unlinkSync(p); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Route attachment
// ---------------------------------------------------------------------------

/**
 * Attach pipeline authoring routes to an Express app.
 *
 * @param {object} app — Express app
 * @param {{
 *   broadcastMessage: function,
 *   scheduleBroadcast: function,
 *   getDataDir: function,
 *   getPipelinesDir: function,
 *   stratumClient?: { validate: function } | null,
 * }} deps
 */
export function attachPipelineRoutes(app, { broadcastMessage, scheduleBroadcast, getDataDir, getPipelinesDir, stratumClient }) {

  // GET /api/pipeline/templates
  app.get('/api/pipeline/templates', (_req, res) => {
    const templates = loadTemplates(getPipelinesDir());
    // Strip internal _file field
    const clean = templates.map(({ _file, ...rest }) => rest);
    res.json({ templates: clean });
  });

  // GET /api/pipeline/templates/:id/spec
  app.get('/api/pipeline/templates/:id/spec', (req, res) => {
    const templates = loadTemplates(getPipelinesDir());
    const tmpl = templates.find(t => t.id === req.params.id);
    if (!tmpl) return res.status(404).json({ error: `Template "${req.params.id}" not found` });

    const spec = readFileSync(join(getPipelinesDir(), tmpl._file), 'utf-8');
    res.json({ spec });
  });

  // POST /api/pipeline/draft
  app.post('/api/pipeline/draft', (req, res) => {
    const { templateId, spec: inlineSpec, metadata: inlineMeta } = req.body || {};
    const dataDir = getDataDir();

    let spec;
    let metadata;
    let parsed;

    if (templateId) {
      // Load from template
      const templates = loadTemplates(getPipelinesDir());
      const tmpl = templates.find(t => t.id === templateId);
      if (!tmpl) return res.status(404).json({ error: `Template "${templateId}" not found` });

      spec = readFileSync(join(getPipelinesDir(), tmpl._file), 'utf-8');
      try {
        parsed = YAML.parse(spec);
      } catch (e) {
        return res.status(400).json({ error: `Failed to parse template: ${e.message}` });
      }
      metadata = parsed.metadata || tmpl;
    } else if (inlineSpec) {
      // Inline spec
      spec = inlineSpec;
      try {
        parsed = YAML.parse(spec);
      } catch (e) {
        return res.status(400).json({ error: `Invalid YAML: ${e.message}` });
      }
      metadata = parsed?.metadata || inlineMeta;
      if (!metadata || !metadata.id) {
        return res.status(400).json({ error: 'Spec must include a metadata block with at least an id field, or metadata must be provided separately' });
      }
    } else {
      return res.status(400).json({ error: 'Provide either templateId or spec + metadata' });
    }

    const steps = extractSteps(parsed);
    const draftId = randomUUID();

    const draft = {
      draftId,
      spec,
      metadata,
      steps,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    saveDraft(dataDir, draft);

    broadcastMessage({ type: 'pipelineDraft', ...draft });

    res.json(draft);
  });

  // GET /api/pipeline/draft
  app.get('/api/pipeline/draft', (_req, res) => {
    const draft = loadDraft(getDataDir());
    res.json({ draft: draft ?? null });
  });

  // POST /api/pipeline/draft/approve
  app.post('/api/pipeline/draft/approve', async (req, res) => {
    const { draftId } = req.body || {};
    const dataDir = getDataDir();
    const draft = loadDraft(dataDir);

    if (!draft) return res.status(404).json({ error: 'No draft to approve' });
    if (draft.draftId !== draftId) return res.status(409).json({ error: 'Draft ID mismatch' });

    // Validate spec before approval
    if (stratumClient && typeof stratumClient.validate === 'function') {
      try {
        const result = await stratumClient.validate(draft.spec);
        if (result?.valid === false) {
          return res.status(422).json({ error: `Spec validation failed: ${result.error || 'unknown error'}` });
        }
      } catch (err) {
        // Stratum unavailable at runtime — fall back to YAML parse check
        try {
          YAML.parse(draft.spec);
        } catch (parseErr) {
          return res.status(422).json({ error: `Invalid YAML: ${parseErr.message}` });
        }
      }
    } else {
      // No stratum client — basic YAML parse check
      try {
        YAML.parse(draft.spec);
      } catch (parseErr) {
        return res.status(422).json({ error: `Invalid YAML: ${parseErr.message}` });
      }
    }

    // Write approved spec to approved-specs/
    const approvedDir = join(dataDir, 'approved-specs');
    mkdirSync(approvedDir, { recursive: true });
    const specPath = join(approvedDir, `${draftId}.yaml`);
    writeFileSync(specPath, draft.spec);

    // Only delete draft AFTER spec file written
    clearDraft(dataDir);

    broadcastMessage({
      type: 'pipelineDraftResolved',
      draftId,
      outcome: 'approved',
      specPath,
    });

    res.json({ ok: true, specPath });
  });

  // POST /api/pipeline/draft/reject
  app.post('/api/pipeline/draft/reject', (req, res) => {
    const { draftId } = req.body || {};
    const dataDir = getDataDir();
    const draft = loadDraft(dataDir);

    if (!draft) return res.status(404).json({ error: 'No draft to reject' });
    if (draft.draftId !== draftId) return res.status(409).json({ error: 'Draft ID mismatch' });

    clearDraft(dataDir);

    broadcastMessage({
      type: 'pipelineDraftResolved',
      draftId,
      outcome: 'rejected',
    });

    res.json({ ok: true });
  });
}

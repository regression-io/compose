/**
 * stratum-api.js — Express router for Stratum pipeline monitor + gate UI.
 *
 * Pure transport adapter: calls stratum-client, maps results to HTTP.
 * Zero domain logic — all gate semantics live in stratum.
 *
 * Routes:
 *   GET  /api/stratum/flows
 *   GET  /api/stratum/flows/:flowId
 *   GET  /api/stratum/gates
 *   POST /api/stratum/gates/:flowId/:stepId/approve
 *   POST /api/stratum/gates/:flowId/:stepId/reject
 *   POST /api/stratum/gates/:flowId/:stepId/revise
 */

import { Router } from 'express';
import * as _defaultClient from './stratum-client.js';

/** Wrap an async route handler so rejections call next(err) instead of going unhandled. */
function ar(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * @param {object} [client] — override stratum-client (for tests only)
 */
export function createStratumRouter(client) {
  const stratum = client ?? _defaultClient;
  const router = Router();

  // -- Read routes -----------------------------------------------------------

  router.get('/flows', ar(async (_req, res) => {
    const result = await stratum.queryFlows();
    if (result?.error) return res.status(_errorStatus(result.error.code)).json(result);
    res.json(result);
  }));

  router.get('/flows/:flowId', ar(async (req, res) => {
    const result = await stratum.queryFlow(req.params.flowId);
    if (result?.error) return res.status(_errorStatus(result.error.code)).json(result);
    res.json(result);
  }));

  router.get('/gates', ar(async (_req, res) => {
    const result = await stratum.queryGates();
    if (result?.error) return res.status(_errorStatus(result.error.code)).json(result);
    res.json(result);
  }));

  // -- Gate mutation routes --------------------------------------------------

  router.post('/gates/:flowId/:stepId/approve', ar(async (req, res) => {
    const { flowId, stepId } = req.params;
    const { note, resolvedBy } = req.body || {};
    const result = await stratum.gateApprove(flowId, stepId, note, resolvedBy);
    res.status(_mutationStatus(result)).json(result);
  }));

  router.post('/gates/:flowId/:stepId/reject', ar(async (req, res) => {
    const { flowId, stepId } = req.params;
    const { note, resolvedBy } = req.body || {};
    const result = await stratum.gateReject(flowId, stepId, note, resolvedBy);
    res.status(_mutationStatus(result)).json(result);
  }));

  router.post('/gates/:flowId/:stepId/revise', ar(async (req, res) => {
    const { flowId, stepId } = req.params;
    const { note, resolvedBy } = req.body || {};
    const result = await stratum.gateRevise(flowId, stepId, note, resolvedBy);
    res.status(_mutationStatus(result)).json(result);
  }));

  // -- Error middleware (catches ENOENT, unexpected throws, etc.) -------------
  // eslint-disable-next-line no-unused-vars
  router.use((err, _req, res, _next) => {
    console.error('[stratum-api] unhandled error:', err.message);
    res.status(503).json({ error: { code: 'UNAVAILABLE', message: err.message, detail: '' } });
  });

  return router;
}

// ---------------------------------------------------------------------------
// Status code mapping — error codes → HTTP status
// ---------------------------------------------------------------------------

function _errorStatus(code) {
  switch (code) {
    case 'NOT_FOUND':  return 404;
    case 'TIMEOUT':    return 504;
    case 'INVALID':    return 400;
    default:           return 500;
  }
}

function _mutationStatus(result) {
  if (result?.conflict)     return 409;
  if (result?.error)        return _errorStatus(result.error.code);
  if (result?.ok === true)  return 200;
  return 500;
}

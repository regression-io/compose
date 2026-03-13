import { resolvePort } from './resolve-port.js';

/**
 * Probe whether the Compose server is reachable.
 * @param {number} [port] - Server port (default: resolvePort())
 * @param {number} [timeoutMs=500] - Timeout in ms
 * @returns {Promise<boolean>} true if server responds 2xx to GET /api/health
 */
export async function probeServer(port, timeoutMs = 500) {
  const p = port ?? resolvePort();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`http://localhost:${p}/api/health`, {
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

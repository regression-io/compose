/**
 * Canonical port resolution for the Compose server.
 * Single source of truth: COMPOSE_PORT > PORT > 3001.
 */
export function resolvePort() {
  return Number(process.env.COMPOSE_PORT) || Number(process.env.PORT) || 3001;
}

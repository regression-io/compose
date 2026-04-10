/**
 * qa-scoping.js — COMP-QA: Diff-Aware QA Scoping (items 113-116)
 *
 * Analyzes git diff output (via context.filesChanged) to identify which
 * routes/pages are affected by a change set. v1 is file-analysis only —
 * no actual Playwright execution.
 *
 * Exports:
 *   mapFilesToRoutes(filesChanged, config?)
 *   classifyRoutes(routes, allKnownRoutes)
 *   detectDevServer(timeout?)
 */

import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Ports to probe when searching for a running dev server. */
const DEV_SERVER_PORTS = [3000, 3001, 4000, 5173, 8080];

/** Files that are docs/config only — no route mapping needed. */
const DOCS_CONFIG_EXTENSIONS = new Set([
  '.md', '.mdx', '.txt', '.rst',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.env',
  '.gitignore', '.npmrc', '.editorconfig',
  '.prettierrc', '.eslintrc',
]);

// ---------------------------------------------------------------------------
// Routes.yaml config loader
// ---------------------------------------------------------------------------

/**
 * Load explicit route mappings from .compose/routes.yaml or compose.routes.yaml.
 * Returns null if no config file is found or it cannot be parsed.
 *
 * @param {string} [cwd]  Project root. Defaults to process.cwd().
 * @returns {{ mappings: Array<{ pattern: string, routes: string[] }> } | null}
 */
export function loadRoutesConfig(cwd = process.cwd()) {
  const candidates = [
    join(cwd, '.compose', 'routes.yaml'),
    join(cwd, 'compose.routes.yaml'),
  ];

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const raw = readFileSync(candidate, 'utf-8');
      // Minimal YAML parser for the routes.yaml shape — avoids a yaml dep.
      const parsed = parseRoutesYaml(raw);
      if (parsed?.mappings && Array.isArray(parsed.mappings)) {
        return parsed;
      }
    } catch {
      // Malformed config — fall through to heuristics
    }
  }
  return null;
}

/**
 * Minimal parser for the routes.yaml shape.
 * Only handles the documented format — not a full YAML parser.
 *
 * Format:
 *   mappings:
 *     - pattern: "src/pages/auth/*"
 *       routes: ["/login", "/signup"]
 *     - pattern: "src/api/users*"
 *       routes: ["/api/users", "/api/users/:id"]
 *
 * @param {string} raw  Raw YAML content
 * @returns {{ mappings: Array<{ pattern: string, routes: string[] }> }}
 */
export function parseRoutesYaml(raw) {
  const lines = raw.split('\n');
  const mappings = [];
  let current = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Start of a new list item under mappings:
    if (trimmed.startsWith('- pattern:')) {
      if (current) mappings.push(current);
      const pattern = trimmed.replace(/^- pattern:\s*/, '').replace(/^["']|["']$/g, '');
      current = { pattern, routes: [] };
      continue;
    }

    if (trimmed.startsWith('pattern:') && current) {
      current.pattern = trimmed.replace(/^pattern:\s*/, '').replace(/^["']|["']$/g, '');
      continue;
    }

    if (trimmed.startsWith('routes:') && current) {
      // Inline array form: routes: ["/a", "/b"]
      const inline = trimmed.replace(/^routes:\s*/, '').trim();
      if (inline.startsWith('[')) {
        const items = inline.slice(1, inline.lastIndexOf(']'));
        current.routes = items.split(',')
          .map(r => r.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
      }
      continue;
    }

    // List item under routes:
    if (trimmed.startsWith('- /') && current) {
      const route = trimmed.replace(/^-\s*/, '').replace(/^["']|["']$/g, '');
      current.routes.push(route);
      continue;
    }
    if (trimmed.startsWith('- "') || trimmed.startsWith("- '")) {
      if (current) {
        const route = trimmed.replace(/^-\s*/, '').replace(/^["']|["']$/g, '');
        current.routes.push(route);
      }
    }
  }

  if (current) mappings.push(current);
  return { mappings };
}

// ---------------------------------------------------------------------------
// Framework detection
// ---------------------------------------------------------------------------

/**
 * Detect the frontend/server framework from file patterns in the changed set.
 *
 * @param {string[]} files  Changed file paths (relative to project root)
 * @returns {'nextjs' | 'express' | 'react-router' | 'spa' | 'unknown'}
 */
export function detectFramework(files) {
  for (const f of files) {
    const norm = f.replace(/\\/g, '/');
    if (/^(src\/)?app\//.test(norm) && /\.(jsx?|tsx?|mdx?)$/.test(norm)) return 'nextjs';
    if (/^(src\/)?pages\//.test(norm)) return 'nextjs';
    // React Router: check filename pattern BEFORE routes/ directory
    // so src/routes/AuthRoute.tsx resolves as react-router, not express.
    if (/Route\.(jsx?|tsx?)$/.test(norm)) return 'react-router';
    if (/routes?\.(jsx?|tsx?)$/.test(norm)) return 'react-router';
    // Express only if it's a routes/ dir with .js files (backend convention)
    if (/^(src\/)?routes?\//.test(norm) && /\.(js|ts|mjs|cjs)$/.test(norm) && !/\.(jsx|tsx)$/.test(norm)) return 'express';
  }

  // Fallback: check for react/SPA indicators
  for (const f of files) {
    const norm = f.replace(/\\/g, '/');
    if (/\.(jsx?|tsx?)$/.test(norm)) return 'spa';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Route derivation helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Next.js pages/ or app/ file path to a URL route.
 *
 * @param {string} file  e.g. "pages/users/[id].tsx" or "app/users/[id]/page.tsx"
 * @returns {string}  URL route, e.g. "/users/[id]"
 */
function nextjsFileToRoute(file) {
  const norm = file.replace(/\\/g, '/');

  // app/ directory: strip app/ prefix, remove /page.tsx, /route.tsx, /layout.tsx etc.
  const appMatch = norm.match(/(?:src\/)?app\/(.+?)(?:\/(?:page|route|layout|loading|error|not-found))?\.(?:jsx?|tsx?|mdx?)$/);
  if (appMatch) {
    const segments = appMatch[1]
      .split('/')
      .filter(s => !s.startsWith('(') || !s.endsWith(')')); // strip route groups like (auth)
    return '/' + segments.join('/');
  }

  // pages/ directory
  const pagesMatch = norm.match(/(?:src\/)?pages\/(.+)\.(?:jsx?|tsx?|mdx?)$/);
  if (pagesMatch) {
    const slug = pagesMatch[1];
    // Strip trailing /index or bare "index"
    const clean = slug.replace(/(?:^|\/)index$/, '') || '';
    if (!clean) return '/';
    return clean.startsWith('/') ? clean : '/' + clean;
  }

  return null;
}

/**
 * Convert an Express routes/ file path to a mount path hint.
 *
 * @param {string} file  e.g. "routes/users.js" or "src/routes/auth/login.js"
 * @returns {string}  Mount hint, e.g. "/users" or "/auth/login"
 */
function expressFileToRoute(file) {
  const norm = file.replace(/\\/g, '/');
  const match = norm.match(/(?:src\/)?routes?\/(.+)\.(?:jsx?|tsx?|mjs?)$/);
  if (!match) return null;
  const slug = match[1].replace(/(?:^|\/)index$/, '');
  if (!slug) return '/';
  return '/' + slug;
}

/**
 * Extract a route hint from a React Router route component filename.
 *
 * @param {string} file  e.g. "src/UserRoute.tsx" or "src/routes/AuthRoute.tsx"
 * @returns {string}  Hint like "/user" or "/auth"
 */
function reactRouterFileToRoute(file) {
  const norm = file.replace(/\\/g, '/');
  const base = norm.split('/').pop() ?? '';
  const name = base.replace(/Route\.(jsx?|tsx?)$/, '').replace(/routes?\.(jsx?|tsx?)$/, '');
  if (!name) return null;
  // camelCase or PascalCase → kebab-case path segment
  const kebab = name
    .replace(/([A-Z])/g, '-$1')
    .toLowerCase()
    .replace(/^-/, '');
  return '/' + kebab;
}

// ---------------------------------------------------------------------------
// Glob pattern matching
// ---------------------------------------------------------------------------

/**
 * Test whether a file path matches a glob-style pattern.
 * Supports * (any chars within a segment) and ** (any path).
 *
 * @param {string} file
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchesGlob(file, pattern) {
  const norm = file.replace(/\\/g, '/');
  const pat = pattern.replace(/\\/g, '/');

  // Convert glob to regex
  const escaped = pat
    .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex specials except * and ?
    .replace(/\\\*/g, '§STAR§')            // temporarily replace escaped *
    .replace(/\*\*/g, '§GLOBSTAR§')        // ** before *
    .replace(/\*/g, '[^/]*')               // * = any within segment
    .replace(/§GLOBSTAR§/g, '.*')          // ** = any path
    .replace(/§STAR§/g, '\\*');            // restore literal *

  const re = new RegExp(`^${escaped}$`);
  return re.test(norm);
}

// ---------------------------------------------------------------------------
// Main export: mapFilesToRoutes
// ---------------------------------------------------------------------------

/**
 * Map a set of changed files to affected routes/pages.
 *
 * @param {string[]} filesChanged  Changed file paths (relative to project root)
 * @param {object}  [config]       Optional config override
 * @param {string}  [config.cwd]   Project root for loading routes.yaml
 * @param {object}  [config.routes] Pre-loaded routes config (skips disk read)
 * @returns {{
 *   affectedRoutes: string[],
 *   unmappedFiles: string[],
 *   framework: string,
 *   docsOnly: boolean,
 * }}
 */
export function mapFilesToRoutes(filesChanged, config = {}) {
  const files = filesChanged ?? [];

  // Check if all files are docs/config only
  const docsOnly = files.length > 0 && files.every(f => {
    const ext = '.' + f.split('.').pop();
    return DOCS_CONFIG_EXTENSIONS.has(ext) || f.startsWith('docs/') || f.startsWith('.compose/');
  });

  if (docsOnly) {
    return { affectedRoutes: [], unmappedFiles: files, framework: 'unknown', docsOnly: true };
  }

  // Load explicit routes config
  const routesConfig = config.routes ?? loadRoutesConfig(config.cwd ?? process.cwd());

  const affectedRoutes = new Set();
  const unmappedFiles = [];

  // Check explicit mappings first
  if (routesConfig?.mappings?.length > 0) {
    for (const file of files) {
      let matched = false;
      for (const mapping of routesConfig.mappings) {
        if (matchesGlob(file, mapping.pattern)) {
          for (const route of mapping.routes ?? []) {
            affectedRoutes.add(route);
          }
          matched = true;
        }
      }
      if (!matched) unmappedFiles.push(file);
    }

    return {
      affectedRoutes: [...affectedRoutes],
      unmappedFiles,
      framework: 'explicit',
      docsOnly: false,
    };
  }

  // Heuristic framework detection
  const framework = detectFramework(files);

  for (const file of files) {
    let route = null;

    if (framework === 'nextjs') {
      route = nextjsFileToRoute(file);
    } else if (framework === 'express') {
      route = expressFileToRoute(file);
    } else if (framework === 'react-router') {
      route = reactRouterFileToRoute(file);
    }
    // spa / unknown: mark as unmapped

    if (route) {
      affectedRoutes.add(route);
    } else {
      unmappedFiles.push(file);
    }
  }

  return {
    affectedRoutes: [...affectedRoutes],
    unmappedFiles,
    framework,
    docsOnly: false,
  };
}

// ---------------------------------------------------------------------------
// Export: classifyRoutes
// ---------------------------------------------------------------------------

/**
 * Classify routes as affected (directly changed) vs adjacent (share parent path).
 *
 * Adjacent routes share the same path prefix as any affected route.
 * E.g. if /users/123 is affected, /users is adjacent.
 *
 * @param {string[]} affectedRoutes  Routes directly changed
 * @param {string[]} allKnownRoutes  Full set of known routes in the app
 * @returns {{ affected: string[], adjacent: string[] }}
 */
export function classifyRoutes(affectedRoutes, allKnownRoutes) {
  const affectedSet = new Set(affectedRoutes);
  const adjacent = new Set();

  for (const affected of affectedRoutes) {
    // Build all parent paths of the affected route
    const segments = affected.split('/').filter(Boolean);
    for (let depth = 1; depth < segments.length; depth++) {
      const parentPath = '/' + segments.slice(0, depth).join('/');
      for (const known of allKnownRoutes) {
        if (known === parentPath && !affectedSet.has(known)) {
          adjacent.add(known);
        }
      }
    }

    // Also find siblings (same parent prefix, different leaf)
    const parentPrefix = affected.substring(0, affected.lastIndexOf('/')) || '/';
    for (const known of allKnownRoutes) {
      if (!affectedSet.has(known) && known !== affected) {
        const knownParent = known.substring(0, known.lastIndexOf('/')) || '/';
        if (knownParent === parentPrefix) {
          adjacent.add(known);
        }
      }
    }
  }

  return {
    affected: [...affectedSet],
    adjacent: [...adjacent],
  };
}

// ---------------------------------------------------------------------------
// Export: detectDevServer
// ---------------------------------------------------------------------------

/**
 * Probe common dev server ports and return the first that responds.
 * Detection only — never starts a server.
 *
 * @param {number} [timeout=5000]  Per-port timeout in milliseconds
 * @returns {Promise<{ url: string, port: number } | null>}
 */
export async function detectDevServer(timeout = 5000) {
  for (const port of DEV_SERVER_PORTS) {
    const url = `http://localhost:${port}`;
    try {
      const result = await probePort(url, timeout);
      if (result) return { url, port };
    } catch {
      // Port not responding — try next
    }
  }
  return null;
}

/**
 * Probe a single URL with a timeout.
 * Returns true if the server responds (any HTTP status), false on error/timeout.
 *
 * @param {string} url
 * @param {number} timeout  Milliseconds
 * @returns {Promise<boolean>}
 */
async function probePort(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      // Ignore redirect chains — we just want any response
    });
    return true;
  } catch (err) {
    // AbortError = timeout, ECONNREFUSED = nothing listening
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Utility: isDocsOnlyDiff
// ---------------------------------------------------------------------------

/**
 * Returns true if all changed files are documentation or config — no code paths
 * that would map to routes.
 *
 * @param {string[]} filesChanged
 * @returns {boolean}
 */
export function isDocsOnlyDiff(filesChanged) {
  if (!filesChanged?.length) return false;
  return filesChanged.every(f => {
    const norm = f.replace(/\\/g, '/');
    const dotParts = norm.split('.');
    const ext = dotParts.length > 1 ? '.' + dotParts.pop() : '';
    return (
      DOCS_CONFIG_EXTENSIONS.has(ext) ||
      norm.startsWith('docs/') ||
      norm.startsWith('.compose/') ||
      norm.startsWith('.github/')
    );
  });
}

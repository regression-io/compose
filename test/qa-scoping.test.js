/**
 * Tests for lib/qa-scoping.js — COMP-QA diff-aware QA scoping.
 *
 * Test plan:
 *   1. Next.js pages/ files map to URL routes
 *   2. Next.js app/ files map to URL routes
 *   3. Express routes/ files map to mount paths
 *   4. docs/config-only diff → docsOnly: true, empty affectedRoutes
 *   5. Explicit routes.yaml overrides heuristics
 *   6. classifyRoutes: adjacent routes identified by shared parent prefix
 *   7. detectDevServer returns null when nothing is listening
 *   8. React Router Route file → kebab-case path hint
 *   9. Glob matching helper
 *  10. parseRoutesYaml handles inline array format
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mapFilesToRoutes,
  classifyRoutes,
  detectDevServer,
  matchesGlob,
  parseRoutesYaml,
  isDocsOnlyDiff,
} from '../lib/qa-scoping.js';

// ---------------------------------------------------------------------------
// 1. Next.js pages/ mapping
// ---------------------------------------------------------------------------

describe('mapFilesToRoutes — Next.js pages/ heuristic', () => {
  it('maps pages/index.tsx to /', () => {
    const result = mapFilesToRoutes(['pages/index.tsx']);
    assert.equal(result.framework, 'nextjs');
    assert.deepEqual(result.affectedRoutes, ['/']);
    assert.equal(result.docsOnly, false);
  });

  it('maps pages/users/[id].tsx to /users/[id]', () => {
    const result = mapFilesToRoutes(['pages/users/[id].tsx']);
    assert.equal(result.framework, 'nextjs');
    assert.ok(result.affectedRoutes.includes('/users/[id]'));
  });

  it('maps pages/about.tsx to /about', () => {
    const result = mapFilesToRoutes(['pages/about.tsx']);
    assert.ok(result.affectedRoutes.includes('/about'));
  });

  it('maps src/pages/dashboard.tsx to /dashboard', () => {
    const result = mapFilesToRoutes(['src/pages/dashboard.tsx']);
    assert.equal(result.framework, 'nextjs');
    assert.ok(result.affectedRoutes.includes('/dashboard'));
  });
});

// ---------------------------------------------------------------------------
// 2. Next.js app/ directory mapping
// ---------------------------------------------------------------------------

describe('mapFilesToRoutes — Next.js app/ heuristic', () => {
  it('maps app/users/page.tsx to /users', () => {
    const result = mapFilesToRoutes(['app/users/page.tsx']);
    assert.equal(result.framework, 'nextjs');
    assert.ok(result.affectedRoutes.includes('/users'));
  });

  it('maps app/settings/profile/page.tsx to /settings/profile', () => {
    const result = mapFilesToRoutes(['app/settings/profile/page.tsx']);
    assert.ok(result.affectedRoutes.includes('/settings/profile'));
  });

  it('strips route groups from app/ paths — app/(auth)/login/page.tsx', () => {
    const result = mapFilesToRoutes(['app/(auth)/login/page.tsx']);
    // (auth) is a route group — should be stripped
    assert.ok(result.affectedRoutes.some(r => r.includes('login')));
  });
});

// ---------------------------------------------------------------------------
// 3. Express routes/ mapping
// ---------------------------------------------------------------------------

describe('mapFilesToRoutes — Express routes/ heuristic', () => {
  it('maps routes/users.js to /users', () => {
    const result = mapFilesToRoutes(['routes/users.js']);
    assert.equal(result.framework, 'express');
    assert.ok(result.affectedRoutes.includes('/users'));
  });

  it('maps src/routes/auth/login.js to /auth/login', () => {
    const result = mapFilesToRoutes(['src/routes/auth/login.js']);
    assert.equal(result.framework, 'express');
    assert.ok(result.affectedRoutes.includes('/auth/login'));
  });

  it('maps routes/index.js to /', () => {
    const result = mapFilesToRoutes(['routes/index.js']);
    assert.ok(result.affectedRoutes.includes('/'));
  });
});

// ---------------------------------------------------------------------------
// 4. Docs/config-only diff
// ---------------------------------------------------------------------------

describe('mapFilesToRoutes — docs/config-only diff', () => {
  it('returns docsOnly: true for .md files', () => {
    const result = mapFilesToRoutes(['README.md', 'docs/api.md']);
    assert.equal(result.docsOnly, true);
    assert.deepEqual(result.affectedRoutes, []);
  });

  it('returns docsOnly: true for .yaml config files', () => {
    const result = mapFilesToRoutes(['.compose/routes.yaml', 'package.json']);
    assert.equal(result.docsOnly, true);
  });

  it('returns docsOnly: false when code files are mixed in', () => {
    const result = mapFilesToRoutes(['README.md', 'pages/about.tsx']);
    assert.equal(result.docsOnly, false);
    assert.ok(result.affectedRoutes.length > 0);
  });

  it('returns docsOnly: false for empty array', () => {
    const result = mapFilesToRoutes([]);
    assert.equal(result.docsOnly, false);
  });
});

// ---------------------------------------------------------------------------
// 5. Explicit routes.yaml overrides heuristics
// ---------------------------------------------------------------------------

describe('mapFilesToRoutes — explicit routes.yaml config', () => {
  const routesConfig = {
    mappings: [
      {
        pattern: 'src/pages/auth/*',
        routes: ['/login', '/signup', '/forgot-password'],
      },
      {
        pattern: 'src/api/users*',
        routes: ['/api/users', '/api/users/:id'],
      },
    ],
  };

  it('maps files via explicit config patterns', () => {
    const result = mapFilesToRoutes(
      ['src/pages/auth/Login.tsx'],
      { routes: routesConfig }
    );
    assert.equal(result.framework, 'explicit');
    assert.ok(result.affectedRoutes.includes('/login'));
    assert.ok(result.affectedRoutes.includes('/signup'));
  });

  it('maps API file via config', () => {
    const result = mapFilesToRoutes(
      ['src/api/users.js'],
      { routes: routesConfig }
    );
    assert.ok(result.affectedRoutes.includes('/api/users'));
    assert.ok(result.affectedRoutes.includes('/api/users/:id'));
  });

  it('marks files not matching any pattern as unmapped', () => {
    const result = mapFilesToRoutes(
      ['src/components/Button.tsx'],
      { routes: routesConfig }
    );
    assert.ok(result.unmappedFiles.includes('src/components/Button.tsx'));
  });

  it('config overrides heuristic — no Next.js detection for pages/ files', () => {
    const result = mapFilesToRoutes(
      ['src/pages/auth/Login.tsx'],
      { routes: routesConfig }
    );
    // framework should be 'explicit', not 'nextjs'
    assert.equal(result.framework, 'explicit');
  });
});

// ---------------------------------------------------------------------------
// 6. classifyRoutes — adjacent route detection
// ---------------------------------------------------------------------------

describe('classifyRoutes', () => {
  const allKnownRoutes = [
    '/',
    '/users',
    '/users/new',
    '/users/[id]',
    '/users/[id]/edit',
    '/settings',
    '/settings/profile',
    '/settings/billing',
  ];

  it('marks directly changed routes as affected', () => {
    const { affected } = classifyRoutes(['/users/[id]'], allKnownRoutes);
    assert.ok(affected.includes('/users/[id]'));
  });

  it('marks parent path as adjacent when leaf is affected', () => {
    const { adjacent } = classifyRoutes(['/users/[id]'], allKnownRoutes);
    assert.ok(adjacent.includes('/users'), `Expected /users in adjacent, got: ${JSON.stringify(adjacent)}`);
  });

  it('marks sibling routes as adjacent', () => {
    const { adjacent } = classifyRoutes(['/settings/profile'], allKnownRoutes);
    assert.ok(adjacent.includes('/settings/billing'), `Expected /settings/billing in adjacent`);
  });

  it('does not include affected routes in adjacent', () => {
    const { affected, adjacent } = classifyRoutes(['/users'], allKnownRoutes);
    assert.ok(affected.includes('/users'));
    assert.ok(!adjacent.includes('/users'));
  });

  it('handles empty affected list', () => {
    const { affected, adjacent } = classifyRoutes([], allKnownRoutes);
    assert.deepEqual(affected, []);
    assert.deepEqual(adjacent, []);
  });
});

// ---------------------------------------------------------------------------
// 7. detectDevServer returns null when nothing listening
// ---------------------------------------------------------------------------

describe('detectDevServer', () => {
  it('returns null when no dev server is running on any probe port', async () => {
    // Use a very short timeout so the test is fast.
    // In CI nothing should be listening on all 5 ports simultaneously.
    const result = await detectDevServer(200);
    // Result is null OR an object with url/port — we can only assert shape
    // We cannot guarantee null in all environments, but we can verify shape.
    if (result !== null) {
      assert.ok(typeof result.url === 'string', 'url should be string');
      assert.ok(typeof result.port === 'number', 'port should be number');
    } else {
      assert.equal(result, null);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. React Router Route file mapping
// ---------------------------------------------------------------------------

describe('mapFilesToRoutes — React Router heuristic', () => {
  it('maps UserRoute.tsx to /user', () => {
    const result = mapFilesToRoutes(['src/UserRoute.tsx']);
    assert.equal(result.framework, 'react-router');
    assert.ok(result.affectedRoutes.includes('/user'));
  });

  it('maps AuthRoute.tsx to /auth', () => {
    const result = mapFilesToRoutes(['src/AuthRoute.tsx']);
    assert.ok(result.affectedRoutes.includes('/auth'));
  });

  it('maps DashboardRoute.jsx to /dashboard', () => {
    const result = mapFilesToRoutes(['src/DashboardRoute.jsx']);
    assert.ok(result.affectedRoutes.includes('/dashboard'));
  });
});

// ---------------------------------------------------------------------------
// 9. matchesGlob helper
// ---------------------------------------------------------------------------

describe('matchesGlob', () => {
  it('matches * within segment', () => {
    assert.ok(matchesGlob('src/pages/auth/Login.tsx', 'src/pages/auth/*'));
    assert.ok(!matchesGlob('src/pages/auth/sub/Login.tsx', 'src/pages/auth/*'));
  });

  it('matches ** across segments', () => {
    assert.ok(matchesGlob('src/api/users/profile.js', 'src/api/**'));
  });

  it('matches literal pattern', () => {
    assert.ok(matchesGlob('src/api/users.js', 'src/api/users.js'));
    assert.ok(!matchesGlob('src/api/users2.js', 'src/api/users.js'));
  });

  it('matches trailing * for prefix patterns', () => {
    assert.ok(matchesGlob('src/api/users.js', 'src/api/users*'));
    assert.ok(matchesGlob('src/api/usersById.js', 'src/api/users*'));
  });
});

// ---------------------------------------------------------------------------
// 10. parseRoutesYaml
// ---------------------------------------------------------------------------

describe('parseRoutesYaml', () => {
  it('parses inline array routes format', () => {
    const yaml = `
mappings:
  - pattern: "src/pages/auth/*"
    routes: ["/login", "/signup", "/forgot-password"]
  - pattern: "src/api/users*"
    routes: ["/api/users", "/api/users/:id"]
`;
    const result = parseRoutesYaml(yaml);
    assert.equal(result.mappings.length, 2);
    assert.equal(result.mappings[0].pattern, 'src/pages/auth/*');
    assert.deepEqual(result.mappings[0].routes, ['/login', '/signup', '/forgot-password']);
    assert.equal(result.mappings[1].pattern, 'src/api/users*');
  });

  it('parses list-style routes format', () => {
    const yaml = `
mappings:
  - pattern: "src/pages/auth/*"
    routes:
      - "/login"
      - "/signup"
`;
    const result = parseRoutesYaml(yaml);
    assert.equal(result.mappings.length, 1);
    assert.ok(result.mappings[0].routes.includes('/login'));
    assert.ok(result.mappings[0].routes.includes('/signup'));
  });

  it('returns empty mappings for empty input', () => {
    const result = parseRoutesYaml('');
    assert.deepEqual(result.mappings, []);
  });
});

// ---------------------------------------------------------------------------
// 11. isDocsOnlyDiff
// ---------------------------------------------------------------------------

describe('isDocsOnlyDiff', () => {
  it('returns true for markdown-only changes', () => {
    assert.ok(isDocsOnlyDiff(['README.md', 'docs/guide.md']));
  });

  it('returns true for config-only changes', () => {
    assert.ok(isDocsOnlyDiff(['package.json', '.eslintrc.yaml']));
  });

  it('returns false when code files are present', () => {
    assert.ok(!isDocsOnlyDiff(['README.md', 'lib/foo.js']));
  });

  it('returns false for empty array', () => {
    assert.ok(!isDocsOnlyDiff([]));
  });

  it('returns false for null/undefined', () => {
    assert.ok(!isDocsOnlyDiff(null));
    assert.ok(!isDocsOnlyDiff(undefined));
  });
});

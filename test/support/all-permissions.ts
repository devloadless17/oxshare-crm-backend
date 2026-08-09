import permissionsCatalog from '../../src/config/permissions.json';

/**
 * Every key in the catalog — what a fully-privileged actor holds in a test.
 *
 * Fixtures used to write `['*']`, and the wildcard is gone: it meant "every
 * permission, including every permission added later", which is exactly the
 * retroactive grant the permission model was rebuilt to remove. A test actor
 * still carrying one would pass every check while the real system refused the
 * same request — the worst thing a fixture can do, because the suite goes green
 * on behaviour that does not exist.
 *
 * Read from the same file the API serves, never a second hand-written list, so
 * a key added to the catalog reaches these actors without anybody remembering
 * to update a test constant.
 */
export const ALL_PERMISSIONS: string[] = Object.values(
  permissionsCatalog as Record<string, { permissions: { key: string }[] }>,
).flatMap((module) => module.permissions.map((entry) => entry.key));

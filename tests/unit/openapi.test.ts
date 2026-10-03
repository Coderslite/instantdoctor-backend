import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import SwaggerParser from '@apidevtools/swagger-parser';
import { describe, expect, it } from 'vitest';
import { buildOpenApiDocument, documentedOperations } from '../../src/docs/openapi.js';

const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? files(join(dir, f)) : [join(dir, f)]));

/**
 * Every route actually registered in the source, as "METHOD /full/path".
 * Read from the code (mounts in routes.ts/app.ts + each *.routes.ts), so adding
 * a route without documenting it fails this test.
 */
function implementedOperations(): Set<string> {
  const mounts = new Map<string, string>();
  for (const [, path, router] of readFileSync('src/routes.ts', 'utf8').matchAll(/apiRouter\.use\('([^']*)',\s*(\w+)\)/g)) {
    mounts.set(router!, `/v1${path === '/' ? '' : path}`);
  }
  const appSource = readFileSync('src/app.ts', 'utf8');
  for (const [, path, router] of appSource.matchAll(/app\.use\('([^']*)',\s*(\w+Router)\)/g)) mounts.set(router!, path!);

  const ops = new Set<string>();
  for (const file of files('src/modules').filter((f) => f.endsWith('.routes.ts'))) {
    const src = readFileSync(file, 'utf8');
    for (const [, router, method, path] of src.matchAll(/^(\w+Router)\.(get|post|put|patch|delete)(?:<[^>]*>)?\(\s*'([^']*)'/gm)) {
      const prefix = mounts.get(router!);
      if (prefix === undefined) throw new Error(`${router} in ${file} is not mounted`);
      ops.add(`${method!.toUpperCase()} ${prefix}${path === '/' ? '' : path}`);
    }
  }
  for (const [, method, path] of appSource.matchAll(/app\.(get|post)\('(\/health)'/g)) ops.add(`${method!.toUpperCase()} ${path}`);
  return ops;
}

describe('OpenAPI document', () => {
  it('is a valid OpenAPI 3.1 document', async () => {
    const doc = buildOpenApiDocument('http://localhost:4000');
    await expect(SwaggerParser.validate(structuredClone(doc) as never)).resolves.toBeDefined();
  });

  it('documents every implemented route', () => {
    const undocumented = [...implementedOperations()].filter((op) => !documentedOperations.has(op));
    expect(undocumented).toEqual([]);
  });

  it('documents no route that does not exist', () => {
    const implemented = implementedOperations();
    const phantom = [...documentedOperations].filter((op) => !implemented.has(op));
    expect(phantom).toEqual([]);
  });
});

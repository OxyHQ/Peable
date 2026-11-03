import { describe, expect, test } from 'bun:test';
import { unresolvedObjectReferences } from '../common/objects';
import { buildOpenApiDocument } from '../openapi';
import { routes } from '../routes';
import type { RouteContract } from '../route';

const all = routes as readonly RouteContract[];

describe('the OpenAPI document', () => {
  test('is generated deterministically', () => {
    expect(JSON.stringify(buildOpenApiDocument())).toBe(JSON.stringify(buildOpenApiDocument()));
  });

  test('declares every route once, with an operationId', () => {
    const document = buildOpenApiDocument();
    let operations = 0;
    for (const methods of Object.values(document.paths)) operations += Object.keys(methods).length;
    expect(operations).toBe(all.length);
  });

  test('every $ref names a component that exists', () => {
    const document = buildOpenApiDocument();
    const schemas = (document.components as { schemas: Record<string, unknown> }).schemas;
    const refs = [
      ...JSON.stringify(document).matchAll(/"\$ref":"#\/components\/schemas\/([^"]+)"/g),
    ];
    const missing = refs.map((match) => match[1]).filter((id) => !(id && id in schemas));
    expect([...new Set(missing)]).toEqual([]);
  });
});

describe('the route contracts', () => {
  test('operationIds, method+path pairs and SDK method names are unique', () => {
    const dupes = (values: readonly string[]) =>
      values.filter((value, index) => values.indexOf(value) !== index);
    expect(dupes(all.map((route) => route.operationId))).toEqual([]);
    expect(dupes(all.map((route) => `${route.method} ${route.path}`))).toEqual([]);
    expect(dupes(all.flatMap((route) => (route.sdk === undefined ? [] : [route.sdk])))).toEqual([]);
  });

  test('a path parameter is documented for every {name} in the path', () => {
    const undocumented = all.flatMap((route) =>
      [...route.path.matchAll(/\{([^}]+)\}/g)]
        .map((match) => match[1] as string)
        .filter((name) => route.params?.[name] === undefined)
        .map((name) => `${route.operationId}: ${name}`),
    );
    expect(undocumented).toEqual([]);
  });

  test('a body is only declared on a write', () => {
    expect(
      all.filter((r) => r.body !== undefined && r.method === 'get').map((r) => r.operationId),
    ).toEqual([]);
  });
});

describe('the object registry', () => {
  test('every reference resolves to a registered object (no stand-in left)', () => {
    buildOpenApiDocument();
    expect([...unresolvedObjectReferences]).toEqual([]);
  });
});

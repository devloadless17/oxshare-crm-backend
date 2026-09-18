import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import { PATH_METADATA, METHOD_METADATA, GUARDS_METADATA } from '@nestjs/common/constants';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import {
  CLIENT_SCOPE_KEY,
  type ClientScopeStance,
} from '../../src/modules/admin/guards/client-scope.decorator';

/**
 * Every route the application actually registers, with the client-scope stance
 * it declares — read from Nest's own metadata rather than scanned out of source.
 *
 * ## Why this is a module and not a helper inside a spec
 *
 * It was one. `client-scope-coverage.spec.ts` exported `scopeFacts()`, and both
 * that file and `client-scope-enforcement.spec.ts` claimed the second derived
 * its inputs from the first — the decorator's own docblock said a route "cannot
 * enter the declared-scoped set without also being exercised".
 *
 * Nothing imported it, and nothing could have: it read `discovery` and
 * `reflector` from module-level `let`s that the coverage spec's own `beforeAll`
 * assigns. Imported anywhere else those are `undefined` and the call throws. So
 * the claim was not merely unfulfilled, it was unfulfillable as written, and the
 * enforcement spec hard-coded eleven routes against sixty-nine declarations.
 *
 * Taking the app as an ARGUMENT is what makes it shareable: each spec passes the
 * app it already booted, and there is no hidden state to initialise in the right
 * order.
 */

const METHOD_NAMES: Record<number, string> = {
  [RequestMethod.GET]: 'GET',
  [RequestMethod.POST]: 'POST',
  [RequestMethod.PUT]: 'PUT',
  [RequestMethod.DELETE]: 'DELETE',
  [RequestMethod.PATCH]: 'PATCH',
  [RequestMethod.OPTIONS]: 'OPTIONS',
  [RequestMethod.HEAD]: 'HEAD',
  [RequestMethod.ALL]: 'ALL',
};

export interface ScopeFacts {
  /** `GET /admin/clients/:id` — the method and the path Nest registered. */
  signature: string;
  /** What `@ScopedToClients` / `@NotClientScoped` says, or undefined for neither. */
  stance?: ClientScopeStance;
  guards: string[];
}

const normalise = (p: string) => (p === '/' || p === '' ? '' : `/${p.replace(/^\/|\/$/g, '')}`);
const joinPath = (prefix: string, path: string) => `${prefix}${path}` || '/';

function pathsOf(raw: unknown): string[] {
  if (typeof raw === 'string') return [normalise(raw)];
  if (Array.isArray(raw)) return raw.flatMap((entry) => pathsOf(entry));
  if (raw && typeof raw === 'object' && 'path' in raw) return pathsOf(raw.path);
  return [''];
}

const nameOf = (guard: unknown): string => {
  if (typeof guard === 'function') return guard.name;
  if (guard && typeof guard === 'object') return guard.constructor.name;
  return String(guard);
};

/** Every route, with the scope stance it declares. */
export function collectScopeFacts(app: INestApplication): ScopeFacts[] {
  const discovery = app.get(DiscoveryService);
  const reflector = app.get(Reflector);
  const scanner = new MetadataScanner();
  const found: ScopeFacts[] = [];

  for (const wrapper of discovery.getControllers()) {
    const instance = wrapper.instance as Record<string, unknown> | undefined;
    const controllerClass = wrapper.metatype as (new (...args: never[]) => unknown) | undefined;
    if (!instance || !controllerClass) continue;

    const prefixes = pathsOf(Reflect.getMetadata(PATH_METADATA, controllerClass));
    const classGuards = (Reflect.getMetadata(GUARDS_METADATA, controllerClass) ?? []) as unknown[];
    const prototype = Object.getPrototypeOf(instance) as object;

    for (const methodName of scanner.getAllMethodNames(prototype)) {
      const handler = instance[methodName] as ((...args: never[]) => unknown) | undefined;
      if (!handler) continue;
      const raw = Reflect.getMetadata(PATH_METADATA, handler) as unknown;
      if (raw === undefined) continue;

      const method = Reflect.getMetadata(METHOD_METADATA, handler) as number;
      const handlerGuards = (Reflect.getMetadata(GUARDS_METADATA, handler) ?? []) as unknown[];

      for (const prefix of prefixes) {
        for (const path of pathsOf(raw)) {
          found.push({
            signature: `${METHOD_NAMES[method]} ${joinPath(prefix, path)}`,
            stance: reflector.get<ClientScopeStance>(CLIENT_SCOPE_KEY, handler),
            guards: [...classGuards, ...handlerGuards].map(nameOf),
          });
        }
      }
    }
  }

  return found;
}

/**
 * The routes that declare `@ScopedToClients` AND name something in their path.
 *
 * The set `client-scope-enforcement.spec.ts` has to account for: a scoped route
 * with no path parameter is a LIST, and a list is exercised by asking whether an
 * out-of-scope row comes back. A route with a parameter has to be driven by id,
 * and that is where the 404-not-403 rule either holds or does not.
 */
export function scopedByIdRoutes(app: INestApplication): string[] {
  return collectScopeFacts(app)
    .filter((route) => route.stance?.stance === 'scoped' && route.signature.includes('/:'))
    .map((route) => route.signature)
    .sort();
}

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotificationsService } from '../src/modules/notifications/notifications.service';

/**
 * NOTIFICATION PARAMS MAY NOT CARRY CLIENT-OWNED VALUES.
 *
 * ## Why this still matters now that the admin feed is scoped when READ
 *
 * This test was written while `GET /admin/notifications` was scoped only at
 * WRITE time, and it was the one thing keeping a re-tagged client's rows
 * harmless: a payload of identifiers is an unresolvable uuid, a payload with a
 * name is a disclosure. Migration 0140 added the read-time scope that note
 * called for (`subject_user_id`, `NotificationsStore.adminVisibility`), and a
 * task now NAMES its client — joined from `users` at read time, masked per
 * reader by the RBAC-03 interceptor.
 *
 * The rule survives because the paths that do NOT go through that read still
 * carry `params`: the socket pushes them straight from `pg_notify` (no HTTP,
 * no mask), and the CLIENT feed is a different audience entirely. A name in
 * `params` would reach both unmasked. So identity stays out of the payload and
 * comes only from the masked join — the division of labour this test enforces.
 *
 * If a param ever legitimately needs client PII, this test is the place that
 * says so out loud, and the socket payload has to be re-thought first.
 */

const SRC = join(__dirname, '..', 'src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return sources(full);
    return e.isFile() && e.name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * The same vocabulary the admin app's `client-identity-census` uses, so "what
 * counts as client identity" has one definition across the system rather than
 * two that drift.
 */
const CLIENT_IDENTITY =
  /\b(email|firstName|lastName|fullName|clientName|partnerName|phone|dateOfBirth|address)\b|\b\w+(Email|FirstName|LastName|FullName|Phone)\b/;

/** Brace-balanced body of the `params:` object starting at `from`. */
function paramsLiteral(text: string, from: number): string | undefined {
  const open = text.indexOf('{', from);
  if (open === -1) return undefined;
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1;
    else if (text[i] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, i);
    }
  }
  return undefined;
}

describe('a notification payload carries no client-owned value', () => {
  it('no `params:` literal in src/ names an identity field', () => {
    const offenders: string[] = [];

    for (const file of sources(SRC)) {
      const text = readFileSync(file, 'utf8');
      // Every `params:` in the tree, not only those syntactically inside a
      // notify() call: the payload is frequently built into a local and passed
      // in, and a scanner that only understood the call shape would miss it.
      for (let i = text.indexOf('params:'); i !== -1; i = text.indexOf('params:', i + 1)) {
        // Only an object LITERAL: `params: row.params` passes a value along,
        // and the next `{` in the file belongs to whatever follows it.
        const afterColon = text.slice(i + 'params:'.length).trimStart();
        if (!afterColon.startsWith('{')) continue;
        const body = paramsLiteral(text, i + 'params:'.length);
        if (body === undefined) continue;
        // Keys only. A VALUE may legitimately mention one of these words —
        // `reason: 'missing email'` describes a failure, it does not carry one.
        const keys = [...body.matchAll(/(?:^|[,{\s])([A-Za-z_][\w]*)\s*:/g)].map((m) => m[1]);
        const bad = keys.filter((k) => CLIENT_IDENTITY.test(k));
        if (bad.length > 0) {
          offenders.push(`${file.replace(SRC, 'src')}: ${bad.join(', ')}`);
        }
      }
    }

    expect(
      offenders,
      'A notification/event payload names a client identity field.\n' +
        'Params travel UNMASKED over the socket (pg_notify → the gateway) and into\n' +
        "the client's own feed. A task's client is named by the masked read-time\n" +
        'join (NotificationsStore.findAdminPage), never by its payload — keep the\n' +
        'value out of params.\n' +
        `Offenders:\n  ${offenders.join('\n  ')}`,
    ).toEqual([]);
  });

  it('knows every fan-out method, so a new one cannot slip past the scan', () => {
    /*
     * The scan above reads `params:` literals rather than call sites, which is
     * deliberately broader. This is the declare-or-explain half: if
     * NotificationsService grows another way to emit, somebody has to look at
     * this file and decide whether the payload rule still reaches it.
     */
    const emitters = Object.getOwnPropertyNames(NotificationsService.prototype)
      .filter((m) => /^notify/.test(m))
      .sort();

    expect(
      emitters,
      'NotificationsService gained or lost a notify* method. Confirm the payload ' +
        'rule above still covers every path that writes a notification row, then ' +
        'update this list.',
    ).toEqual(['notify', 'notifyAdmins']);
  });
});

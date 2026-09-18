import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { NotificationsService } from '../src/modules/notifications/notifications.service';

/**
 * NOTIFICATION PARAMS MAY NOT CARRY CLIENT-OWNED VALUES.
 *
 * ## The gap this closes, and why it is not the obvious one
 *
 * `GET /admin/notifications` is `@NotClientScoped`, and its reason says scope
 * is applied at WRITE time: the fan-out only creates rows for admins whose
 * client scope covered the subject at the moment of the event, "so every row
 * here is already inside the reader's territory".
 *
 * That sentence is true when the row is written and can stop being true
 * afterwards. Re-tag a client out of a desk and the rows already fanned out to
 * that desk stay readable for the 90-day retention. It is the same shape as the
 * `audit_log.actor_email` defect: a justification that was accurate about the
 * moment it was written and was never re-checked against the moment it is read.
 *
 * ## Why the answer is this test rather than a read-time predicate
 *
 * Measured before deciding: of 1,468 admin notification rows, ZERO contain an
 * address or a name. Every call site passes identifiers, amounts, currencies
 * and states — `{ userId }`, `{ transactionId, amount, currency }`. So what a
 * re-tagged-out admin can still read is "something happened to <uuid> at
 * <time>", and that uuid resolves nowhere else: `GET /admin/clients/:id` 404s
 * for a client outside their territory, by the 404-never-403 rule.
 *
 * A read-time predicate would need a `subject_user_id` column that does not
 * exist, a migration, and a backfill — to close a window that leaks an opaque
 * identifier. The property that actually keeps the severity low is that the
 * PAYLOAD carries no client-owned value, and nothing was enforcing it. So that
 * is what is enforced here: the residual stays an unresolvable uuid rather than
 * becoming a name the day somebody makes a feed entry friendlier.
 *
 * If a param ever legitimately needs client PII, this test is the place that
 * says so out loud — and the read-time scope becomes required work, not a
 * judgement call.
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
        'The admin feed is NotClientScoped on the argument that write-time fan-out\n' +
        'already bounded it — which stops being true the moment a client is\n' +
        're-tagged out, and those rows live for 90 days. While the payload holds\n' +
        'only identifiers that is an unresolvable uuid; with a name in it, it is a\n' +
        'disclosure. Either keep the value out, or add the read-time scope the\n' +
        "route's @NotClientScoped reason currently does without.\n" +
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
    ).toEqual(['notify', 'notifyAdminsWithPermission']);
  });
});

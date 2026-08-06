import { Injectable } from '@nestjs/common';
import { AdminIpAllowlistStore, type AllowlistRule } from '../../store/admin-ip-allowlist.store';
import {
  canonicaliseRule,
  ipMatchesAny,
  isValidRule,
  matchesEverything,
} from '../../common/security/ip-range';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';
import { Admin } from '../../store/admins.store';
import { assertActorCan } from '../../common/security/actor';

/**
 * RBAC-08 — managing the admin IP allowlist.
 *
 * The rule that shapes this file is the LOCKOUT one. The largest operational
 * risk in the whole feature is not an attacker; it is an administrator adding a
 * range that excludes themselves and losing the screen they would use to undo
 * it. So every mutation is checked against the caller's own current address:
 * you may not create a first rule you are not inside, and you may not delete the
 * last rule that is keeping you in.
 *
 * That check is what makes it safe to have no break-glass backdoor. A
 * bypass-everything environment variable would be a permanent hole guarding
 * against a mistake we can simply refuse to make.
 */
@Injectable()
export class AdminIpAllowlistService {
  constructor(
    private readonly store: AdminIpAllowlistStore,
    private readonly audit: AdminAuditService,
  ) {}

  list(): Promise<AllowlistRule[]> {
    return this.store.findAll();
  }

  /**
   * @param callerIp the requesting admin's own address, so the rule that would
   *   lock them out can be refused rather than applied and regretted.
   */
  async add(
    input: { cidr: string; label: string },
    actor: Admin,
    callerIp: string | undefined,
  ): Promise<AllowlistRule> {
    // R-4.3: asserted here, not only in the guard. This list is the control that
    // decides which networks may reach the admin API at all — a caller who can
    // add a rule can decide who gets in.
    assertActorCan(actor, 'roles.manage', 'change the admin IP allowlist');

    const cidr = input.cidr.trim();
    if (!isValidRule(cidr)) {
      throw new ValidationError(
        `"${cidr}" is not a valid IPv4 address or CIDR range. Use 203.0.113.7 for a ` +
          'single machine or 203.0.113.0/24 for a network.',
      );
    }

    const label = input.label.trim();
    if (label === '') {
      throw new ValidationError(
        'Give the rule a label. A list of bare ranges is unmaintainable — nobody ' +
          'later knows which office an address belonged to, so nobody ever removes one.',
      );
    }

    const canonical = canonicaliseRule(cidr)!;

    /*
     * A `/0` is the one rule that makes this feature lie.
     *
     * It is valid and it canonicalises cleanly, so nothing else here objects —
     * but it admits every address, while the list becomes non-empty and both the
     * guard and the panel start reporting the protection as ENFORCED. An
     * operator reading a green "Enforced — 1 rule" shield would have a control
     * that is off and a UI that says it is on, which is worse than no control.
     *
     * Checked on the canonical form on purpose: `10.0.0.1/0` is a believable
     * slip for `/8` and canonicalises to `0.0.0.0/0`, so checking the input
     * string would miss it.
     */
    if (matchesEverything(canonical)) {
      throw new ValidationError(
        `Refusing: ${canonical} matches every address, so the allowlist would report ` +
          'itself as enforcing while admitting anyone. If you want this protection ' +
          'switched off, remove all the rules instead — that says so plainly.',
      );
    }

    const existing = await this.store.listCidrs();
    if (existing.includes(canonical)) {
      throw new ConflictError(`${canonical} is already on the allowlist.`);
    }

    /*
     * THE FIRST RULE IS THE DANGEROUS ONE. While the list is empty the feature
     * is off and everyone gets in; the moment this row lands, enforcement starts
     * and anyone outside it is refused — including, if they are careless, the
     * person adding it, who then cannot reach this endpoint to undo it.
     */
    if (existing.length === 0 && !ipMatchesAny(callerIp, [canonical])) {
      throw new ValidationError(
        `Refusing: this would be the first rule, so enforcement would begin immediately ` +
          `and your own address (${callerIp ?? 'unknown'}) is not inside ${canonical}. ` +
          'Add a rule covering yourself first, then add this one.',
      );
    }

    const rule = await this.store.create({ ...input, cidr: canonical, createdBy: actor.id });
    if (!rule) throw new ValidationError(`"${cidr}" could not be stored as a CIDR rule.`);

    this.audit.record(actor.id, 'ip_allowlist.add', 'ip_allowlist', rule.id, {
      cidr: canonical,
      label,
    });
    return rule;
  }

  async remove(id: string, actor: Admin, callerIp: string | undefined): Promise<void> {
    // Removing the last rule turns RBAC-08 OFF entirely (see the guard), so this
    // is at least as privileged as adding one.
    assertActorCan(actor, 'roles.manage', 'change the admin IP allowlist');

    const rules = await this.store.findAll();
    const target = rules.find((r) => r.id === id);
    if (!target) throw new NotFoundError('That allowlist rule does not exist.');

    /*
     * Removing the rule you are covered by is fine — as long as ANOTHER rule
     * still covers you, or the list is about to become empty (which turns the
     * feature off and lets everyone back in, including you).
     */
    const remaining = rules.filter((r) => r.id !== id).map((r) => r.cidr);
    if (remaining.length > 0 && !ipMatchesAny(callerIp, remaining)) {
      throw new ValidationError(
        `Refusing: removing ${target.cidr} would leave no rule covering your own ` +
          `address (${callerIp ?? 'unknown'}), and you would immediately lose access ` +
          'to this screen. Add a rule covering yourself first.',
      );
    }

    await this.store.delete(id);
    this.audit.record(actor.id, 'ip_allowlist.remove', 'ip_allowlist', id, {
      cidr: target.cidr,
      label: target.label,
      // Recorded because removing the last rule DISABLES the feature entirely,
      // which is a far bigger event than deleting one row.
      enforcementDisabled: remaining.length === 0,
    });
  }
}

import { Injectable } from '@nestjs/common';
import {
  AdminIpAllowlistStore,
  type AllowlistExemption,
  type AllowlistRule,
} from '../../store/admin-ip-allowlist.store';
import {
  canonicaliseRule,
  coversEverything,
  ipMatchesAny,
  isValidRule,
  matchesEverything,
} from '../../common/security/ip-range';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { AdminAuditService } from './admin-audit.service';
import { Admin, AdminsStore } from '../../store/admins.store';
import { assertActorCan } from '../../common/security/actor';
import { adminNetworkAdmits } from '../../common/security/admin-network';

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
    private readonly admins: AdminsStore,
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
    assertActorCan(actor, 'settings.security.edit', 'change the admin IP allowlist');

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
    // The same refusal as `/0`, for a /0 assembled out of pieces: the list
    // would report itself as enforcing while admitting every address.
    if (coversEverything([...existing, canonical])) {
      throw new ValidationError(
        `Refusing: together with the existing rules, ${canonical} would admit every ` +
          'address, so the allowlist would report itself as enforcing while admitting anyone. ' +
          'If you want this protection switched off, remove all the rules instead.',
      );
    }

    /*
     * THE FIRST RULE IS THE DANGEROUS ONE. While the list is empty the feature
     * is off and everyone gets in; the moment this row lands, enforcement starts
     * and anyone outside it is refused — including, if they are careless, the
     * person adding it, who then cannot reach this endpoint to undo it.
     */
    if (
      existing.length === 0 &&
      !ipMatchesAny(callerIp, [canonical]) &&
      // An exempt caller reaches the console from anywhere (0192), so this
      // rule cannot lock them out — the owner can set up the office from home.
      !(await this.store.isExempt(actor.id))
    ) {
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
    assertActorCan(actor, 'settings.security.edit', 'change the admin IP allowlist');

    /*
     * Removing the rule you are covered by is fine — as long as ANOTHER rule
     * still covers you, or the list is about to become empty (which turns the
     * feature off and lets everyone back in, including you).
     *
     * Decided and deleted in ONE transaction with the rows locked, in the
     * store. Read-then-delete here let two concurrent removals each see the
     * other's rule as "still covering you" and leave nobody covered.
     */
    const result = await this.store.removeUnlessLockedOut(
      id,
      callerIp,
      await this.store.isExempt(actor.id),
    );
    if (result.outcome === 'not-found') {
      throw new NotFoundError('That allowlist rule does not exist.');
    }
    if (result.outcome === 'would-lock-out') {
      throw new ValidationError(
        `Refusing: removing ${result.rule.cidr} would leave no rule covering your own ` +
          `address (${callerIp ?? 'unknown'}), and you would immediately lose access ` +
          'to this screen. Add a rule covering yourself first.',
      );
    }
    const target = result.rule;
    this.audit.record(actor.id, 'ip_allowlist.remove', 'ip_allowlist', id, {
      cidr: target.cidr,
      label: target.label,
      // Recorded because removing the last rule DISABLES the feature entirely,
      // which is a far bigger event than deleting one row.
      enforcementDisabled: result.remaining === 0,
    });
  }

  // ── Exemptions (0192): administrators who may connect from ANY network ─────

  listExemptions(): Promise<AllowlistExemption[]> {
    return this.store.listExemptions();
  }

  isExempt(adminId: string): Promise<boolean> {
    return this.store.isExempt(adminId);
  }

  /**
   * Let one administrator reach the console from any network. It skips the
   * network check for their SESSIONS and nothing else — permissions, client
   * scope and masks are untouched, and API keys are never exempt.
   *
   * As privileged as adding a rule (`settings.security.edit`): both decide who
   * may reach the console from where.
   */
  async grantExemption(input: { adminId: string; reason: string }, actor: Admin): Promise<void> {
    assertActorCan(actor, 'settings.security.edit', 'change the admin IP allowlist');

    const reason = input.reason.trim();
    if (reason === '') {
      throw new ValidationError(
        'Give the exemption a reason. One nobody remembers granting is one nobody removes.',
      );
    }
    const target = await this.admins.findById(input.adminId);
    if (!target) throw new NotFoundError('That administrator does not exist.');
    if (target.status === 'suspended') {
      throw new ValidationError('That administrator is suspended. Reactivate them first.');
    }
    const added = await this.store.addExemption({
      adminId: target.id,
      reason,
      createdBy: actor.id,
    });
    if (!added) throw new ConflictError(`${target.email} can already connect from any network.`);

    this.audit.record(actor.id, 'ip_allowlist.exempt_add', 'admin', target.id, {
      email: target.email,
      reason,
    });
  }

  /**
   * Withdraw an exemption — effective on that administrator's next request.
   *
   * Your OWN, from an address the list does not admit, is refused: the next
   * request would be refused and this screen gone, the same lockout the rule
   * removal refuses.
   */
  async revokeExemption(adminId: string, actor: Admin, callerIp: string | undefined) {
    assertActorCan(actor, 'settings.security.edit', 'change the admin IP allowlist');

    if (adminId === actor.id && !adminNetworkAdmits(await this.store.listCidrs(), callerIp)) {
      throw new ValidationError(
        `Refusing: your own address (${callerIp ?? 'unknown'}) is not on the allowlist, so ` +
          'removing your exemption would immediately lose you access to this screen. ' +
          'Add a rule covering yourself first.',
      );
    }
    const target = await this.admins.findById(adminId);
    const removed = await this.store.removeExemption(adminId);
    if (!removed) throw new NotFoundError('That administrator is not exempt.');

    this.audit.record(actor.id, 'ip_allowlist.exempt_remove', 'admin', adminId, {
      email: target?.email ?? null,
      reason: removed.reason,
    });
  }
}

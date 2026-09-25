import { Injectable } from '@nestjs/common';
import { NotFoundError, ValidationError } from '../../common/errors/domain-errors';
import { ProductsStore, type AgencyRow, type ProductRow } from '../../store/products.store';
import { AdminAuditService } from '../admin/admin-audit.service';
import { Mt5AccountsService } from '../trading/mt5/mt5-accounts.service';
import { Mt5GroupSyncService } from '../trading/mt5/mt5-group-sync.service';
import type { Actor } from '../../common/security/actor';
import type { AgencyDto, ProductDto, PublicAgencyDto } from './dto/catalogue.dto';

/**
 * The catalogue: products, the MT5 groups behind them, and the agencies (وكالة)
 * that sell them.
 *
 * ## Every write is audited, because every write is commercial
 *
 * Attaching a group to a product decides what a client's account is opened in;
 * putting a product on an agency decides what a whole partner's book may sell.
 * Neither leaves a trace anywhere else — the account rows that result look
 * ordinary — so this log is the only place the decision is recorded.
 */
@Injectable()
export class CatalogueService {
  constructor(
    private readonly store: ProductsStore,
    private readonly audit: AdminAuditService,
    private readonly mt5: Mt5AccountsService,
    /*
     * The MIRROR, used only by `availableGroups` and only to answer when the
     * bridge cannot. `attachGroup` below deliberately still goes to `mt5`
     * directly — see its own note on why a permanent decision is not made
     * against a cache.
     */
    private readonly groupSync: Mt5GroupSyncService,
  ) {}

  /* ── Products ─────────────────────────────────────────────────────────── */

  async listProducts(): Promise<ProductDto[]> {
    return (await this.store.listProducts()).map(toProductDto);
  }

  async createProduct(
    input: {
      name: string;
      description?: string | null;
      enabled: boolean;
      type?: 'real' | 'demo';
      commissionTypeId?: string | null;
      sortOrder?: number;
    },
    actor: Actor,
  ): Promise<ProductDto> {
    const type = input.type ?? 'real';
    const commissionTypeId = await this.resolveCommissionType(type, input.commissionTypeId ?? null);

    /*
     * At most one demo product. This check is the readable sentence; the
     * partial unique index `trading_products_single_demo_uq` is the guarantee
     * a concurrent create cannot slip past, hence the catch below translating
     * the constraint into the same message.
     */
    if (type === 'demo') {
      const existing = (await this.store.listProducts()).find((product) => product.type === 'demo');
      if (existing) throw singleDemoError(existing.name);
    }

    const row = await this.store
      .createProduct({
        name: input.name.trim(),
        description: emptyToNull(input.description),
        enabled: input.enabled,
        type,
        commissionTypeId,
        sortOrder: input.sortOrder,
      })
      .catch((error: unknown) => {
        if (violatesSingleDemo(error)) throw singleDemoError();
        throw error;
      });

    this.audit.record(actor.id, 'product.create', 'trading_products', row.id, {
      name: row.name,
      enabled: row.enabled,
      type: row.type,
      commissionTypeId: row.commissionTypeId,
    });
    return toProductDto(row);
  }

  /**
   * Which rate card a product may be put on.
   *
   * The DEMO product never carries one: demo trades never accrue, so a type on
   * it is a number that looks configured and pays nobody — refused rather than
   * stored. A type that does not exist is refused with its id, because the
   * alternative is the foreign key answering with a 500.
   */
  private async resolveCommissionType(
    type: 'real' | 'demo',
    commissionTypeId: string | null,
  ): Promise<string | null> {
    if (commissionTypeId === null) return null;
    if (type === 'demo') {
      throw new ValidationError(
        'The demo product cannot carry a commission type: practice trades never pay partner ' +
          'commission, so the type would look configured and pay nobody.',
      );
    }
    const found = await this.store.findCommissionType(commissionTypeId);
    if (!found) throw new NotFoundError('Commission type not found.');
    return found.id;
  }

  async updateProduct(
    id: string,
    input: {
      name: string;
      description?: string | null;
      enabled: boolean;
      type?: 'real' | 'demo';
      commissionTypeId?: string | null;
      sortOrder?: number;
    },
    actor: Actor,
  ): Promise<ProductDto> {
    const before = (await this.store.listProducts()).find((product) => product.id === id);
    if (!before) throw new NotFoundError('Product not found.');

    /*
     * OMITTED means UNCHANGED, and an explicit null CLEARS it.
     *
     * This is a PUT, so a client that does not know about this field would
     * otherwise silently strip a product's terms every time somebody renamed
     * it — and the audit row would faithfully record a change nobody made.
     */
    const commissionTypeId =
      input.commissionTypeId === undefined
        ? before.commissionTypeId
        : await this.resolveCommissionType(before.type, input.commissionTypeId);

    /*
     * The type is FIXED at creation. real→demo would strand the agency links
     * this product carries and contradict its live groups; demo→real would
     * silently withdraw the demo offering from every client at once. Both are
     * "create the product you mean" operations, not edits.
     */
    if (input.type !== undefined && input.type !== before.type) {
      throw new ValidationError(
        "A product's type is fixed when it is created. To change what is offered as " +
          'demo, create the product you want and move the groups instead.',
      );
    }

    const row = await this.store.updateProduct(id, {
      name: input.name.trim(),
      description: emptyToNull(input.description),
      enabled: input.enabled,
      commissionTypeId,
      sortOrder: input.sortOrder,
    });
    if (!row) throw new NotFoundError('Product not found.');

    /*
     * Disabling is called out separately from the field diff.
     *
     * It is the only edit here that changes what clients can do TODAY — the
     * product stops being offered the moment it saves — and an auditor scanning
     * for "when did Standard stop being sold" should not have to read a diff to
     * find it.
     */
    /*
     * `defaultProgramId` IS GONE (0112) and is not audited because it no longer
     * exists. An agency named the commission programme its partners were
     * appointed on; terms come from a partner's RUNG now, derived from who
     * recruited them, so an agency has no opinion about what anybody is paid.
     * It still bounds what they may SELL, through `agency_products`.
     */
    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of [
      'name',
      'description',
      'enabled',
      /*
       * In the diff because changing it changes what every partner is paid on
       * this product from the next trade on — the same reason `ib.level_change`
       * records both rungs. The record of who set it and when is the part that
       * cannot be reconstructed later.
       */
      'commissionTypeId',
      'sortOrder',
    ] as const) {
      if (before[field] !== row[field])
        changed[field] = { before: before[field], after: row[field] };
    }

    this.audit.record(actor.id, 'product.update', 'trading_products', id, {
      changed,
      withdrawn: before.enabled && !row.enabled,
    });
    return toProductDto(row);
  }

  async deleteProduct(id: string, actor: Actor): Promise<void> {
    const before = (await this.store.listProducts()).find((product) => product.id === id);
    if (!before) throw new NotFoundError('Product not found.');

    /*
     * The database would refuse this anyway — `agency_products.product_id` is
     * ON DELETE RESTRICT — but a foreign-key violation reaches the operator as
     * a 500 with a constraint name in it. Naming the agencies is the difference
     * between "something went wrong" and "remove it from Gold Agency first".
     */
    const agencies = await this.store.listAgencies();
    const selling = agencies.filter((agency) => agency.productIds.includes(id));
    if (selling.length > 0) {
      throw new ValidationError(
        `This product is sold by ${selling.map((agency) => agency.name).join(', ')}. ` +
          'Remove it from those agencies first, or disable it instead — disabling stops it being ' +
          'sold and leaves open accounts alone.',
      );
    }

    const deleted = await this.store.deleteProduct(id);
    if (!deleted) throw new NotFoundError('Product not found.');

    this.audit.record(actor.id, 'product.delete', 'trading_products', id, {
      name: before.name,
      // The groups go with it via cascade, and this is where they are readable
      // afterwards — the rows themselves are gone.
      groups: before.groups.map((group) => `${group.environment}:${group.mt5Group}`),
    });
  }

  /* ── A product's MT5 groups ───────────────────────────────────────────── */

  /**
   * What the operator picks from: every group the server reports, flagged with
   * whether a product already claims it.
   *
   * Claimed groups are RETURNED, not filtered out. "This group is not offered
   * by the broker" and "this group already belongs to ECN" are different
   * problems with different fixes, and a list that silently omits the second
   * makes an operator hunt for a group they can see in the manager terminal.
   */
  async availableGroups() {
    /*
     * `offerable()` rather than a bare live read, and the difference shows up
     * only when MT5 is unreachable: this screen used to answer with an error
     * page, and now answers with the last synced catalogue and the date it was
     * confirmed. An operator can act on a list marked stale; they cannot act on
     * a failure.
     */
    const [offer, claimed] = await Promise.all([
      this.groupSync.offerable(),
      this.store.claimedGroups(),
    ]);
    const taken = new Set(claimed.map((group) => group.toLowerCase()));

    return offer.groups.map((group) => ({
      name: group.name,
      currency: group.currency,
      claimed: taken.has(group.name.toLowerCase()),
      /*
       * NULL when the list came straight from the server, which is the normal
       * case. A date means "this is what the group looked like then" — the one
       * fact a stale list must carry, because a picker that cannot say how old
       * it is reads exactly like a current one.
       */
      lastSeenAt: group.lastSeenAt?.toISOString() ?? null,
    }));
  }

  async attachGroup(
    productId: string,
    input: { environment: 'live' | 'demo'; mt5Group: string },
    actor: Actor,
  ): Promise<ProductDto> {
    const products = await this.store.listProducts();
    const product = products.find((candidate) => candidate.id === productId);
    if (!product) throw new NotFoundError('Product not found.');

    /*
     * The group's environment must match the product's type. A demo group on a
     * real product would never be offered to anybody (demo resolution reads
     * only the demo product), and a live group on the demo product would sell
     * real accounts through a programme no agency carries. Both are dead
     * weight that reads as configured.
     */
    if (product.type === 'demo' && input.environment !== 'demo') {
      throw new ValidationError(
        `'${product.name}' is the demo product — it takes demo groups only. ` +
          'Attach live groups to a real product instead.',
      );
    }
    if (product.type === 'real' && input.environment !== 'live') {
      throw new ValidationError(
        `'${product.name}' is a real product — it takes live groups only. ` +
          'Demo groups belong on the demo product, which is offered to every client.',
      );
    }

    /*
     * ── The group must EXIST on the server, and we ask ───────────────────────
     *
     * This is the check the whole screen is for. A mistyped path is stored
     * happily by Postgres and fails at the client's first account open, with an
     * MT5 return code that names neither the field nor the reason. Asking the
     * bridge costs one round trip on an action performed a handful of times a
     * year.
     *
     * The CURRENCY comes back from the same call, which is why this is not just
     * a validation: it is where the cached currency is filled in, from the
     * server rather than from a form field somebody could get wrong.
     */
    const onServer = await this.mt5.listGroupsForClients();
    const match = onServer.find(
      (group) => group.name.toLowerCase() === input.mt5Group.trim().toLowerCase(),
    );
    if (!match) {
      throw new ValidationError(
        `MT5 does not report a group called "${input.mt5Group.trim()}". Choose one from the list — ` +
          'if the group is new, the broker may not have granted this manager account access to it.',
      );
    }

    /*
     * A group may back SEVERAL products since 0142 — "which product is this
     * account under" is answered by the product chosen at account open, not by
     * the group. What is still refused is the same group on the same product
     * twice, which would be one offer listed as two.
     */
    if (product.groups.some((group) => group.mt5Group.toLowerCase() === match.name.toLowerCase())) {
      throw new ValidationError(`"${match.name}" is already attached to '${product.name}'.`);
    }

    // The server's spelling, never the caller's: a casing difference must not
    // reach MT5, and this is the last place both are in hand.
    await this.store.addGroup({
      productId,
      environment: input.environment,
      mt5Group: match.name,
      currency: match.currency,
    });

    this.audit.record(actor.id, 'product.group_attach', 'trading_products', productId, {
      product: product.name,
      environment: input.environment,
      mt5Group: match.name,
      currency: match.currency,
    });

    const groups = await this.store.groupsOf(productId);
    return toProductDto({ ...product, groups });
  }

  async detachGroup(productId: string, groupId: string, actor: Actor): Promise<ProductDto> {
    const products = await this.store.listProducts();
    const product = products.find((candidate) => candidate.id === productId);
    if (!product) throw new NotFoundError('Product not found.');

    const group = product.groups.find((candidate) => candidate.id === groupId);
    if (!group) throw new NotFoundError('That group is not attached to this product.');

    const removed = await this.store.removeGroup(productId, groupId);
    if (!removed) throw new NotFoundError('That group is not attached to this product.');

    /*
     * Detaching does NOT touch the accounts already in that group. They keep
     * trading, and they keep the group recorded on `trading_accounts.mt5_group`
     * — the catalogue says what may be SOLD, not what exists. Recorded here
     * because that distinction is exactly what somebody will query later.
     */
    this.audit.record(actor.id, 'product.group_detach', 'trading_products', productId, {
      product: product.name,
      environment: group.environment,
      mt5Group: group.mt5Group,
    });

    return toProductDto({ ...product, groups: await this.store.groupsOf(productId) });
  }

  /* ── Agencies ─────────────────────────────────────────────────────────── */

  async listAgencies(): Promise<AgencyDto[]> {
    return (await this.store.listAgencies()).map(toAgencyDto);
  }

  /**
   * The agencies an applicant may choose from, with product NAMES spelled out.
   *
   * Disabled agencies are absent: an applicant should not be able to apply to a
   * programme that is closed, and showing it greyed out invites the question
   * "when does it reopen", which nobody here can answer.
   */
  async listOpenAgencies(): Promise<PublicAgencyDto[]> {
    const [agencies, products] = await Promise.all([
      this.store.listAgencies(),
      this.store.listProducts(),
    ]);
    const nameOf = new Map(products.map((product) => [product.id, product.name]));

    return agencies
      .filter((agency) => agency.enabled)
      .map((agency) => ({
        id: agency.id,
        name: agency.name,
        description: agency.description,
        products: agency.productIds
          .map((id) => nameOf.get(id))
          .filter((name): name is string => Boolean(name)),
      }));
  }

  async createAgency(
    input: {
      name: string;
      description?: string | null;
      enabled: boolean;
      sortOrder?: number;
    },
    actor: Actor,
  ): Promise<AgencyDto> {
    const row = await this.store.createAgency({
      name: input.name.trim(),
      description: emptyToNull(input.description),
      enabled: input.enabled,
      sortOrder: input.sortOrder,
    });

    this.audit.record(actor.id, 'agency.create', 'agencies', row.id, {
      name: row.name,
      enabled: row.enabled,
    });
    return toAgencyDto(row);
  }

  async updateAgency(
    id: string,
    input: {
      name: string;
      description?: string | null;
      enabled: boolean;
      sortOrder?: number;
    },
    actor: Actor,
  ): Promise<AgencyDto> {
    const before = (await this.store.listAgencies()).find((agency) => agency.id === id);
    if (!before) throw new NotFoundError('Agency not found.');

    const row = await this.store.updateAgency(id, {
      name: input.name.trim(),
      description: emptyToNull(input.description),
      enabled: input.enabled,
      sortOrder: input.sortOrder,
      /*
       * OMITTED keeps what is stored; an explicit `null` CLEARS it.
       *
       * Without that distinction there is no way to unset a default once one
       * has been chosen — every subsequent save would re-assert it, and the
       * only route back would be SQL.
       */
    });
    if (!row) throw new NotFoundError('Agency not found.');

    const changed: Record<string, { before: unknown; after: unknown }> = {};
    for (const field of ['name', 'description', 'enabled', 'sortOrder'] as const) {
      if (before[field] !== row[field])
        changed[field] = { before: before[field], after: row[field] };
    }

    this.audit.record(actor.id, 'agency.update', 'agencies', id, { changed });
    return toAgencyDto(row);
  }

  async deleteAgency(id: string, actor: Actor): Promise<void> {
    const before = (await this.store.listAgencies()).find((agency) => agency.id === id);
    if (!before) throw new NotFoundError('Agency not found.');

    /*
     * `ib_accounts.agency_id` is ON DELETE RESTRICT, so Postgres refuses this
     * once a partner is appointed under it. Same reasoning as the product
     * check: the constraint is the guarantee, this is the sentence.
     */
    const deleted = await this.store.deleteAgency(id).catch(() => {
      throw new ValidationError(
        'Partners are appointed under this agency. Move them to another one first, or disable ' +
          'it — disabling stops new applications and leaves the partners in place.',
      );
    });
    if (!deleted) throw new NotFoundError('Agency not found.');

    this.audit.record(actor.id, 'agency.delete', 'agencies', id, { name: before.name });
  }

  async setAgencyProducts(id: string, productIds: string[], actor: Actor): Promise<AgencyDto> {
    const agencies = await this.store.listAgencies();
    const before = agencies.find((agency) => agency.id === id);
    if (!before) throw new NotFoundError('Agency not found.');

    const products = await this.store.listProducts();
    const known = new Set(products.map((product) => product.id));
    const unknown = productIds.filter((productId) => !known.has(productId));
    if (unknown.length > 0) {
      throw new ValidationError('One of those products does not exist. Reload and try again.');
    }

    const demoIds = new Set(
      products.filter((product) => product.type === 'demo').map((product) => product.id),
    );
    if (productIds.some((productId) => demoIds.has(productId))) {
      throw new ValidationError(
        'The demo product is offered to every client automatically — agencies carry ' +
          'real products only.',
      );
    }

    // De-duplicated: the join table's composite key would reject a repeat with
    // a constraint error, and a repeated checkbox is a client bug, not an
    // operator's intent.
    const unique = [...new Set(productIds)];
    await this.store.setAgencyProducts(id, unique);

    /*
     * Recorded as BEFORE and AFTER name lists, not ids.
     *
     * This is the single most consequential write in the module — it changes
     * what every client under every partner on this agency may open — and a
     * row of uuids is unreadable to whoever comes looking a year later.
     */
    const nameOf = new Map(products.map((product) => [product.id, product.name]));
    this.audit.record(actor.id, 'agency.products_set', 'agencies', id, {
      agency: before.name,
      before: before.productIds.map((productId) => nameOf.get(productId) ?? productId),
      after: unique.map((productId) => nameOf.get(productId) ?? productId),
    });

    return toAgencyDto({ ...before, productIds: unique });
  }
}

function toProductDto(row: ProductRow): ProductDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    type: row.type,
    commissionTypeId: row.commissionTypeId,
    sortOrder: row.sortOrder,
    groups: row.groups,
  };
}

function singleDemoError(existingName?: string): ValidationError {
  const carrier = existingName ? `'${existingName}' is it` : 'one already exists';
  return new ValidationError(
    `Only one demo product can exist — ${carrier}. It is offered to every client ` +
      'automatically, so edit that product instead of creating another.',
  );
}

/**
 * Did this insert hit `trading_products_single_demo_uq`? drizzle-orm wraps the
 * driver error and moves the original to `cause` (see `pgErrorCode` in
 * AllExceptionsFilter for the history), so the constraint name is found by
 * walking the chain rather than read off the top.
 */
function violatesSingleDemo(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    const constraint = (current as { constraint?: unknown }).constraint;
    if (constraint === 'trading_products_single_demo_uq') return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

function toAgencyDto(row: AgencyRow): AgencyDto {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    productIds: row.productIds,
  };
}

/** A blank description is "not set", not a description that is empty. */
function emptyToNull(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

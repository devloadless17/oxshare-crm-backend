import { Injectable } from '@nestjs/common';
import { UsersStore } from '../../store/users.store';
import { ClientNotFoundError, type DomainError } from '../errors/domain-errors';
import type { ClientScope } from './client-scope';

/**
 * The by-id gate: "may this administrator act on this client at all?"
 *
 * Every admin route that names a client in its PATH goes through here — KYC
 * decisions, withdrawal transitions, tag assignment, the client profile. Those
 * act on a row reached FROM the client (a submission, a transaction) rather
 * than on the client row itself, so the WHERE-clause predicate that protects
 * the list endpoints has nowhere natural to live. The visibility question is
 * asked first instead, with one scoped lookup.
 *
 * ONE SERVICE RATHER THAN FOUR COPIES of the same four lines. The 404-not-403
 * rule and the unrestricted short-circuit are both easy to get subtly wrong,
 * and a copy that returns 403 in one service is a client-enumeration oracle
 * nobody would notice in review because the other three look right.
 *
 * ── Why NotFound and never Forbidden ────────────────────────────────────────
 *
 * A 403 confirms that the id names a real client. A scoped administrator could
 * then enumerate the client base they were specifically denied by trying uuids
 * and reading status codes. 404 gives the same answer for "no such client" and
 * "not in your territory", which is the only answer that leaks nothing — and it
 * is the same wording the route already uses for a genuinely missing client, so
 * nothing about the response distinguishes them.
 *
 * ── The race, stated rather than hidden ─────────────────────────────────────
 *
 * A client's tags can change between this check and the write that follows. The
 * consequence is one administrator acting on a client who left their territory
 * a moment earlier; it needs a concurrent tag edit to reach, and it is not a
 * disclosure. Closing it would mean threading the predicate into every
 * transition's UPDATE ... WHERE, which is worth doing if tag churn ever becomes
 * routine. The LIST endpoints have no such gap: their predicate is in the query.
 */
@Injectable()
export class ClientVisibilityService {
  constructor(private readonly users: UsersStore) {}

  /**
   * Throws `NotFoundError` unless this actor may see the client.
   *
   * Call it FIRST, before reading anything else. Loading the submission or the
   * transaction beforehand is how an out-of-scope client's details reach a log
   * line or an error message on the way to being refused.
   */
  /**
   * `notFound` is what a missing RECORD answers on the caller's route — pass it
   * whenever the route names a record rather than the client (a withdrawal, a
   * wallet, an accrual). An out-of-territory record must be indistinguishable
   * from a missing one: same status, same `code`, same message. The default
   * suits a route that names the client itself.
   */
  async assertVisible(
    clientId: number,
    scope: ClientScope,
    notFound: () => DomainError = () => new ClientNotFoundError(),
  ): Promise<void> {
    // A master admin, or an admin with no territory, sees everyone — so there
    // is nothing to look up and no query to pay for on the common path.
    if (scope.unrestricted) return;

    const client = await this.users.findForAdmin(clientId, scope);
    if (!client) throw notFound();
  }
}

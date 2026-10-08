import { randomUUID } from 'crypto';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { REGISTRATION_REQUIRED } from '../../common/kyc/identity-core';
import {
  checkProfile,
  firstProfileError,
  offeredProblems,
  type ProfileKey,
} from '../../common/profile/client-profile';
import {
  WALLET_PROVISIONING,
  type WalletProvisioningPort,
} from '../../common/provisioning/wallet-provisioning.port';
import { ResourceChangedPublisher } from '../../common/realtime/resource-changed';
import {
  EmailAlreadyRegisteredError,
  FieldValidationError,
  PhoneAlreadyRegisteredError,
} from '../../common/errors/domain-errors';
import { violatesConstraint } from '../../common/errors/pg-violation';
import { hashEmailedToken } from '../../common/security/emailed-token';
import { WELCOME_LINK_DAYS } from '../email/templates';
import { OfferedCountriesStore } from '../../store/offered-countries.store';
import { UsersStore, type User } from '../../store/users.store';
import type { Executor } from '../../database/db';

/** What the sign-up form — and staff's New client form — shows under the email for a taken address. */
const EMAIL_TAKEN =
  'This email already has an OxShare account. Reset your password or sign in instead.';

export function emailAlreadyRegistered(): EmailAlreadyRegisteredError {
  return new EmailAlreadyRegisteredError(EMAIL_TAKEN, { email: EMAIL_TAKEN });
}

export function phoneAlreadyRegistered(): PhoneAlreadyRegisteredError {
  return new PhoneAlreadyRegisteredError();
}

/**
 * A WELCOME link for a client staff created (0211): the password-reset token,
 * with a life of `WELCOME_LINK_DAYS` rather than a reset's 30 minutes — an
 * elderly client may open their email days later. Completing it is the reset
 * itself: it sets their password, confirms the address and stamps
 * `password_set_at`. `token` goes in the email and nowhere else; `patch` is
 * what the row stores (its hash, never the token).
 */
export function welcomeLink(now: number = Date.now()): {
  token: string;
  patch: { passwordResetTokenHash: string; passwordResetExpiry: Date };
} {
  const token = randomUUID();
  return {
    token,
    patch: {
      passwordResetTokenHash: hashEmailedToken(token),
      passwordResetExpiry: new Date(now + WELCOME_LINK_DAYS * 24 * 60 * 60 * 1000),
    },
  };
}

/** The details a new client is created with: a sign-up's, or what staff typed for them. */
export type NewClientDetails = { email: string } & Partial<Record<ProfileKey, string>>;

/**
 * ONE WAY A CLIENT COMES TO EXIST (0211, 8 Oct 2026).
 *
 * A client signs up themselves (`AuthService.register`), or staff create one
 * for somebody who cannot ("New client", `AdminClientCreateService`). Both pass
 * the SAME checks and get the SAME things here, so a staff-made client is
 * identical to a self-made one: what differs is only how they arrive (a
 * password they typed or a welcome link; a sign-up link's tags or the creating
 * administrator's) and what the record says about it.
 *
 * Deliberately not only a DI provider: `AuthService` builds one from the
 * dependencies it already holds, so the many tests that construct it
 * positionally keep working unchanged.
 */
@Injectable()
export class ClientCreation {
  constructor(
    private readonly users: UsersStore,
    /* The countries the broker offers (0178) — the same list KYC and the desk use. */
    @Optional() private readonly offered?: OfferedCountriesStore,
    /* Opens a wallet in every enabled currency. A port: see `AuthService`'s note. */
    @Optional()
    @Inject(WALLET_PROVISIONING)
    private readonly walletProvisioning?: WalletProvisioningPort,
    /* Refreshes every admin's client list — data only, never a bell. */
    @Optional() private readonly resourceChanged?: ResourceChangedPublisher,
  ) {}

  /**
   * The checks every new client passes, in this order: the ADDRESS (when it is
   * taken that is the whole answer — its holder signs in or resets), then the
   * profile by the rules every later writer obeys with the sign-up tier
   * REQUIRED (names, date of birth, nationality, phone, residence), the
   * countries the broker offers, and one client per phone (0194).
   *
   * Every refusal is under the field it is about. Returns the profile values to
   * store — a blank optional field is simply not stored.
   */
  async check(details: NewClientDetails): Promise<Partial<Record<ProfileKey, string>>> {
    if (await this.users.findByEmail(details.email)) throw emailAlreadyRegistered();

    const { email: _address, ...fields } = details;
    const given = Object.fromEntries(
      Object.entries(fields).filter(([, value]) => value !== undefined),
    ) as Partial<Record<ProfileKey, string>>;
    const profile = checkProfile(given, { required: REGISTRATION_REQUIRED });
    const offeredErrors = this.offered
      ? offeredProblems(profile.values, await this.offered.get())
      : {};
    const errors = { ...offeredErrors, ...profile.errors };
    const problem = firstProfileError(errors);
    if (problem) throw new FieldValidationError(problem, errors);

    if (profile.values.phone && (await this.users.findIdByPhone(profile.values.phone))) {
      throw phoneAlreadyRegistered();
    }
    return Object.fromEntries(Object.entries(profile.values).filter(([, value]) => value !== null));
  }

  /**
   * The insert. Two creations for one NEW address or phone at the same moment:
   * the unique index decides, and the loser gets the same plain answer as a
   * taken one — never a 500.
   */
  insert(values: Parameters<UsersStore['create']>[0], executor?: Executor): Promise<User> {
    return this.users.create(values, executor).catch((error: unknown) => {
      if (violatesConstraint(error, 'users_email_unique')) throw emailAlreadyRegistered();
      if (violatesConstraint(error, 'users_phone_unique')) throw phoneAlreadyRegistered();
      throw error;
    });
  }

  /**
   * What every new client gets once they exist: a wallet in every enabled
   * currency (awaited, so their first sign-in finds them; it never throws), and
   * admin client lists that show them. Their COUNTRY tag needs no write: it is
   * derived from the country they gave (0193).
   */
  async settle(userId: number): Promise<void> {
    await this.walletProvisioning?.openAllEnabledWallets(userId);
    void this.resourceChanged?.publish({ resource: 'clients' });
  }
}

import { Global, Module } from '@nestjs/common';
import { AdminIpAllowlistStore } from './admin-ip-allowlist.store';
import { AdminsStore, InvitesStore } from './admins.store';
import { AuditLogStore } from './audit-log.store';
import { KycConfigStore } from './kyc-config.store';
import { KycStore } from './kyc.store';
import { RejectionReasonsStore } from './rejection-reasons.store';
import { RolesStore } from './roles.store';
import { UsersStore } from './users.store';

const STORES = [
  AdminIpAllowlistStore,
  AdminsStore,
  InvitesStore,
  AuditLogStore,
  KycConfigStore,
  KycStore,
  RejectionReasonsStore,
  RolesStore,
  UsersStore,
];

/**
 * The repositories, as injectable classes taking the db by constructor.
 *
 * They used to be `const` object literals reaching for a module-level getDb()
 * singleton. That made every service that touched one impossible to unit test:
 * there was no seam to substitute a fake through, which is the direct reason
 * the 726-line AdminService had zero tests and shipped a missing `await` on its
 * privilege-escalation guard.
 *
 * Global, because a repository layer is infrastructure — the alternative is
 * re-importing the same module in seven places.
 */
@Global()
@Module({
  providers: STORES,
  exports: STORES,
})
export class StoreModule {}

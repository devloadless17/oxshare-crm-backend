import { Global, Module } from '@nestjs/common';
import { AdminClientScopesStore } from './admin-client-scopes.store';
import { ApiKeysStore } from './api-keys.store';
import { AppSettingsStore } from './app-settings.store';
import { ClientTagsStore } from './client-tags.store';
import { AdminsStore, InvitesStore } from './admins.store';
import { AuditLogStore } from './audit-log.store';
import { IbStore } from './ib.store';
import { KycConfigStore } from './kyc-config.store';
import { KycStore } from './kyc.store';
import { RejectionReasonsStore } from './rejection-reasons.store';
import { RolesStore } from './roles.store';
import { SecuritySettingsStore } from './security-settings.store';
import { StatsStore } from './stats.store';
import { UsersStore } from './users.store';
import { ClientVisibilityService } from '../common/security/client-visibility.service';

const STORES = [
  AdminClientScopesStore,
  AdminsStore,
  ApiKeysStore,
  AppSettingsStore,
  ClientTagsStore,
  InvitesStore,
  AuditLogStore,
  IbStore,
  KycConfigStore,
  KycStore,
  RejectionReasonsStore,
  RolesStore,
  SecuritySettingsStore,
  StatsStore,
  UsersStore,
  /*
   * Not a store, but it belongs in this @Global() module for the same reason
   * the stores do: it is a thin scope-aware wrapper over UsersStore that FOUR
   * modules need (admin clients, tags, compliance, money), and giving each of
   * them its own copy is how the 404-not-403 rule ends up implemented four
   * slightly different ways.
   */
  ClientVisibilityService,
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

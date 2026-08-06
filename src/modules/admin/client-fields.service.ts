import { Injectable } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { ValidationError } from '../../common/errors/domain-errors';
import type { FieldMask } from '../../common/security/field-mask';

export interface ClientFieldDefinition {
  key: string;
  label: string;
  maskable: boolean;
  /** Why a field cannot be masked, shown to whoever wonders where it went. */
  reason?: string;
  /**
   * The same value under other names, on other DTOs.
   *
   * Masking `client.phone` must also strip `personalInfo.phone` from the KYC
   * review screen, or the feature has a bypass that consists of clicking a
   * different tab.
   */
  aliases?: string[];
}

export interface ClientFieldGroup {
  groupName: string;
  description: string;
  fields: ClientFieldDefinition[];
}

export type ClientFieldCatalog = Record<string, ClientFieldGroup>;

/**
 * RBAC-03's vocabulary: which client fields exist, and which of them a role may
 * hide.
 *
 * The exact counterpart of `AdminRbacService.getPermissionsCatalog`, on purpose
 * — same file-on-disk shape, same read-once caching, same "the frontend never
 * invents a key" contract (R-4.5). A mask key with no backend counterpart is
 * not cosmetic: it is a field an operator believes they hid.
 */
@Injectable()
export class ClientFieldsService {
  /**
   * Read once. The file is a build artefact that cannot change while the
   * process runs, and `expand()` is called on EVERY authenticated admin
   * request — blocking file IO on the event loop per request is what the
   * permission catalog's own comment records learning the hard way.
   *
   * Resolved lazily rather than in the constructor because `__dirname` vs
   * `cwd` differs between `nest start` and a compiled `dist` run, and both are
   * only settled by first use.
   */
  private static catalog: ClientFieldCatalog | null = null;
  private static aliasIndex: Map<string, string[]> | null = null;

  getCatalog(): ClientFieldCatalog {
    if (!ClientFieldsService.catalog) {
      const file = path.join(__dirname, '../../config/client-fields.json');
      const fallback = path.join(process.cwd(), 'src/config/client-fields.json');
      const raw = fs.readFileSync(fs.existsSync(file) ? file : fallback, 'utf-8');
      const parsed = JSON.parse(raw) as ClientFieldCatalog & { $comment?: unknown };
      // `$comment` carries the reasoning for whoever edits the file; it is not a
      // group and must not appear as one in the API or in the maskable set.
      delete parsed.$comment;
      ClientFieldsService.catalog = parsed;
    }
    return ClientFieldsService.catalog;
  }

  /** Every field, flattened — the shape the admin UI renders. */
  definitions(): ClientFieldDefinition[] {
    return Object.values(this.getCatalog()).flatMap((group) => group.fields);
  }

  /** The keys a role or admin may actually be given. */
  maskableKeys(): Set<string> {
    return new Set(
      this.definitions()
        .filter((f) => f.maskable)
        .map((f) => f.key),
    );
  }

  /**
   * Validates a mask an administrator is trying to store.
   *
   * Two distinct failures, and they get distinct messages because they call for
   * different fixes: an unknown key is a typo or a stale frontend, while a
   * known-but-unmaskable key is someone trying to hide a column the screens
   * structurally need — the catalog says why, and the message repeats it.
   */
  assertMaskable(keys: readonly string[]): void {
    const all = new Map(this.definitions().map((f) => [f.key, f]));

    for (const key of keys) {
      const field = all.get(key);
      if (!field) {
        throw new ValidationError(
          `"${key}" is not a client field. Choose from the catalog served by ` +
            'GET /admin/client-fields.',
        );
      }
      if (!field.maskable) {
        throw new ValidationError(
          `"${field.label}" cannot be hidden${field.reason ? `: ${field.reason}` : '.'}`,
        );
      }
    }
  }

  /**
   * A stored mask, expanded with every alias — the form the enforcement layer
   * uses.
   *
   * THIS IS WHAT CLOSES THE KYC BYPASS. An operator hides `client.phone` on the
   * client list; without expansion the same number is still sitting on
   * `GET /admin/kyc/:userId` under `personalInfo.phone`, one tab away, and the
   * feature is decorative. Expansion happens here, once, rather than at each
   * of the surfaces that would each have to remember.
   *
   * Unknown keys are dropped rather than thrown on. This runs on every
   * authenticated request; a key removed from the catalog while still stored on
   * a role must degrade to "not masked any more", not to "this administrator
   * cannot log in".
   */
  expand(stored: readonly string[]): FieldMask {
    if (stored.length === 0) return [];

    if (!ClientFieldsService.aliasIndex) {
      ClientFieldsService.aliasIndex = new Map(
        this.definitions().map((f) => [f.key, [f.key, ...(f.aliases ?? [])]]),
      );
    }
    const index = ClientFieldsService.aliasIndex;

    const expanded = new Set<string>();
    for (const key of stored) {
      for (const alias of index.get(key) ?? []) expanded.add(alias);
    }
    return [...expanded];
  }

  /** Test seam: forget the cached file so a spec can vary the catalog. */
  static resetCache(): void {
    ClientFieldsService.catalog = null;
    ClientFieldsService.aliasIndex = null;
  }
}

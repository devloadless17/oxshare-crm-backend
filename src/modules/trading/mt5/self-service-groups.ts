import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ValidationError } from '../../../common/errors/domain-errors';

/**
 * Which MT5 group a CLIENT's own account is opened in.
 *
 * ## Clients do not choose a group, and must not
 *
 * The admin console offers the live list from MT5, because an operator opening
 * an account for somebody needs to put it in the right segment. A client picking
 * from that same list would be choosing their own commission plan, leverage tier
 * and swap terms out of a dropdown — and the list itself is the broker's
 * internal structure, which is not the client's business to see.
 *
 * So self-service offers exactly two doors, live and demo, and an operator
 * decides once, in configuration, which group each maps to.
 *
 * ## Unset means the door is CLOSED
 *
 * A missing group is not a broken deployment to route around; it is a broker who
 * has not opted into self-service for that environment. Refusing with a message
 * that says so is better than falling back to a guessed group name and opening
 * real accounts somewhere nobody chose.
 */
@Injectable()
export class SelfServiceGroups {
  private readonly logger = new Logger(SelfServiceGroups.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * The group for this environment, or a refusal naming the setting.
   */
  resolve(environment: 'live' | 'demo'): string {
    const key = environment === 'live' ? 'MT5_CLIENT_GROUP_LIVE' : 'MT5_CLIENT_GROUP_DEMO';
    const group = this.config.get<string>(key)?.trim();

    if (!group) {
      this.logger.warn(`A client asked for a ${environment} account and ${key} is not set`);
      throw new ValidationError(
        environment === 'live'
          ? 'Opening a live account online is not available yet. Please contact support.'
          : 'Demo accounts are not available online yet. Please contact support.',
      );
    }

    return group;
  }

  /** Whether self-service is switched on for an environment — for the UI. */
  isEnabled(environment: 'live' | 'demo'): boolean {
    const key = environment === 'live' ? 'MT5_CLIENT_GROUP_LIVE' : 'MT5_CLIENT_GROUP_DEMO';
    return Boolean(this.config.get<string>(key)?.trim());
  }
}

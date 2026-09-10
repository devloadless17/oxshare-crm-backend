import { Module } from '@nestjs/common';
import { E2eFixturesController } from './e2e-fixtures.controller';

/**
 * Development-only fixture maintenance. See the controller for the reasoning.
 *
 * `AppModule` imports this conditionally, so in production the routes do not
 * exist at all rather than existing and refusing.
 */
@Module({ controllers: [E2eFixturesController] })
export class E2eFixturesModule {}

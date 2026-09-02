import { Global, Module } from '@nestjs/common';
import { ResourceChangedPublisher } from './resource-changed';
import { ResourceChangedInterceptor } from './resource-changed.interceptor';

/**
 * `@Global()` because `@AnnouncesChange` attaches the interceptor by CLASS, and
 * Nest resolves that class from the DI context of whichever module declares the
 * controller. Without this, every controller that wants to announce a change
 * would have to import a module — which is the kind of wiring that gets missed,
 * and whose failure mode is a startup error in one module and silence in the
 * rest. Same recipe `StoreModule` and `WalletModule` use.
 */
@Global()
@Module({
  providers: [ResourceChangedPublisher, ResourceChangedInterceptor],
  exports: [ResourceChangedPublisher, ResourceChangedInterceptor],
})
export class ResourceChangedModule {}

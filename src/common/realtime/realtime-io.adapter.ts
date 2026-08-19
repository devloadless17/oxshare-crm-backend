import { Logger, type INestApplication } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { Server, type ServerOptions } from 'socket.io';

/**
 * Which engine carries the WebSockets.
 *
 * `uws` is uWebSockets.js — a C++ WebSocket stack Socket.IO can run on top of.
 * `node` is Socket.IO's default, attached to the Nest HTTP server.
 */
export type RealtimeEngine = 'uws' | 'node';

/**
 * The engine seam. Socket.IO on uWebSockets.js, or on plain Node.
 *
 * ## Why this is a swap and not a rewrite
 *
 * Nothing above this file knows which engine is running. The gateway, the
 * rooms, the handshake authentication, the Postgres bus and every test are
 * identical either way, because uWebSockets.js replaces Socket.IO's TRANSPORT,
 * not its API — `server.attachApp(uwsApp)` is the entire integration. That is
 * exactly the property that made choosing Socket.IO worth it: the fast engine
 * is a configuration value, reversible with one environment variable, rather
 * than a decision the application code is built around.
 *
 * ## What it actually buys, stated honestly
 *
 * uWebSockets.js is dramatically faster per connection and per message, and it
 * earns that at tens of thousands of concurrent sockets per node. This system
 * has a handful of operators and clients and is not deployed. So the reason to
 * run it here is NOT today's throughput — it is that the ceiling is raised
 * before anything is built against a lower one, at the cost of one file.
 *
 * ## The two costs, because neither is zero
 *
 * **It listens on its own port.** Nest serves HTTP through Express, and one TCP
 * port has one listener, so the uWS app cannot share :3001. `REALTIME_PORT`
 * (3003 by default) is where the socket lives. Cookies ignore the port, so the
 * session cookie still reaches the handshake on the same host — but in
 * production the realtime origin must stay on the SAME HOSTNAME as the API, or
 * `__Host-` cookies (host-scoped, no Domain, by design) will not be sent and
 * every handshake will be refused. Route `wss://api…/socket.io` to this port at
 * the ingress rather than giving realtime its own subdomain.
 *
 * **It is a native addon in the API process.** A JS exception is catchable; a
 * segfault in a C++ addon takes the whole process down, money endpoints
 * included. That is survivable here — every write is one Postgres transaction
 * and an aborted connection rolls back — but it is a new class of failure, and
 * it is why the engine is a flag: `REALTIME_ENGINE=node` reverts it without a
 * deploy of new code.
 */
export class RealtimeIoAdapter extends IoAdapter {
  private static readonly logger = new Logger('Realtime');

  /** The uWS listen socket, kept only so shutdown can close it. */
  private listenSocket: unknown = null;

  /** The engine that actually ran. See `engineInUse`. */
  private resolvedEngine: RealtimeEngine;

  constructor(
    app: INestApplication,
    private readonly engine: RealtimeEngine,
    private readonly port: number,
  ) {
    super(app);
    this.resolvedEngine = engine;
  }

  /**
   * The engine actually carrying the sockets — not always the one asked for,
   * because `uws` degrades to the default engine where the native binary has no
   * prebuild for this platform.
   *
   * Exposed because the boot banner names the socket's port, and the two engines
   * put it in different places: `uws` on `REALTIME_PORT`, `node` on the API port.
   * Printing the configured port unconditionally announces a port nothing is
   * listening on the moment the fallback fires — and a stated port that is dead
   * is worse than no line at all, because it sends whoever is debugging the
   * silent socket to the wrong listener. Valid only after the gateway has
   * initialised, which is during `app.listen`.
   */
  get engineInUse(): RealtimeEngine {
    return this.resolvedEngine;
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    if (this.engine !== 'uws') {
      this.resolvedEngine = 'node';
      RealtimeIoAdapter.logger.log('Realtime engine: node (Socket.IO default).');
      return super.createIOServer(port, options);
    }

    const uws = loadUws();
    if (!uws) {
      /*
       * A missing prebuild for this platform must not stop the API booting.
       * Realtime degrading to the default engine is invisible to users; an API
       * that refuses to start because a performance optimisation is
       * unavailable is not.
       */
      this.resolvedEngine = 'node';
      RealtimeIoAdapter.logger.warn(
        'uWebSockets.js could not be loaded on this platform — falling back to the ' +
          'default engine. Realtime works; it is just the slower transport, and the ' +
          `socket is on the API port rather than ${this.port}.`,
      );
      return super.createIOServer(port, options);
    }

    const server = new Server(options);
    const app = uws.App();
    server.attachApp(app);

    app.listen(this.port, (token: unknown) => {
      if (!token) {
        // Loud, and fatal. A silently unlistening socket server looks exactly
        // like a quiet one — every client connects nowhere and reports nothing.
        RealtimeIoAdapter.logger.error(
          `The realtime engine could not bind port ${this.port}. Set REALTIME_PORT, ` +
            'or REALTIME_ENGINE=node to attach realtime to the API port instead.',
        );
        throw new Error(`Realtime port ${this.port} is unavailable`);
      }
      this.listenSocket = token;
      RealtimeIoAdapter.logger.log(`Realtime engine: uWebSockets.js, listening on ${this.port}.`);
    });

    return server;
  }

  override async close(server: Server): Promise<void> {
    if (this.listenSocket) {
      // Without this the port stays bound after shutdown, so the next boot
      // fails to bind and realtime is dead until someone finds the orphan.
      loadUws()?.us_listen_socket_close(this.listenSocket);
      this.listenSocket = null;
    }
    await super.close(server);
  }
}

/** The uWS module shape this file uses. Kept minimal on purpose. */
interface UwsModule {
  App: () => { listen: (port: number, cb: (token: unknown) => void) => void };
  us_listen_socket_close: (token: unknown) => void;
}

/**
 * Load uWebSockets.js, or `null` where it cannot run.
 *
 * `require` rather than `import`: the package ships prebuilt binaries per
 * platform and Node ABI, and the one honest answer to "this machine has no
 * matching binary" is to carry on with the other engine — which needs the
 * failure to be catchable at the call site, not a module-load crash.
 */
function loadUws(): UwsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('uWebSockets.js') as UwsModule;
  } catch {
    return null;
  }
}

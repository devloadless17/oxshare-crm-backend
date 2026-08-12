import { afterEach, describe, expect, it } from 'vitest';
import { createServer } from 'net';
import type { Server } from 'socket.io';
import { RealtimeIoAdapter } from '../src/common/realtime/realtime-io.adapter';

/**
 * The engine seam.
 *
 * Two claims are worth holding down, and both are about the PORT rather than
 * about throughput. uWebSockets.js owns its own listener, so choosing it moves
 * the socket off the API port — a fact the frontends' origin, the CSP and the
 * production ingress all depend on. And a listener that is not released on
 * shutdown leaves the port bound, so the next boot cannot bind and realtime is
 * dead until somebody finds the orphaned process.
 */

/** A free port, taken from the ephemeral range so tests never collide. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Whether anything currently holds the port. */
async function isBound(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.on('error', () => resolve(true));
    probe.listen(port, () => probe.close(() => resolve(false)));
  });
}

let created: { adapter: RealtimeIoAdapter; server: Server }[] = [];

afterEach(async () => {
  for (const { adapter, server } of created) await adapter.close(server).catch(() => undefined);
  created = [];
});

function build(engine: 'uws' | 'node', port: number) {
  const adapter = new RealtimeIoAdapter(undefined as never, engine, port);
  const server = adapter.createIOServer(0, { cors: { origin: '*' } } as never) as Server;
  created.push({ adapter, server });
  return { adapter, server };
}

describe('the realtime engine', () => {
  it('binds its OWN port under uws — the fact the frontend origin depends on', async () => {
    const port = await freePort();
    expect(await isBound(port)).toBe(false);

    build('uws', port);

    // Nest serves HTTP through Express and one TCP port has one listener, so
    // this is not an implementation detail — it is why the browser connects to
    // a different origin than the REST API does.
    expect(await isBound(port)).toBe(true);
  });

  it('releases the port on shutdown', async () => {
    /*
     * Without this the port stays bound after the process is asked to stop, the
     * next boot fails to bind, and realtime is silently dead — the failure
     * nobody attributes to a shutdown path.
     */
    const port = await freePort();
    const { adapter, server } = build('uws', port);
    expect(await isBound(port)).toBe(true);

    await adapter.close(server);
    created = [];

    expect(await isBound(port)).toBe(false);
  });

  it('leaves the realtime port alone under the node engine', async () => {
    // `REALTIME_ENGINE=node` is the one-variable revert. It must genuinely not
    // take the port, or reverting would collide with whatever replaced it.
    const port = await freePort();

    build('node', port);

    expect(await isBound(port)).toBe(false);
  });

  it('returns a working Socket.IO server either way', async () => {
    // The seam's whole promise: nothing above it can tell which engine ran.
    const uws = build('uws', await freePort());
    const node = build('node', await freePort());

    for (const { server } of [uws, node]) {
      expect(typeof server.of).toBe('function');
      expect(typeof server.to).toBe('function');
    }
  });
});

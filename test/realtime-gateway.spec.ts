import { describe, expect, it, vi } from 'vitest';
import {
  NOTIFICATION_EVENT,
  NotificationsRealtimeGateway,
} from '../src/modules/notifications/realtime.gateway';
import {
  parseCookieHeader,
  RealtimePrincipalResolver,
} from '../src/modules/notifications/realtime.principal';
import type { AdminAuthenticator } from '../src/modules/admin/guards/admin.guard';
import type { JwtStrategy } from '../src/modules/identity/strategies/jwt.strategy';

/**
 * The socket's authorization surface.
 *
 * A WebSocket is the one place in this system where authority is granted ONCE
 * and then held for minutes. Everything here is about that: who gets in, whose
 * room they land in, and when they are thrown out again. The delivery half —
 * that the database only announces committed rows — is
 * `notifications-realtime.spec.ts`, against real Postgres.
 */

const ADMIN_COOKIE = 'oxshare_crm_admin_at';
const CLIENT_COOKIE = 'oxshare_crm_portal_at';

const ADMIN_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const CLIENT_ID = 'cccccccc-0000-4000-8000-000000000002';

/** A resolver whose two authenticators answer however the test wants. */
function buildResolver(options: {
  admin?: { id: string } | null;
  client?: { id: string } | null;
  exp?: number;
}) {
  const adminAuthenticator = {
    authenticate: vi.fn(() =>
      options.admin ? Promise.resolve(options.admin) : Promise.reject(new Error('refused')),
    ),
  } as unknown as AdminAuthenticator;

  const clientStrategy = {
    validate: vi.fn(() =>
      options.client ? Promise.resolve(options.client) : Promise.reject(new Error('refused')),
    ),
  } as unknown as JwtStrategy;

  const jwt = {
    verify: vi.fn(() => ({ sub: options.client?.id ?? 'x', exp: options.exp })),
  };
  const config = { getOrThrow: () => 'secret' };

  return new RealtimePrincipalResolver(
    adminAuthenticator,
    clientStrategy,
    jwt as never,
    config as never,
  );
}

let socketSeq = 0;

/** A socket that records what it was asked to do. */
function fakeSocket(cookie?: string) {
  return {
    id: `socket-${++socketSeq}`,
    handshake: { headers: { cookie } },
    data: {} as Record<string, unknown>,
    rooms: [] as string[],
    emitted: [] as string[],
    disconnected: false,
    join: vi.fn(function (this: { rooms: string[] }, room: string) {
      this.rooms.push(room);
      return Promise.resolve();
    }),
    emit: vi.fn(function (this: { emitted: string[] }, event: string) {
      this.emitted.push(event);
      return true;
    }),
    disconnect: vi.fn(function (this: { disconnected: boolean }) {
      this.disconnected = true;
    }),
  };
}

function buildGateway(resolver: RealtimePrincipalResolver) {
  const gateway = new NotificationsRealtimeGateway({ get: () => 'test' } as never, resolver);
  const rooms = new Map<string, string[]>();
  // The Socket.IO server, reduced to what the gateway calls.
  (gateway as unknown as { server: unknown }).server = {
    to: (room: string) => ({
      emit: (event: string, payload: unknown) => {
        rooms.set(room, [...(rooms.get(room) ?? []), `${event}:${JSON.stringify(payload)}`]);
      },
    }),
  };
  return { gateway, rooms };
}

describe('parseCookieHeader', () => {
  it('reads a normal jar', () => {
    expect(parseCookieHeader('a=1; b=two')).toEqual({ a: '1', b: 'two' });
  });

  it('survives the shapes a real header takes', () => {
    // No header at all (a non-browser client), a stray separator, and a value
    // containing '=' — a JWT is base64 and can end in padding.
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader('   ;  ; a=1')).toEqual({ a: '1' });
    expect(parseCookieHeader('t=aaa.bbb.ccc==')).toEqual({ t: 'aaa.bbb.ccc==' });
  });
});

describe('who is allowed to hold a socket', () => {
  it('refuses a handshake with no cookies, and says so before closing', async () => {
    const { gateway } = buildGateway(buildResolver({}));
    const socket = fakeSocket(undefined);

    await gateway.handleConnection(socket as never);

    /*
     * Disconnected, not merely left in no room. An unauthenticated socket that
     * stays open receives nothing but looks connected to the browser, which
     * makes an expired session indistinguishable from a quiet one.
     */
    expect(socket.emitted).toContain('unauthorized');
    expect(socket.disconnected).toBe(true);
    expect(socket.rooms).toEqual([]);
  });

  it('refuses a cookie the authenticator rejects — suspended, revoked, expired', async () => {
    const { gateway } = buildGateway(buildResolver({ admin: null }));
    const socket = fakeSocket(`${ADMIN_COOKIE}=stale`);

    await gateway.handleConnection(socket as never);

    expect(socket.disconnected).toBe(true);
    expect(socket.rooms).toEqual([]);
  });

  it('puts an admin in the ADMIN room for their id', async () => {
    const { gateway } = buildGateway(buildResolver({ admin: { id: ADMIN_ID } }));
    const socket = fakeSocket(`${ADMIN_COOKIE}=good`);

    await gateway.handleConnection(socket as never);

    expect(socket.rooms).toEqual([`admin:${ADMIN_ID}`]);
    expect(socket.disconnected).toBe(false);
  });

  it('puts a client in the CLIENT room for their id', async () => {
    const { gateway } = buildGateway(buildResolver({ client: { id: CLIENT_ID } }));
    const socket = fakeSocket(`${CLIENT_COOKIE}=good`);

    await gateway.handleConnection(socket as never);

    expect(socket.rooms).toEqual([`client:${CLIENT_ID}`]);
  });

  it('never tries the portal cookie once an admin cookie is present — R-3.1', async () => {
    /*
     * The two surfaces stay separate. If an admin cookie is present and fails,
     * the handshake is refused rather than falling through to the client
     * authenticator — otherwise a rejected admin holding any valid portal
     * session would be admitted, on the admin app's socket.
     */
    const resolver = buildResolver({ admin: null, client: { id: CLIENT_ID } });
    const { gateway } = buildGateway(resolver);
    const socket = fakeSocket(`${ADMIN_COOKIE}=stale; ${CLIENT_COOKIE}=good`);

    await gateway.handleConnection(socket as never);

    expect(socket.disconnected).toBe(true);
    expect(socket.rooms).toEqual([]);
  });
});

describe('an event reaches exactly one room', () => {
  it('emits into the recipient’s room, with no notification body', () => {
    const { gateway, rooms } = buildGateway(buildResolver({}));

    gateway.publish({
      id: 'n-1',
      recipientKind: 'client',
      recipientId: CLIENT_ID,
      kind: 'withdrawal.approved',
    });

    const delivered = rooms.get(`client:${CLIENT_ID}`) ?? [];
    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toContain(NOTIFICATION_EVENT);
    expect(delivered[0]).toContain('n-1');
    // The row is refetched over the authenticated endpoint; the socket carries
    // only what routes it.
    expect(delivered[0]).toContain('withdrawal.approved');
    expect(rooms.get(`admin:${CLIENT_ID}`)).toBeUndefined();
  });

  it('does not cross the two audiences on a shared uuid', () => {
    /*
     * An admin id and a client id come from different tables and could
     * coincide. The KIND is part of the room name, so they cannot reach each
     * other — the same ownership rule the store's WHERE clause enforces,
     * asserted here because the socket bypasses that query entirely.
     */
    const { gateway, rooms } = buildGateway(buildResolver({}));
    const shared = CLIENT_ID;

    gateway.publish({ id: 'for-admin', recipientKind: 'admin', recipientId: shared, kind: 'x' });

    expect(rooms.get(`admin:${shared}`)).toHaveLength(1);
    expect(rooms.get(`client:${shared}`)).toBeUndefined();
  });
});

describe('a socket does not outlive its credential', () => {
  it('closes the socket when the access token expires', async () => {
    vi.useFakeTimers();
    try {
      const expiresInMs = 5_000;
      const resolver = buildResolver({
        admin: { id: ADMIN_ID },
        exp: Math.floor((Date.now() + expiresInMs) / 1000),
      });
      const { gateway } = buildGateway(resolver);
      const socket = fakeSocket(`${ADMIN_COOKIE}=good`);

      await gateway.handleConnection(socket as never);
      expect(socket.disconnected).toBe(false);

      vi.advanceTimersByTime(expiresInMs + 100);

      // Named, so the frontend's reconnect is not mistaken for an error.
      expect(socket.emitted).toContain('session_expired');
      expect(socket.disconnected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps a long-lived token at the ceiling rather than trusting it', async () => {
    vi.useFakeTimers();
    try {
      // A token good for a day must not buy a socket good for a day: the
      // handshake is the only authorization check it will ever face.
      const resolver = buildResolver({
        admin: { id: ADMIN_ID },
        exp: Math.floor((Date.now() + 24 * 60 * 60 * 1000) / 1000),
      });
      const { gateway } = buildGateway(resolver);
      const socket = fakeSocket(`${ADMIN_COOKIE}=good`);

      await gateway.handleConnection(socket as never);
      vi.advanceTimersByTime(15 * 60 * 1000 + 1_000);

      expect(socket.disconnected).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the timer on disconnect, so nothing leaks per socket', async () => {
    vi.useFakeTimers();
    try {
      const { gateway } = buildGateway(buildResolver({ admin: { id: ADMIN_ID } }));
      const socket = fakeSocket(`${ADMIN_COOKIE}=good`);

      await gateway.handleConnection(socket as never);
      gateway.handleDisconnect(socket as never);
      socket.emitted.length = 0;

      vi.advanceTimersByTime(20 * 60 * 1000);

      // A timer surviving its socket is a slow leak on the busiest object in
      // the system — one per tab, per reconnect, forever.
      expect(socket.emitted).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

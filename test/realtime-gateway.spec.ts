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

const PORTAL_ORIGIN = 'https://portal.oxshare.com';
const ADMIN_ORIGIN = 'https://admin.oxshare.com';

/**
 * A socket that records what it was asked to do.
 *
 * The origin defaults to the admin console's because that is the ordinary
 * case; the tests that care pass their own.
 */
function fakeSocket(cookie?: string, origin: string | null = ADMIN_ORIGIN) {
  return {
    id: `socket-${++socketSeq}`,
    // `null` means the header is ABSENT — a default parameter cannot express
    // that, because passing `undefined` is exactly what triggers the default.
    handshake: { headers: { cookie, origin: origin ?? undefined } },
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
  const config = {
    get: (key: string) =>
      key === 'PORTAL_URL' ? PORTAL_ORIGIN : key === 'ADMIN_URL' ? ADMIN_ORIGIN : 'test',
  };
  const gateway = new NotificationsRealtimeGateway(config as never, resolver);
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

  it('does not throw on a malformed percent escape', () => {
    /*
     * `decodeURIComponent('%')` throws a URIError, and this runs on a header an
     * unauthenticated stranger controls, inside a promise Nest does not await.
     * Throwing here was a one-request process kill.
     *
     * The raw value is kept: a cookie we cannot decode will not authenticate,
     * and refusing it is already the right answer.
     */
    expect(() => parseCookieHeader('a=%')).not.toThrow();
    expect(parseCookieHeader('a=%; b=fine')).toEqual({ a: '%', b: 'fine' });
    expect(parseCookieHeader('t=%E0%A4%A')).toEqual({ t: '%E0%A4%A' });
  });
});

describe('where a socket is allowed to come from', () => {
  it('accepts each of the two configured app origins', async () => {
    /*
     * Each origin with ITS OWN cookie. The origin decides the surface now, so
     * looping both with an admin cookie asserted the bug this suite exists to
     * prevent: an admin session admitted on the portal's socket.
     */
    const cases = [
      { origin: PORTAL_ORIGIN, cookie: `${CLIENT_COOKIE}=good`, room: `client:${CLIENT_ID}` },
      { origin: ADMIN_ORIGIN, cookie: `${ADMIN_COOKIE}=good`, room: `admin:${ADMIN_ID}` },
    ];

    for (const { origin, cookie, room } of cases) {
      const { gateway } = buildGateway(
        buildResolver({ admin: { id: ADMIN_ID }, client: { id: CLIENT_ID } }),
      );
      const socket = fakeSocket(cookie, origin);

      await gateway.handleConnection(socket as never);

      expect(socket.disconnected, origin).toBe(false);
      expect(socket.rooms, origin).toEqual([room]);
    }
  });

  it('refuses a SIBLING OxShare origin, which SameSite does not stop', async () => {
    /*
     * The reason this check exists at all. `session-cookies.ts` records that
     * SameSite is computed on the registrable domain, so `promo.oxshare.com` is
     * SAME-SITE as this API and the browser sends the session cookie with its
     * handshake. Without an origin check, a page there could hold a socket as
     * the reader and receive their notifications.
     *
     * `cors.origin` does not cover it: browsers do not CORS-check a WebSocket
     * upgrade, so refusing an origin there withholds a header nothing reads.
     */
    const { gateway } = buildGateway(buildResolver({ admin: { id: ADMIN_ID } }));
    const socket = fakeSocket(`${ADMIN_COOKIE}=good`, 'https://promo.oxshare.com');

    await gateway.handleConnection(socket as never);

    expect(socket.disconnected).toBe(true);
    expect(socket.rooms).toEqual([]);
  });

  it('refuses a look-alike rather than matching on a suffix', async () => {
    // `endsWith('.oxshare.com')` would admit the first of these and a domain
    // regex would admit the second. Exact equality admits neither.
    for (const origin of ['https://evil-oxshare.com', 'https://admin.oxshare.com.attacker.net']) {
      const { gateway } = buildGateway(buildResolver({ admin: { id: ADMIN_ID } }));
      const socket = fakeSocket(`${ADMIN_COOKIE}=good`, origin);

      await gateway.handleConnection(socket as never);

      expect(socket.disconnected, origin).toBe(true);
    }
  });

  it('refuses a handshake carrying no Origin at all', async () => {
    // The same call CsrfGuard makes: every browser sends one, so its absence is
    // a non-browser client — which should not be holding a session cookie.
    const { gateway } = buildGateway(buildResolver({ admin: { id: ADMIN_ID } }));
    const socket = fakeSocket(`${ADMIN_COOKIE}=good`, null);

    await gateway.handleConnection(socket as never);

    expect(socket.disconnected).toBe(true);
    expect(socket.rooms).toEqual([]);
  });

  it('checks the origin BEFORE doing any authentication work', async () => {
    // An unauthenticated stranger must not be able to make this API verify a
    // token — that is a free amplification primitive.
    const resolver = buildResolver({ admin: { id: ADMIN_ID } });
    const resolve = vi.spyOn(resolver, 'resolve');
    const { gateway } = buildGateway(resolver);

    await gateway.handleConnection(
      fakeSocket(`${ADMIN_COOKIE}=good`, 'https://evil.test') as never,
    );

    expect(resolve).not.toHaveBeenCalled();
  });
});

describe('nothing escapes the handshake', () => {
  it('refuses rather than rejecting when the resolver throws', async () => {
    /*
     * Nest does not await `handleConnection`, so a rejection here is an
     * unhandled rejection — which ends the process under Node's default. The
     * input is a header an anonymous caller chose, so that is a remote kill.
     */
    const resolver = buildResolver({});
    vi.spyOn(resolver, 'resolve').mockRejectedValue(new Error('the database went away'));
    const { gateway } = buildGateway(resolver);
    const socket = fakeSocket(`${ADMIN_COOKIE}=good`);

    await expect(gateway.handleConnection(socket as never)).resolves.toBeUndefined();
    expect(socket.disconnected).toBe(true);
    expect(socket.emitted).toContain('unauthorized');
  });

  it('does not join a socket that went away while it was being authenticated', async () => {
    /*
     * A tab closed mid-handshake. `handleDisconnect` has already run by then,
     * so joining leaves a room entry no disconnect will remove and arming the
     * timer leaks it for a quarter of an hour — both per connection, so a
     * flapping client compounds them.
     */
    const resolver = buildResolver({ admin: { id: ADMIN_ID } });
    const socket = fakeSocket(`${ADMIN_COOKIE}=good`);
    vi.spyOn(resolver, 'resolve').mockImplementation(() => {
      socket.disconnected = true;
      return Promise.resolve({ recipient: { kind: 'admin', id: ADMIN_ID }, expiresAt: null });
    });
    const { gateway } = buildGateway(resolver);

    await gateway.handleConnection(socket as never);

    expect(socket.join).not.toHaveBeenCalled();
    expect(socket.rooms).toEqual([]);
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
    // PORTAL_ORIGIN explicitly: `fakeSocket` defaults to the admin origin, and
    // the surface is decided by the origin rather than by which cookie is
    // present — a client cookie arriving on the admin socket is refused.
    const socket = fakeSocket(`${CLIENT_COOKIE}=good`, PORTAL_ORIGIN);

    await gateway.handleConnection(socket as never);

    expect(socket.rooms).toEqual([`client:${CLIENT_ID}`]);
  });

  /*
   * ── THE BUG A CLIENT ACTUALLY SAW ────────────────────────────────────────
   *
   * A client requested a withdrawal and their own browser toasted the word
   * "Notification" — the portal's generic fallback, because its catalogue
   * rightly knows no `admin.*` kind.
   *
   * The cause was here. The resolver tried the ADMIN cookie first regardless of
   * which app the socket came from, and in development both apps are on
   * localhost — where cookies are shared across ports. An operator with the
   * console open in another tab therefore carried an admin cookie into the
   * PORTAL's handshake, resolved as an admin, and joined `admin:<id>`. Their
   * browser then received the admin work queue ("a client requested a
   * withdrawal") and none of their own events.
   *
   * The toast was the visible half. The half that matters is that a client's
   * browser was being handed another party's notifications.
   */
  it('resolves a PORTAL socket as the client even when an admin cookie rides along', async () => {
    const resolver = buildResolver({ admin: { id: ADMIN_ID }, client: { id: CLIENT_ID } });
    const { gateway } = buildGateway(resolver);
    // Both cookies, portal origin — a developer with the console open in
    // another tab, which is every developer.
    const socket = fakeSocket(`${ADMIN_COOKIE}=good; ${CLIENT_COOKIE}=good`, PORTAL_ORIGIN);

    await gateway.handleConnection(socket as never);

    expect(socket.rooms).toEqual([`client:${CLIENT_ID}`]);
    expect(socket.rooms).not.toContain(`admin:${ADMIN_ID}`);
    expect(socket.disconnected).toBe(false);
  });

  it('refuses a PORTAL socket carrying only an admin cookie', async () => {
    /*
     * The other direction of the same rule. An admin session is not a portal
     * identity, so the handshake is refused rather than admitted as whoever the
     * admin happens to be — R-3.1, a portal token must be worthless on the
     * admin surface and vice versa.
     */
    const resolver = buildResolver({ admin: { id: ADMIN_ID }, client: null });
    const { gateway } = buildGateway(resolver);
    const socket = fakeSocket(`${ADMIN_COOKIE}=good`, PORTAL_ORIGIN);

    await gateway.handleConnection(socket as never);

    expect(socket.disconnected).toBe(true);
    expect(socket.rooms).toEqual([]);
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

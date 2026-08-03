import { count, eq } from 'drizzle-orm';
import { getDb } from '../database/db';
import { users } from '../database/schema';

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  firstName: string;
  lastName: string;
  type: 'individual' | 'referral' | 'partner';
  status: 'active' | 'suspended' | 'pending';
  verificationLevel: 0 | 1;
  emailVerified: boolean;
  emailVerificationToken?: string;
  emailVerificationExpiry?: Date;
  refreshToken?: string;
  country?: string;
  phone?: string;
  createdAt: Date;
}

type Row = typeof users.$inferSelect;

const toUser = (r: Row): User => ({
  ...r,
  verificationLevel: (r.verificationLevel === 1 ? 1 : 0),
  emailVerificationToken: r.emailVerificationToken ?? undefined,
  emailVerificationExpiry: r.emailVerificationExpiry ?? undefined,
  refreshToken: r.refreshToken ?? undefined,
  country: r.country ?? undefined,
  phone: r.phone ?? undefined,
});

export const UsersStore = {
  async create(data: Omit<User, 'id' | 'createdAt'>): Promise<User> {
    const [row] = await getDb().insert(users).values(data).returning();
    return toUser(row);
  },

  async findById(id: string): Promise<User | undefined> {
    const [row] = await getDb().select().from(users).where(eq(users.id, id)).limit(1);
    return row ? toUser(row) : undefined;
  },

  async findByEmail(email: string): Promise<User | undefined> {
    const [row] = await getDb()
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase()))
      .limit(1);
    return row ? toUser(row) : undefined;
  },

  async findByVerificationToken(token: string): Promise<User | undefined> {
    const [row] = await getDb()
      .select()
      .from(users)
      .where(eq(users.emailVerificationToken, token))
      .limit(1);
    return row ? toUser(row) : undefined;
  },

  async update(id: string, patch: Partial<User>): Promise<User | undefined> {
    const { id: _ignored, createdAt: _also, ...rest } = patch;
    const [row] = await getDb().update(users).set(rest).where(eq(users.id, id)).returning();
    return row ? toUser(row) : undefined;
  },

  async findAll(): Promise<User[]> {
    const rows = await getDb().select().from(users);
    return rows.map(toUser);
  },

  async count(): Promise<number> {
    const [{ value }] = await getDb().select({ value: count() }).from(users);
    return value;
  },
};

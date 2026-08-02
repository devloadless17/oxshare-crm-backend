import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcryptjs';

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



const users = new Map<string, User>();
const usersByEmail = new Map<string, string>(); // email → id

// Seed default demo client user
const DEMO_USER_ID = uuidv4();
const demoUser: User = {
  id: DEMO_USER_ID,
  email: 'client@oxshare.com',
  passwordHash: bcrypt.hashSync('client123', 10),
  firstName: 'John',
  lastName: 'Doe',
  type: 'individual',
  status: 'active',
  verificationLevel: 0,
  emailVerified: true,
  country: 'United Arab Emirates',
  phone: '+971501234567',
  createdAt: new Date(),
};
users.set(DEMO_USER_ID, demoUser);
usersByEmail.set('client@oxshare.com', DEMO_USER_ID);

export const UsersStore = {
  create(data: Omit<User, 'id' | 'createdAt'>): User {
    const id = uuidv4();
    const user: User = { ...data, id, createdAt: new Date() };
    users.set(id, user);
    usersByEmail.set(data.email.toLowerCase(), id);
    return user;
  },

  findById(id: string): User | undefined {
    return users.get(id);
  },

  findByEmail(email: string): User | undefined {
    const id = usersByEmail.get(email.toLowerCase());
    return id ? users.get(id) : undefined;
  },

  findByVerificationToken(token: string): User | undefined {
    return [...users.values()].find((u) => u.emailVerificationToken === token);
  },

  update(id: string, patch: Partial<User>): User | undefined {
    const user = users.get(id);
    if (!user) return undefined;
    const updated = { ...user, ...patch };
    users.set(id, updated);
    return updated;
  },

  findAll(): User[] {
    return [...users.values()];
  },

  count(): number {
    return users.size;
  },
};

import { v4 as uuidv4 } from 'uuid';

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

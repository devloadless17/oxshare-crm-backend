import { v4 as uuidv4 } from 'uuid';
import * as bcrypt from 'bcryptjs';

export type AdminRole = 'master_admin' | 'sub_admin';

export interface Admin {
  id: string;
  email: string;
  passwordHash: string;
  name: string;
  role: AdminRole;
  permissions: string[];
  refreshToken?: string;
  createdAt: Date;
}

export interface AdminInvite {
  id: string;
  email: string;
  name: string;
  token: string;
  role: 'sub_admin';
  invitedBy: string;
  expiresAt: Date;
  accepted: boolean;
  createdAt: Date;
}

const admins = new Map<string, Admin>();
const adminsByEmail = new Map<string, string>();
const invites = new Map<string, AdminInvite>();

// Seed default master admin — password is hashed synchronously on first load
const MASTER_ID = uuidv4();
const masterAdmin: Admin = {
  id: MASTER_ID,
  email: 'admin@oxshare.com',
  passwordHash: bcrypt.hashSync('admin123', 10),
  name: 'Master Admin',
  role: 'master_admin',
  permissions: ['*'],
  createdAt: new Date(),
};
admins.set(MASTER_ID, masterAdmin);
adminsByEmail.set('admin@oxshare.com', MASTER_ID);

export const AdminsStore = {
  create(data: Omit<Admin, 'id' | 'createdAt'>): Admin {
    const id = uuidv4();
    const admin: Admin = { ...data, id, createdAt: new Date() };
    admins.set(id, admin);
    adminsByEmail.set(data.email.toLowerCase(), id);
    return admin;
  },

  findById(id: string): Admin | undefined {
    return admins.get(id);
  },

  findByEmail(email: string): Admin | undefined {
    const id = adminsByEmail.get(email.toLowerCase());
    return id ? admins.get(id) : undefined;
  },

  update(id: string, patch: Partial<Admin>): Admin | undefined {
    const admin = admins.get(id);
    if (!admin) return undefined;
    const updated = { ...admin, ...patch };
    admins.set(id, updated);
    return updated;
  },

  findAll(): Admin[] {
    return [...admins.values()];
  },
};

export const InvitesStore = {
  create(data: Omit<AdminInvite, 'id' | 'createdAt' | 'accepted'>): AdminInvite {
    const id = uuidv4();
    const invite: AdminInvite = { ...data, id, accepted: false, createdAt: new Date() };
    invites.set(data.token, invite);
    return invite;
  },

  findByToken(token: string): AdminInvite | undefined {
    return invites.get(token);
  },

  markAccepted(token: string): void {
    const invite = invites.get(token);
    if (invite) invites.set(token, { ...invite, accepted: true });
  },
};

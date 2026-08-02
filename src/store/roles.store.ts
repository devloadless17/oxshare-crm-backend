import { v4 as uuidv4 } from 'uuid';

export interface Role {
  id: string;
  name: string;
  description?: string;
  permissions: string[];
  isSystem: boolean;
  createdAt: Date;
}

const roles = new Map<string, Role>();

// Seed the system role. '*' is the wildcard granting every permission.
const MASTER_ROLE_ID = uuidv4();
roles.set(MASTER_ROLE_ID, {
  id: MASTER_ROLE_ID,
  name: 'Master Admin',
  description: 'Full access to every administration section and operation (RBAC-01).',
  permissions: ['*'],
  isSystem: true,
  createdAt: new Date(),
});

export const RolesStore = {
  findAll(): Role[] {
    return [...roles.values()];
  },

  findById(id: string): Role | undefined {
    return roles.get(id);
  },

  findByName(name: string): Role | undefined {
    return [...roles.values()].find((r) => r.name.toLowerCase() === name.toLowerCase());
  },

  create(data: Omit<Role, 'id' | 'createdAt' | 'isSystem'>): Role {
    const id = uuidv4();
    const role: Role = { ...data, id, isSystem: false, createdAt: new Date() };
    roles.set(id, role);
    return role;
  },

  update(id: string, patch: Partial<Pick<Role, 'name' | 'description' | 'permissions'>>): Role | undefined {
    const role = roles.get(id);
    if (!role) return undefined;
    const updated = { ...role, ...patch };
    roles.set(id, updated);
    return updated;
  },

  delete(id: string): boolean {
    const role = roles.get(id);
    if (!role || role.isSystem) return false;
    return roles.delete(id);
  },
};

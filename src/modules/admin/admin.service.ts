import {
  Injectable,
  Inject,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { DRIZZLE_DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../database/schema';
import { eq, ne } from 'drizzle-orm';
import * as bcrypt from 'bcrypt';
import * as permissionsCatalog from '../../config/permissions.json';

@Injectable()
export class AdminService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  // --- 1. System Permissions Catalog ---
  getPermissionsCatalog() {
    return permissionsCatalog;
  }

  // --- 2. Dynamic Roles Management ---
  async getRoles() {
    return this.db.query.roles.findMany();
  }

  async createRole(dto: { name: string; description?: string; permissions: string[] }) {
    const existing = await this.db.query.roles.findFirst({
      where: eq(schema.roles.name, dto.name),
    });

    if (existing) {
      throw new BadRequestException('A role with this name already exists');
    }

    const [role] = await this.db
      .insert(schema.roles)
      .values({
        name: dto.name,
        description: dto.description || null,
        permissions: dto.permissions || [],
        isSystem: false,
      })
      .returning();

    return role;
  }

  async updateRole(
    id: string,
    dto: Partial<{ name: string; description: string; permissions: string[] }>,
  ) {
    const [updated] = await this.db
      .update(schema.roles)
      .set({
        ...dto,
        updatedAt: new Date(),
      })
      .where(eq(schema.roles.id, id))
      .returning();

    if (!updated) throw new NotFoundException('Role not found');
    return updated;
  }

  // --- 3. Admin Users Management (Add Admin) ---
  async addAdminUser(dto: {
    email: string;
    password: string;
    firstName: string;
    lastName: string;
    roleId?: string;
  }) {
    const existing = await this.db.query.users.findFirst({
      where: eq(schema.users.email, dto.email.toLowerCase()),
    });

    if (existing) {
      throw new BadRequestException('User with this email already exists');
    }

    const passwordHash = await bcrypt.hash(dto.password, 10);

    const [newAdmin] = await this.db
      .insert(schema.users)
      .values({
        email: dto.email.toLowerCase(),
        passwordHash,
        firstName: dto.firstName,
        lastName: dto.lastName,
        role: 'ADMIN',
        roleId: dto.roleId || null,
        status: 'ACTIVE',
        isEmailVerified: true,
      })
      .returning();

    return {
      message: 'Admin user created successfully',
      admin: {
        id: newAdmin.id,
        email: newAdmin.email,
        firstName: newAdmin.firstName,
        lastName: newAdmin.lastName,
        role: newAdmin.role,
        roleId: newAdmin.roleId,
      },
    };
  }

  async getAdminUsers() {
    return this.db.query.users.findMany({
      where: ne(schema.users.role, 'CLIENT'),
      with: {
        // Relation to roles can be joined
      },
    });
  }
}

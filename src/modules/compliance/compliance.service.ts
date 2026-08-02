import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DRIZZLE_DB } from '../../database/database.module';
import { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../database/schema';
import { eq, asc, desc } from 'drizzle-orm';

@Injectable()
export class ComplianceService {
  constructor(
    @Inject(DRIZZLE_DB) private readonly db: NodePgDatabase<typeof schema>,
  ) {}

  // --- Dynamic KYC Fields Management (Admin) ---

  async getFields(onlyActive = false) {
    if (onlyActive) {
      return this.db.query.kycFields.findMany({
        where: eq(schema.kycFields.isActive, true),
        orderBy: [asc(schema.kycFields.sortOrder)],
      });
    }
    return this.db.query.kycFields.findMany({
      orderBy: [asc(schema.kycFields.sortOrder)],
    });
  }

  async createField(dto: {
    fieldName: string;
    label: string;
    fieldType: 'text' | 'number' | 'select' | 'file' | 'date' | 'checkbox';
    options?: string[];
    isRequired?: boolean;
    isActive?: boolean;
    sortOrder?: number;
  }) {
    const existing = await this.db.query.kycFields.findFirst({
      where: eq(schema.kycFields.fieldName, dto.fieldName),
    });

    if (existing) {
      throw new BadRequestException('A KYC field with this name already exists');
    }

    const [field] = await this.db
      .insert(schema.kycFields)
      .values({
        fieldName: dto.fieldName,
        label: dto.label,
        fieldType: dto.fieldType,
        options: dto.options || null,
        isRequired: dto.isRequired ?? true,
        isActive: dto.isActive ?? true,
        sortOrder: dto.sortOrder ?? 0,
      })
      .returning();

    return field;
  }

  async updateField(
    id: string,
    dto: Partial<{
      label: string;
      fieldType: 'text' | 'number' | 'select' | 'file' | 'date' | 'checkbox';
      options: string[];
      isRequired: boolean;
      isActive: boolean;
      sortOrder: number;
    }>,
  ) {
    const [updated] = await this.db
      .update(schema.kycFields)
      .set({
        ...dto,
        updatedAt: new Date(),
      })
      .where(eq(schema.kycFields.id, id))
      .returning();

    if (!updated) throw new NotFoundException('KYC field not found');
    return updated;
  }

  async deleteField(id: string) {
    const [deleted] = await this.db
      .delete(schema.kycFields)
      .where(eq(schema.kycFields.id, id))
      .returning();

    if (!deleted) throw new NotFoundException('KYC field not found');
    return { message: 'KYC field deleted successfully' };
  }

  // --- Client Submission Engine ---

  async submitKyc(
    userId: string,
    values: { fieldId: string; valueText?: string; fileUrl?: string; fileName?: string }[],
  ) {
    // Create new submission record
    const [submission] = await this.db
      .insert(schema.kycSubmissions)
      .values({
        userId,
        status: 'PENDING',
      })
      .returning();

    // Insert field values
    if (values.length > 0) {
      await this.db.insert(schema.kycFieldValues).values(
        values.map((v) => ({
          submissionId: submission.id,
          fieldId: v.fieldId,
          valueText: v.valueText,
          fileUrl: v.fileUrl,
          fileName: v.fileName,
        })),
      );
    }

    return {
      message: 'KYC documents submitted successfully. Pending review.',
      submissionId: submission.id,
    };
  }

  async getSubmissionStatus(userId: string) {
    const latest = await this.db.query.kycSubmissions.findFirst({
      where: eq(schema.kycSubmissions.userId, userId),
      orderBy: [desc(schema.kycSubmissions.createdAt)],
      with: {
        // field values can be joined if required
      },
    });

    if (!latest) return { status: 'NOT_SUBMITTED' };
    return latest;
  }

  // --- Admin Review Queue ---

  async getAllSubmissions() {
    return this.db.query.kycSubmissions.findMany({
      orderBy: [desc(schema.kycSubmissions.createdAt)],
    });
  }

  async reviewSubmission(
    id: string,
    adminId: string,
    dto: { status: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED'; rejectionReason?: string },
  ) {
    const [updated] = await this.db
      .update(schema.kycSubmissions)
      .set({
        status: dto.status,
        rejectionReason: dto.rejectionReason || null,
        reviewedBy: adminId,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.kycSubmissions.id, id))
      .returning();

    if (!updated) throw new NotFoundException('Submission not found');
    return updated;
  }
}

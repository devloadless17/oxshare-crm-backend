import { existsSync, readdirSync, unlinkSync } from 'fs';
import {
  Injectable,
  Logger,
  InternalServerErrorException,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { KycStore, KycStatus } from '../../store/kyc.store';
import { UsersStore } from '../../store/users.store';
import { EmailService } from '../email/email.service';

@Injectable()
export class KycService {
  private readonly logger = new Logger(KycService.name);

  constructor(
    private readonly email: EmailService,
    private readonly kycStore: KycStore,
    private readonly users: UsersStore,
  ) {}

  // ─── Get status ────────────────────────────────────────────────────────────
  async getStatus(userId: string) {
    const submission = await this.kycStore.getOrCreate(userId);
    const user = await this.users.findById(userId);
    return {
      ...submission,
      verificationLevel: user?.verificationLevel ?? 0,
    };
  }

  // ─── Save step data ────────────────────────────────────────────────────────
  async saveStep(userId: string, step: string, data: Record<string, unknown>) {
    const submission = await this.kycStore.getOrCreate(userId);

    if (submission.status === 'approved') {
      throw new ForbiddenException('KYC already approved.');
    }
    if (submission.status === 'under_review' || submission.status === 'submitted') {
      throw new ForbiddenException('KYC is under review. You cannot edit it now.');
    }

    const patch: Record<string, unknown> = { status: 'in_progress' };

    if (step === 'personal') patch['personalInfo'] = { ...submission.personalInfo, ...data };
    else if (step === 'document') patch['document'] = { ...submission.document, ...data };
    else if (step === 'selfie') patch['selfie'] = { ...submission.selfie, ...data };
    else if (step === 'address') patch['addressProof'] = { ...submission.addressProof, ...data };
    else throw new BadRequestException(`Unknown step: ${step}`);

    return await this.kycStore.update(userId, patch);
  }

  // ─── Attach uploaded file to a step ────────────────────────────────────────
  async attachFile(userId: string, field: string, filePath: string, fileName: string) {
    const submission = await this.kycStore.getOrCreate(userId);

    if (field === 'doc_front') {
      await this.kycStore.update(userId, {
        document: {
          ...submission.document,
          frontFilePath: filePath,
          frontFileName: fileName,
          docType: submission.document?.docType ?? 'passport',
        },
      });
    } else if (field === 'doc_back') {
      await this.kycStore.update(userId, {
        document: {
          ...submission.document,
          backFilePath: filePath,
          backFileName: fileName,
          docType: submission.document?.docType ?? 'passport',
        },
      });
    } else if (field === 'selfie') {
      await this.kycStore.update(userId, { selfie: { filePath, fileName } });
    } else if (field === 'address_proof' || field === 'address_proof_2') {
      await this.kycStore.update(userId, {
        addressProof: {
          ...submission.addressProof,
          filePath:
            field === 'address_proof' ? filePath : submission.addressProof?.filePath || filePath,
          fileName:
            field === 'address_proof' ? fileName : submission.addressProof?.fileName || fileName,
          page2FilePath:
            field === 'address_proof_2' ? filePath : submission.addressProof?.page2FilePath,
          page2FileName:
            field === 'address_proof_2' ? fileName : submission.addressProof?.page2FileName,
          docType: submission.addressProof?.docType ?? 'utility_bill',
        },
      });
    } else {
      throw new BadRequestException(`Unknown file field: ${field}`);
    }

    return { message: 'File uploaded.', field, fileName };
  }

  // ─── Submit KYC ────────────────────────────────────────────────────────────
  async submit(userId: string) {
    const submission = await this.kycStore.getOrCreate(userId);
    const user = await this.users.findById(userId);

    if (!submission.personalInfo && user?.firstName) {
      submission.personalInfo = {
        firstName: user.firstName,
        lastName: user.lastName,
      };
      await this.kycStore.update(userId, { personalInfo: submission.personalInfo });
    }

    const finalSub = await this.kycStore.getOrCreate(userId);

    if (!finalSub.personalInfo)
      throw new BadRequestException('Personal information is required before submitting.');
    if (!finalSub.document?.frontFilePath)
      throw new BadRequestException('ID document front is required.');
    if (!finalSub.selfie?.filePath) throw new BadRequestException('Selfie is required.');
    if (!finalSub.addressProof?.filePath)
      throw new BadRequestException('Proof of address is required.');

    // A resubmission after rejection starts a fresh review — stale rejection
    // data must not follow it into the admin queue.
    return await this.kycStore.update(userId, {
      status: 'submitted',
      submittedAt: new Date(),
      rejectionReason: undefined,
      rejectedFields: undefined,
    });
  }

  // ─── Admin: list all (paginated, searchable, with per-status counts) ───────
  async listAll(filter: { status?: KycStatus; q?: string; page?: number; limit?: number } = {}) {
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter.limit ?? 25));

    // One joined query, filtered/sorted/paginated in SQL, plus one grouped
    // count. The previous version loaded every submission and then issued one
    // this.users.findById per row inside Promise.all — 1+N, which at 50K rows
    // fires 50,001 queries in a burst and can exhaust the pool that
    // WalletService.post() needs for its FOR UPDATE lock.
    return this.kycStore.findPageWithUsers({ status: filter.status, q: filter.q, page, limit });
  }

  // ─── Admin: get one ────────────────────────────────────────────────────────
  async getByUserId(userId: string) {
    const submission = await this.kycStore.findByUserId(userId);
    if (!submission) throw new NotFoundException('KYC submission not found.');
    const user = await this.users.findById(userId);
    return { ...submission, user };
  }

  // ─── Admin: approve ────────────────────────────────────────────────────────
  async approve(userId: string, adminId: string) {
    const submission = await this.kycStore.findByUserId(userId);
    if (!submission) throw new NotFoundException('KYC submission not found.');

    await this.kycStore.update(userId, {
      status: 'approved',
      reviewedBy: adminId,
      reviewedAt: new Date(),
    });

    await this.users.update(userId, { verificationLevel: 1 });

    const user = await this.users.findById(userId);
    if (user) {
      // Sent inline per ARCH §8.5 — fire-and-forget, failure is logged by EmailService
      void this.email.sendKycDecisionEmail(user.email, user.firstName, 'approved');
    }
    this.logger.log(`KYC approved for user ${userId} by admin ${adminId}`);
    return this.getByUserId(userId);
  }

  // ─── Admin: claim for review ───────────────────────────────────────────────
  // Marks a submitted KYC as under_review by this admin, so two reviewers
  // don't process the same submission concurrently.
  async claim(userId: string, adminId: string) {
    const submission = await this.kycStore.findByUserId(userId);
    if (!submission) throw new NotFoundException('KYC submission not found.');
    if (submission.status !== 'submitted') {
      throw new BadRequestException(
        submission.status === 'under_review'
          ? 'This submission is already being reviewed.'
          : 'Only submitted KYC can be claimed for review.',
      );
    }
    await this.kycStore.update(userId, { status: 'under_review', reviewedBy: adminId });
    return this.getByUserId(userId);
  }

  // ─── Admin: reject ─────────────────────────────────────────────────────────
  async reject(userId: string, adminId: string, reason: string, rejectedFields: string[] = []) {
    const submission = await this.kycStore.findByUserId(userId);
    if (!submission) throw new NotFoundException('KYC submission not found.');
    const user = await this.users.findById(userId);

    await this.kycStore.update(userId, {
      status: 'rejected',
      rejectionReason: reason,
      rejectedFields: rejectedFields,
      reviewedBy: adminId,
      reviewedAt: new Date(),
    });

    if (user) {
      // Sent inline per FR-ADM-03 — the client is emailed the reason and can retry
      void this.email.sendKycDecisionEmail(
        user.email,
        user.firstName,
        'rejected',
        reason,
        rejectedFields,
      );
    }

    return this.getByUserId(userId);
  }

  // ─── Reset User KYC ────────────────────────────────────────────────────────
  async resetKyc(userId: string) {
    await this.kycStore.resetUser(userId);
    return { message: 'KYC data reset successfully.' };
  }

  // ─── Reset All KYC Submissions ──────────────────────────────────────────────
  async resetAllKyc() {
    await this.kycStore.clearAll();
    // Report what could not be removed instead of silently claiming success —
    // a partial wipe on a compliance path must be visible.
    const failures: string[] = [];
    if (existsSync('./uploads/kyc')) {
      for (const file of readdirSync('./uploads/kyc')) {
        try {
          unlinkSync(`./uploads/kyc/${file}`);
        } catch (error) {
          failures.push(file);
          this.logger.error(`Failed to delete ${file}: ${(error as Error).message}`);
        }
      }
    }
    if (failures.length > 0) {
      throw new InternalServerErrorException(
        `KYC records cleared but ${failures.length} file(s) could not be deleted.`,
      );
    }
    return { message: 'All KYC submissions and uploaded files cleared successfully.' };
  }
}

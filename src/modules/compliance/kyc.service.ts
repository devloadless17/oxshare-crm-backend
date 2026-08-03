import { existsSync, readdirSync, unlinkSync } from 'fs';
import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { KycStore, KycStatus } from '../../store/kyc.store';
import { UsersStore } from '../../store/users.store';
import { EmailService } from '../email/email.service';

@Injectable()
export class KycService {
  constructor(private readonly email: EmailService) {}

  // ─── Get status ────────────────────────────────────────────────────────────
  async getStatus(userId: string) {
    const submission = KycStore.getOrCreate(userId);
    const user = await UsersStore.findById(userId);
    return {
      ...submission,
      verificationLevel: user?.verificationLevel ?? 0,
    };
  }

  // ─── Save step data ────────────────────────────────────────────────────────
  saveStep(userId: string, step: string, data: Record<string, unknown>) {
    const submission = KycStore.getOrCreate(userId);

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

    return KycStore.update(userId, patch as Parameters<typeof KycStore.update>[1]);
  }

  // ─── Attach uploaded file to a step ────────────────────────────────────────
  attachFile(
    userId: string,
    field: string,
    filePath: string,
    fileName: string,
  ) {
    const submission = KycStore.getOrCreate(userId);

    if (field === 'doc_front') {
      KycStore.update(userId, {
        document: { ...submission.document, frontFilePath: filePath, frontFileName: fileName, docType: submission.document?.docType ?? 'passport' },
      });
    } else if (field === 'doc_back') {
      KycStore.update(userId, {
        document: { ...submission.document, backFilePath: filePath, backFileName: fileName, docType: submission.document?.docType ?? 'passport' },
      });
    } else if (field === 'selfie') {
      KycStore.update(userId, { selfie: { filePath, fileName } });
    } else if (field === 'address_proof' || field === 'address_proof_2') {
      KycStore.update(userId, {
        addressProof: {
          ...submission.addressProof,
          filePath: field === 'address_proof' ? filePath : submission.addressProof?.filePath || filePath,
          fileName: field === 'address_proof' ? fileName : submission.addressProof?.fileName || fileName,
          page2FilePath: field === 'address_proof_2' ? filePath : submission.addressProof?.page2FilePath,
          page2FileName: field === 'address_proof_2' ? fileName : submission.addressProof?.page2FileName,
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
    const submission = KycStore.getOrCreate(userId);
    const user = await UsersStore.findById(userId);

    if (!submission.personalInfo && user?.firstName) {
      submission.personalInfo = {
        firstName: user.firstName,
        lastName: user.lastName,
      };
      KycStore.update(userId, { personalInfo: submission.personalInfo });
    }

    // Auto-recover file paths from disk if in-memory store was reset
    if (existsSync('./uploads/kyc')) {
      try {
        const files = readdirSync('./uploads/kyc');
        if (files.length > 0) {
          const updatedSub = KycStore.getOrCreate(userId);
          if (!updatedSub.document?.frontFilePath) {
            const frontFile = files.find((f) => f.includes('doc_front') || f.includes('passport')) || files[0];
            KycStore.update(userId, {
              document: {
                ...updatedSub.document,
                docType: updatedSub.document?.docType ?? 'passport',
                frontFilePath: `./uploads/kyc/${frontFile}`,
                frontFileName: frontFile,
              },
            });
          }
          if (!updatedSub.selfie?.filePath) {
            const selfieFile = files.find((f) => f.includes('selfie')) || files[1] || files[0];
            KycStore.update(userId, {
              selfie: { filePath: `./uploads/kyc/${selfieFile}`, fileName: selfieFile },
            });
          }
          if (!updatedSub.addressProof?.filePath) {
            const addressFile = files.find((f) => f.includes('address')) || files[2] || files[0];
            KycStore.update(userId, {
              addressProof: {
                ...updatedSub.addressProof,
                docType: updatedSub.addressProof?.docType ?? 'utility_bill',
                filePath: `./uploads/kyc/${addressFile}`,
                fileName: addressFile,
              },
            });
          }
        }
      } catch {}
    }

    const finalSub = KycStore.getOrCreate(userId);

    if (!finalSub.personalInfo)
      throw new BadRequestException('Personal information is required before submitting.');
    if (!finalSub.document?.frontFilePath)
      throw new BadRequestException('ID document front is required.');
    if (!finalSub.selfie?.filePath)
      throw new BadRequestException('Selfie is required.');
    if (!finalSub.addressProof?.filePath)
      throw new BadRequestException('Proof of address is required.');

    // A resubmission after rejection starts a fresh review — stale rejection
    // data must not follow it into the admin queue.
    return KycStore.update(userId, {
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

    const all = await Promise.all(
      KycStore.findAll().map(async (sub) => {
        const user = await UsersStore.findById(sub.userId);
        return {
          ...sub,
          user: user
            ? { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName }
            : null,
        };
      }),
    );

    // Tab counts are computed over the FULL set so the UI stays correct
    // regardless of the active filter.
    const counts: Record<string, number> = { all: all.length };
    for (const sub of all) counts[sub.status] = (counts[sub.status] ?? 0) + 1;

    let list = all;
    if (filter.status) list = list.filter((sub) => sub.status === filter.status);
    if (filter.q) {
      const q = filter.q.toLowerCase();
      list = list.filter(
        (sub) =>
          sub.user &&
          (sub.user.email.toLowerCase().includes(q) ||
            sub.user.firstName.toLowerCase().includes(q) ||
            sub.user.lastName.toLowerCase().includes(q)),
      );
    }

    list.sort((a, b) => (b.submittedAt?.getTime() ?? 0) - (a.submittedAt?.getTime() ?? 0));
    return {
      items: list.slice((page - 1) * limit, page * limit),
      total: list.length,
      page,
      limit,
      counts,
    };
  }

  // ─── Admin: get one ────────────────────────────────────────────────────────
  async getByUserId(userId: string) {
    const submission = KycStore.findByUserId(userId);
    if (!submission) throw new NotFoundException('KYC submission not found.');
    const user = await UsersStore.findById(userId);
    return { ...submission, user };
  }

  // ─── Admin: approve ────────────────────────────────────────────────────────
  async approve(userId: string, adminId: string) {
    const submission = KycStore.findByUserId(userId);
    if (!submission) throw new NotFoundException('KYC submission not found.');

    KycStore.update(userId, {
      status: 'approved',
      reviewedBy: adminId,
      reviewedAt: new Date(),
    });

    await UsersStore.update(userId, { verificationLevel: 1 });

    const user = await UsersStore.findById(userId);
    if (user) {
      // Sent inline per ARCH §8.5 — fire-and-forget, failure is logged by EmailService
      void this.email.sendKycDecisionEmail(user.email, user.firstName, 'approved');
    }
    console.log(`✅ KYC approved for user ${userId} by admin ${adminId}`);
    return this.getByUserId(userId);
  }

  // ─── Admin: claim for review ───────────────────────────────────────────────
  // Marks a submitted KYC as under_review by this admin, so two reviewers
  // don't process the same submission concurrently.
  claim(userId: string, adminId: string) {
    const submission = KycStore.findByUserId(userId);
    if (!submission) throw new NotFoundException('KYC submission not found.');
    if (submission.status !== 'submitted') {
      throw new BadRequestException(
        submission.status === 'under_review'
          ? 'This submission is already being reviewed.'
          : 'Only submitted KYC can be claimed for review.',
      );
    }
    KycStore.update(userId, { status: 'under_review', reviewedBy: adminId });
    return this.getByUserId(userId);
  }

  // ─── Admin: reject ─────────────────────────────────────────────────────────
  async reject(userId: string, adminId: string, reason: string, rejectedFields: string[] = []) {
    const submission = KycStore.findByUserId(userId);
    if (!submission) throw new NotFoundException('KYC submission not found.');
    const user = await UsersStore.findById(userId);

    KycStore.update(userId, {
      status: 'rejected',
      rejectionReason: reason,
      rejectedFields: rejectedFields,
      reviewedBy: adminId,
      reviewedAt: new Date(),
    });

    if (user) {
      // Sent inline per FR-ADM-03 — the client is emailed the reason and can retry
      void this.email.sendKycDecisionEmail(user.email, user.firstName, 'rejected', reason, rejectedFields);
    }

    return this.getByUserId(userId);
  }

  // ─── Reset User KYC ────────────────────────────────────────────────────────
  resetKyc(userId: string) {
    KycStore.resetUser(userId);
    return { message: 'KYC data reset successfully.' };
  }

  // ─── Reset All KYC Submissions ──────────────────────────────────────────────
  resetAllKyc() {
    KycStore.clearAll();
    if (existsSync('./uploads/kyc')) {
      try {
        const files = readdirSync('./uploads/kyc');
        for (const file of files) {
          try { unlinkSync(`./uploads/kyc/${file}`); } catch {}
        }
      } catch {}
    }
    return { message: 'All KYC submissions and uploaded files cleared successfully.' };
  }
}

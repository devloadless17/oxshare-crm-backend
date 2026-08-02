import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { KycStore, KycStatus } from '../../store/kyc.store';
import { UsersStore } from '../../store/users.store';

@Injectable()
export class KycService {
  // ─── Get status ────────────────────────────────────────────────────────────
  getStatus(userId: string) {
    const submission = KycStore.getOrCreate(userId);
    const user = UsersStore.findById(userId);
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

    if (step === 'personal') patch['personalInfo'] = data;
    else if (step === 'document') patch['document'] = data;
    else if (step === 'selfie') patch['selfie'] = data;
    else if (step === 'address') patch['addressProof'] = data;
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
    } else if (field === 'address_proof') {
      KycStore.update(userId, {
        addressProof: { ...submission.addressProof, filePath, fileName, docType: submission.addressProof?.docType ?? 'utility_bill' },
      });
    } else {
      throw new BadRequestException(`Unknown file field: ${field}`);
    }

    return { message: 'File uploaded.', field, fileName };
  }

  // ─── Submit KYC ────────────────────────────────────────────────────────────
  submit(userId: string) {
    const submission = KycStore.getOrCreate(userId);

    if (!submission.personalInfo)
      throw new BadRequestException('Personal information is required before submitting.');
    if (!submission.document?.frontFilePath)
      throw new BadRequestException('ID document front is required.');
    if (!submission.selfie?.filePath)
      throw new BadRequestException('Selfie is required.');
    if (!submission.addressProof?.filePath)
      throw new BadRequestException('Proof of address is required.');

    return KycStore.update(userId, {
      status: 'submitted',
      submittedAt: new Date(),
    });
  }

  // ─── Admin: list all ───────────────────────────────────────────────────────
  listAll(status?: KycStatus) {
    const all = status ? KycStore.findByStatus(status) : KycStore.findAll();
    return all.map((sub) => {
      const user = UsersStore.findById(sub.userId);
      return {
        ...sub,
        user: user
          ? { id: user.id, email: user.email, firstName: user.firstName, lastName: user.lastName }
          : null,
      };
    });
  }

  // ─── Admin: get one ────────────────────────────────────────────────────────
  getByUserId(userId: string) {
    const submission = KycStore.findByUserId(userId);
    if (!submission) throw new NotFoundException('KYC submission not found.');
    const user = UsersStore.findById(userId);
    return { ...submission, user };
  }

  // ─── Admin: approve ────────────────────────────────────────────────────────
  approve(userId: string, adminId: string) {
    const submission = KycStore.findByUserId(userId);
    if (!submission) throw new NotFoundException('KYC submission not found.');

    KycStore.update(userId, {
      status: 'approved',
      reviewedBy: adminId,
      reviewedAt: new Date(),
    });

    UsersStore.update(userId, { verificationLevel: 1 });

    console.log(`✅ KYC approved for user ${userId} by admin ${adminId}`);
    return { message: 'KYC approved. User verification level updated to 1.' };
  }

  // ─── Admin: reject ─────────────────────────────────────────────────────────
  reject(userId: string, adminId: string, reason: string) {
    const submission = KycStore.findByUserId(userId);
    if (!submission) throw new NotFoundException('KYC submission not found.');

    KycStore.update(userId, {
      status: 'rejected',
      rejectionReason: reason,
      reviewedBy: adminId,
      reviewedAt: new Date(),
    });

    console.log(`❌ KYC rejected for user ${userId} — reason: ${reason}`);
    return { message: 'KYC rejected.', reason };
  }
}

import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Body,
  Param,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ComplianceService } from './compliance.service';

@Controller('compliance')
export class ComplianceController {
  constructor(private readonly complianceService: ComplianceService) {}

  // --- Dynamic KYC Fields ---

  @Get('fields')
  async getFields(@Query('active') active?: string) {
    return this.complianceService.getFields(active === 'true');
  }

  @Post('fields')
  async createField(
    @Body()
    dto: {
      fieldName: string;
      label: string;
      fieldType: 'text' | 'number' | 'select' | 'file' | 'date' | 'checkbox';
      options?: string[];
      isRequired?: boolean;
      isActive?: boolean;
      sortOrder?: number;
    },
  ) {
    return this.complianceService.createField(dto);
  }

  @Put('fields/:id')
  async updateField(
    @Param('id') id: string,
    @Body() dto: any,
  ) {
    return this.complianceService.updateField(id, dto);
  }

  @Delete('fields/:id')
  async deleteField(@Param('id') id: string) {
    return this.complianceService.deleteField(id);
  }

  // --- Submissions & Reviews ---

  @Post('submit')
  async submitKyc(
    @Body() dto: { userId: string; values: any[] },
  ) {
    return this.complianceService.submitKyc(dto.userId, dto.values);
  }

  @Get('status/:userId')
  async getStatus(@Param('userId') userId: string) {
    return this.complianceService.getSubmissionStatus(userId);
  }

  @Get('submissions')
  async getAllSubmissions() {
    return this.complianceService.getAllSubmissions();
  }

  @Put('submissions/:id/review')
  async reviewSubmission(
    @Param('id') id: string,
    @Body() dto: { adminId?: string; status: 'APPROVED' | 'REJECTED' | 'CHANGES_REQUESTED'; rejectionReason?: string },
  ) {
    return this.complianceService.reviewSubmission(id, dto.adminId || '', dto);
  }
}

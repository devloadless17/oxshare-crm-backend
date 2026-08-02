import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  Param,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { AdminService } from './admin.service';

@Controller('admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('permissions')
  getPermissionsCatalog() {
    return this.adminService.getPermissionsCatalog();
  }

  @Get('roles')
  getRoles() {
    return this.adminService.getRoles();
  }

  @Post('roles')
  createRole(
    @Body() dto: { name: string; description?: string; permissions: string[] },
  ) {
    return this.adminService.createRole(dto);
  }

  @Put('roles/:id')
  updateRole(
    @Param('id') id: string,
    @Body() dto: { name?: string; description?: string; permissions?: string[] },
  ) {
    return this.adminService.updateRole(id, dto);
  }

  @Get('users')
  getAdminUsers() {
    return this.adminService.getAdminUsers();
  }

  @Post('users')
  addAdminUser(
    @Body()
    dto: {
      email: string;
      password: string;
      firstName: string;
      lastName: string;
      roleId?: string;
    },
  ) {
    return this.adminService.addAdminUser(dto);
  }
}

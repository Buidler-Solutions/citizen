import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { AdminAuthGuard } from './admin-auth.guard';
import { AdminAuthService } from './admin-auth.service';
import { UpsertSectionPayload, WhitepaperService } from './whitepaper.service';

type LoginPayload = {
  password?: string;
};

@Controller('admin')
export class AdminWhitepaperController {
  constructor(
    private readonly adminAuthService: AdminAuthService,
    private readonly whitepaperService: WhitepaperService,
  ) {}

  @Post('login')
  login(@Body() payload: LoginPayload) {
    if (!payload.password) {
      throw new BadRequestException('Password is required');
    }

    return {
      data: this.adminAuthService.login(payload.password),
    };
  }

  @UseGuards(AdminAuthGuard)
  @Post('whitepaper/sections')
  createSection(@Body() payload: UpsertSectionPayload) {
    return this.whitepaperService.createSection(payload).then((section) => ({ data: section }));
  }

  @UseGuards(AdminAuthGuard)
  @Patch('whitepaper/sections/:id')
  updateSection(@Param('id') id: string, @Body() payload: Partial<UpsertSectionPayload>) {
    return this.whitepaperService.updateSection(id, payload).then((section) => ({ data: section }));
  }

  @UseGuards(AdminAuthGuard)
  @Delete('whitepaper/sections/:id')
  deleteSection(@Param('id') id: string) {
    return this.whitepaperService.deleteSection(id).then((result) => ({ data: result }));
  }
}

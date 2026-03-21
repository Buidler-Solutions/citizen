import { Body, Controller, ForbiddenException, Get, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../jwt-auth.guard';
import { CreateOnboardingUserDto } from './dto/create-onboarding-user.dto';
import { UserService } from './user.service';

interface AuthenticatedRequest {
  user?: {
    sub?: string;
    role?: string;
  };
}

@Controller('users')
@UseGuards(JwtAuthGuard)
export class UserController {
  constructor(private readonly userService: UserService) {}

  @Get()
  listUsers() {
    return this.userService.listUsers();
  }

  @Post()
  async createUser(@Body() payload: CreateOnboardingUserDto, @Req() request: AuthenticatedRequest) {
    if (request.user?.role !== 'super_admin') {
      throw new ForbiddenException('Only super admins can create onboarding users.');
    }

    return this.userService.createUser(payload);
  }
}

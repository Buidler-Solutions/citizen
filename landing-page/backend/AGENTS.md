# AGENTS.md - Backend Development Guide

## Project Overview

NestJS backend for the citizen landing page application. Built with TypeScript, PostgreSQL, and TypeORM.

## Essential Commands

```bash
# Install dependencies
npm ci

# Build the project
npm run build

# Start production server
npm run start

# Start development server with hot reload
npm run start:dev

# Lint TypeScript files (fails if warnings present)
npm run lint
```

## Environment Variables

Required environment variables (see `.env.example`):

```bash
# Server
PORT=3001
CORS_ORIGIN=http://localhost:3000

# Database (PostgreSQL)
DB_HOST=localhost
DB_PORT=5432
DB_USER=citizen
DB_PASSWORD=citizen
DB_NAME=citizen_landing

# Authentication
JWT_SECRET=change-me-in-production
JWT_EXPIRES_IN=1d
JWT_ADMIN_KEY=change-me-admin-key
```

## Code Organization

```
src/
├── main.ts                    # Application bootstrap
├── app.module.ts             # Root module (TypeORM, Config)
├── auth.module.ts            # JWT configuration
├── auth.controller.ts        # Token generation endpoint
├── jwt-auth.guard.ts         # JWT authentication guard
└── lead/                     # Feature module example
    ├── lead.module.ts        # Module definition
    ├── lead.controller.ts    # HTTP endpoints
    ├── lead.service.ts       # Business logic
    ├── lead.entity.ts        # Database entity
    └── dto/
        └── create-lead.dto.ts # Data transfer object
```

## Module Pattern

Each feature follows this structure:

1. **Module** (`*Module.ts`): Imports TypeOrmModule.forFeature, declares providers/controllers
2. **Entity** (`*.entity.ts`): TypeORM entity with @Entity decorator (custom table name)
3. **DTO** (`dto/*.dto.ts`): class-validator decorators, use `!` for definite assignment
4. **Service** (`*.service.ts`): Business logic with @InjectRepository
5. **Controller** (`*.controller.ts`): HTTP endpoints with @Controller decorator

## Naming Conventions

- **Controllers**: `*Controller` (e.g., `LeadController`)
- **Services**: `*Service` (e.g., `LeadService`)
- **Modules**: `*Module` (e.g., `LeadModule`)
- **Entities**: `*Entity` (e.g., `LeadInterest`)
- **DTOs**: `*Dto` in `dto/` subdirectory (e.g., `CreateLeadDto`)
- **Guards**: `*Guard` (e.g., `JwtAuthGuard`)
- **Database Tables**: Custom names in @Entity decorator (snake_case, e.g., `interest_submissions`)

## Code Patterns

### Entity Definition

```typescript
@Entity({ name: 'table_name' })
export class ExampleEntity {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ length: 180 })
  name!: string;

  @CreateDateColumn()
  createdAt!: Date;
}
```

### Service with TypeORM

```typescript
@Injectable()
export class ExampleService {
  constructor(
    @InjectRepository(ExampleEntity)
    private readonly repository: Repository<ExampleEntity>,
  ) {}

  async create(payload: CreateDto): Promise<ExampleEntity> {
    const entity = this.repository.create(payload);
    return this.repository.save(entity);
  }
}
```

### DTO Validation

```typescript
import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

export class CreateDto {
  @IsString()
  @MinLength(2)
  @MaxLength(180)
  field!: string;

  @IsEmail()
  @MaxLength(180)
  email!: string;
}
```

### Controller with Authentication

```typescript
@Controller('resource')
export class ExampleController {
  @Post()
  create(@Body() payload: CreateDto) {
    return this.service.create(payload);
  }

  @UseGuards(JwtAuthGuard)
  @Get('stats')
  stats() {
    return this.service.stats();
  }
}
```

### Module Registration

```typescript
@Module({
  imports: [TypeOrmModule.forFeature([ExampleEntity])],
  providers: [ExampleService],
  controllers: [ExampleController],
})
export class ExampleModule {}
```

## Configuration

### Global Settings (main.ts)

- **CORS**: Enabled for configurable origins, credentials supported
- **ValidationPipe**: Global validation with `whitelist: true`, `transform: true`, `forbidNonWhitelisted: true`

### Database Configuration (app.module.ts)

- **ORM**: TypeORM with PostgreSQL
- **Entities**: Auto-load enabled
- **Synchronization**: `true` (auto-create tables)
- **Connection**: Async via ConfigService

### TypeScript Configuration

- **Strict mode**: Enabled
- **Decorators**: `emitDecoratorMetadata: true`, `experimentalDecorators: true`
- **Target**: ES2021
- **Output**: `./dist`

## Authentication

### JWT Implementation

- **Guard**: `JwtAuthGuard` validates Bearer tokens from `Authorization` header
- **Token Generation**: `POST /auth/token` with admin key
- **Payload Structure**: `{ sub: string, role: string }`

### Protecting Routes

```typescript
@UseGuards(JwtAuthGuard)
@Get('protected')
protectedRoute() {
  // request.user contains decoded JWT payload
}
```

## Linting

- **Tool**: ESLint with @typescript-eslint
- **Configuration**: `eslint.config.mjs`
- **Rules**: Recommended TypeScript rules
- **Ignores**: `dist/`, `node_modules/`
- **Strict**: `max-warnings=0`

## Deployment

### Docker

- **Base Image**: `node:20-alpine`
- **Port**: 3001
- **Build**: `npm ci && npm run build`
- **Command**: `npm run start`

### Dockerfile Usage

```bash
docker build -t citizen-landing-backend .
docker run -p 3001:3001 --env-file .env citizen-landing-backend
```

## Gotchas

1. **Definite Assignment**: All entity and DTO properties use `!` assertion (TypeScript strict mode)
2. **Repository Injection**: Must use `@InjectRepository(Entity)` decorator in services
3. **Global Config**: `ConfigModule.forRoot({ isGlobal: true })` allows access anywhere
4. **DTO Validation**: ValidationPipe transforms and validates, removing non-whitelisted properties
5. **CORS Origin**: Must be configured in env var, defaults to localhost:3000
6. **Database Sync**: Synchronize is enabled, avoid in production for schema stability
7. **No Tests**: No test files exist in the codebase
8. **Admin Key**: JWT tokens require `JWT_ADMIN_KEY` to generate (admin-only endpoint)

## Dependencies

- **@nestjs/core**: v10.4.2
- **@nestjs/common**: v10.4.2
- **@nestjs/typeorm**: v10.0.2
- **@nestjs/jwt**: v10.2.0
- **@nestjs/config**: v3.2.3
- **typeorm**: v0.3.20
- **pg**: v8.13.0
- **class-validator**: v0.14.1
- **class-transformer**: v0.5.1

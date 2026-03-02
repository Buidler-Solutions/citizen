# Admin Console Sample Credentials (Local Development)

Use these credentials only for local development/testing of the Whitepaper Admin Console.

## Sample Login

- **Admin route:** `http://localhost:3000/admin`
- **Backend login endpoint:** `POST http://localhost:4000/admin/login`
- **Admin password:** `CitizenAdmin123!`

## Required Environment Setup

### Backend (`whitepaper/backend/.env`)

```env
WHITEPAPER_ADMIN_PASSWORD=CitizenAdmin123!
WHITEPAPER_ADMIN_SECRET=replace-with-long-random-secret
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/citizen_whitepaper
CORS_ORIGIN=http://localhost:3000
PORT=4000
```

### Frontend (`whitepaper/frontend/.env.local`)

```env
NEXT_PUBLIC_WHITEPAPER_API_BASE_URL=http://localhost:4000
NEXT_PUBLIC_ASSET_BASE_URL=http://localhost:3000/frames
```

## Security Notes

- Rotate `WHITEPAPER_ADMIN_PASSWORD` and `WHITEPAPER_ADMIN_SECRET` before any shared/staging/production deployment.
- Never commit real credentials to source control.
- Keep this sample as a bootstrap reference only.

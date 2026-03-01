# Runbook: Upload Asciinema to Admin Console and Use Shortcode in Onboarding

This runbook describes the operational flow after you have created a `.cast` file.

## 1) Preconditions

- Frontend running at `http://localhost:3000`
- Backend running at `http://localhost:3001`
- Admin JWT token available via `/auth/token`
- A local cast file (example: `onboarding-demo.cast`)

## 2) Upload Recording in Admin Console Storage

1. Open the admin dashboard:
   - `http://localhost:3000/admin/dashboard/asciinema-storage`
2. In **Add or replace recording**, set a shortcode token.
3. Select your `.cast` (or `.json`) file.
4. Click **Upload recording**.
5. Wait for the success message.

What happens internally:
- Frontend posts `multipart/form-data` to:
  - `POST /interest/asciinema-recordings/upload`
- Request field name is `castFile`.
- `shortcode` (and optional `label`) are sent in the same multipart request.
- Backend stores files under `uploads/casts` and saves mapping in dedicated Asciinema storage.

## 3) Configure and Reuse Shortcodes

Set a stable shortcode token, for example:

```text
onboarding-demo
```

The onboarding frontend resolves this token using the storage mapping:

```text
shortcode -> uploaded cast URL
```

If you upload again with the same shortcode, the existing storage record is replaced.

## 4) Use the Shortcode in Onboarding Content

Add the shortcode token to onboarding intro content (title or body) using this format:

```text
[asciinema:onboarding-demo]
```

Notes:
- Only the token is required in content.
- The frontend strips the shortcode text from visible copy and uses it to load the recording modal source.

## 5) Validate End-to-End

1. Open the landing page (`/`).
2. Start onboarding flow until the intro card containing the shortcode is active.
3. Open the recording modal.
4. Confirm the cast plays.

If playback fails:
- Confirm upload succeeded.
- Confirm shortcode in content matches the saved storage record exactly.
- Confirm backend static file URL is reachable.

## 6) API-Only Fallback (No UI)

If needed, upload with curl using a valid admin bearer token:

```bash
curl -X POST http://localhost:3001/interest/asciinema-recordings/upload \
  -H "Authorization: Bearer <accessToken>" \
  -F "shortcode=onboarding-demo" \
  -F "label=Watch terminal demo" \
  -F "castFile=@onboarding-demo.cast"
```

To fetch the public onboarding shortcode map:

```bash
curl http://localhost:3001/interest/asciinema-recordings/public
```

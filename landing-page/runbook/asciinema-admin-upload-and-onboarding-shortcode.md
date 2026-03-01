# Runbook: Upload Asciinema to Admin Console and Use Shortcode in Onboarding

This runbook describes the operational flow after you have created a `.cast` file.

## 1) Preconditions

- Frontend running at `http://localhost:3000`
- Backend running at `http://localhost:3001`
- Admin JWT token available via `/auth/token`
- A local cast file (example: `onboarding-demo.cast`)

## 2) Upload Recording in Admin Console

1. Open the admin dashboard:
   - `http://localhost:3000/admin/dashboard/form-settings`
2. In the Asciinema section, select your `.cast` file.
3. Click the upload action.
4. Wait for the success message (`Cast file uploaded successfully!`).

What happens internally:
- Frontend posts `multipart/form-data` to:
  - `POST /interest/form-settings/asciinema-upload`
- Request field name is `castFile`.
- Backend stores files under `uploads/casts` and saves the resulting URL in form settings.

## 3) Configure the Shortcode Key

In **Form Settings**, set `Asciinema shortcode` to a stable token, for example:

```text
onboarding-demo
```

Then click **Save Settings**.

The onboarding frontend resolves this token using the current mapping:

```text
shortcode -> uploaded cast URL
```

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
- Confirm shortcode in content matches the saved form setting exactly.
- Confirm backend static file URL is reachable.

## 6) API-Only Fallback (No UI)

If needed, upload with curl using a valid admin bearer token:

```bash
curl -X POST http://localhost:3001/interest/form-settings/asciinema-upload \
  -H "Authorization: Bearer <accessToken>" \
  -F "castFile=@onboarding-demo.cast"
```

Then update form settings with the desired shortcode:

```bash
curl -X PUT http://localhost:3001/interest/form-settings \
  -H "Authorization: Bearer <accessToken>" \
  -H "Content-Type: application/json" \
  -d '{
    "title":"Build Public Truth with Citizen",
    "subtitle":"Validator · Builder · Observer onboarding",
    "roles":[],
    "asciinemaShortcode":"onboarding-demo"
  }'
```

> When using the API directly, provide your current roles array instead of `[]` to avoid replacing configured roles.

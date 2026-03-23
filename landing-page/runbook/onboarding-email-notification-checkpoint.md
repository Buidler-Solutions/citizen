# Onboarding Site Email Notification Checkpoint

## Purpose

This checkpoint translates the reusable transactional email architecture described in the mailing-system review into the **Citizen landing-page onboarding site**. The goal is to give the onboarding stack a clear implementation target for:

- forgot-password emails for onboarding console users,
- confirmation emails after a public onboarding form submission,
- admin/internal notifications for new onboarding interest submissions,
- outbound onboarding update emails to users already captured in the system.

This document is implementation-aware: it starts from the current landing-page codebase instead of assuming a blank project.

---

## Current landing-page baseline

Today, the landing-page stack already has the core business flows that email notifications should attach to:

1. **Public onboarding interest capture exists.** `POST /interest` persists a `LeadInterest` record with `fullName`, `institution`, `email`, `country`, and `missionNeed`. Duplicate emails are rejected. This gives us a durable record to attach notifications to.
2. **Configurable onboarding messaging already exists.** `FormSettings` stores role options and thank-you copy for Validator, Builder, and Observer onboarding, so email templates should align with those role-specific journeys.
3. **Onboarding console users already exist.** `OnboardingUser` records, admin login, and JWT issuance are already implemented, so forgot-password should extend this user system rather than introducing a separate auth store.
4. **The admin dashboard already reviews applicants manually.** That means admin notifications should complement the current workflow, not replace it.

In short: the landing page already has submissions, users, admin access, and role-aware onboarding content. What it lacks is a centralized email subsystem and notification workflows.

---

## Implementation status checklist

Use this checklist as the handoff between the work already merged and the next implementation slice.

### Completed in the current codebase

- [x] Added a backend `mail` module with SMTP settings storage, template storage, admin email-management routes, and a shared delivery helper.
- [x] Added `smtp_settings` and `email_templates` entities and connected them through TypeORM-backed services.
- [x] Added code-default templates for `onboardingSubmissionConfirmation` and `onboardingSubmissionAdminNotification`, plus DB override support.
- [x] Added admin APIs for `GET/PUT /admin/email/smtp-settings`, `POST /admin/email/smtp-settings/test`, `GET /admin/email/templates`, `GET /admin/email/templates/:type`, `PUT /admin/email/templates/:type`, and `POST /admin/email/templates/:type/reset`.
- [x] Updated onboarding submissions to store an explicit `role` field instead of relying only on a mission-text prefix.
- [x] Wired `LeadService.create()` to send best-effort applicant confirmation and internal/admin notification emails after the submission is saved.
- [x] Updated the public onboarding form and admin applicants view to read/write the structured lead role.
- [x] Documented SMTP-related environment variables and surfaced the new admin email endpoints in the landing-page README.

### Still to do next

- [x] Add the forgot-password implementation for onboarding console users: `password_resets` entity, token hashing, expiry handling, `POST /auth/forgot-password`, and `POST /auth/reset-password`.
- [x] Add the remaining template defaults called out in this runbook, especially `forgotPassword`, `onboardingStatusUpdate`, and optional `onboardingUserWelcome`.
- [x] Add admin/backend support for outbound onboarding updates to existing applicants, including preview/send routes and audience selection.
- [x] Add an optional notification audit log such as `lead_notifications` for onboarding sends, including per-recipient status tracking and admin history review.
- [x] Add admin UI surfaces for SMTP settings, email template editing, and onboarding update composition in the dashboard.
- [ ] Install and validate the production SMTP transport dependency/configuration in the deployment environment so the shared delivery helper can use a real transporter instead of falling back to development logging when the SMTP transport package is unavailable.
- [ ] Decide whether recurring/bulk sends should stay synchronous for phase 1 or move behind a queue/job worker before broader operator use.

### Suggested next task order

1. Implement forgot-password end to end for `OnboardingUser`.
2. Add the onboarding update template + admin preview/send endpoints.
3. Add dashboard UI for SMTP/template management and onboarding broadcasts.
4. Add audit logging / queueing only after the core flows above are stable.

---

## Scope for the onboarding-site email system

This checkpoint targets **transactional email notifications**, not a bell icon or in-app inbox.

### In scope

- SMTP configuration and runtime resolution.
- Shared mail delivery helper.
- Database-backed editable email templates.
- Forgot-password token generation + email delivery.
- Public onboarding submission confirmation emails.
- Admin/internal notifications for new onboarding submissions.
- Bulk or targeted onboarding update emails for applicants already in the lead table.
- Admin APIs for SMTP settings, template editing, test sends, and update broadcasts.

### Out of scope for this checkpoint

- Browser push notifications.
- Mobile push.
- In-app unread notification center.
- Full marketing automation or campaign analytics.
- Background job infrastructure beyond noting where queueing would later fit.

---

## Target architecture for the landing page

The recommended design mirrors the reviewed mailing system, but is adapted to the landing-page modules.

### 1. Configuration layer

Add a dedicated SMTP configuration service that resolves the active relay configuration from:

1. database-stored `smtp_settings`,
2. environment variable fallback,
3. optional hard defaults for local development only.

This layer should support:

- host / port / secure,
- username / password,
- from address,
- optional reply-to,
- optional default audit BCC,
- rejectUnauthorized TLS flag,
- short-lived caching of resolved config.

### 2. Delivery layer

Create a shared `sendMail()` helper around Nodemailer that handles:

- transporter creation,
- transporter reuse keyed by config signature,
- sender resolution,
- TLS configuration,
- development-safe logging when SMTP is missing,
- optional audit BCC merging and deduplication.

### 3. Template layer

Centralize onboarding email templates in code + database storage.

Each template should have:

- `type`,
- `subject`,
- `html`,
- placeholder metadata,
- code defaults,
- DB overrides.

### 4. Trigger/workflow layer

Business events should call dedicated notification functions:

- onboarding user forgot password,
- onboarding form submitted,
- admin alerted about new lead,
- onboarding status/update sent to one or more leads,
- optional account-created email if onboarding users are created by super admins.

---

## Recommended data model additions

### 1. `smtp_settings`

Add a table for the active SMTP relay configuration.

Suggested fields:

- `id`
- `host`
- `port`
- `secure`
- `username`
- `password`
- `from_address`
- `reply_to`
- `default_bcc`
- `reject_unauthorized`
- `created_at`
- `updated_at`

### 2. `email_templates`

Add a table for editable onboarding email templates.

Suggested fields:

- `id`
- `type`
- `subject`
- `html`
- `created_at`
- `updated_at`

### 3. `password_resets`

Add a dedicated password reset table for onboarding console users.

Suggested fields:

- `id`
- `user_id`
- `email`
- `token_hash`
- `expires_at`
- `used_at` (nullable)
- `created_at`

This should store **hashed** reset tokens, not plaintext tokens.

### 4. Optional `lead_notifications`

If we want an audit trail for onboarding update sends, add a table such as `lead_notifications`.

Suggested fields:

- `id`
- `lead_id`
- `template_type`
- `recipient_email`
- `subject_snapshot`
- `status` (`queued`, `sent`, `failed`)
- `error_message` (nullable)
- `sent_at` (nullable)
- `created_at`

This is optional for phase 1, but strongly recommended if the onboarding program will send recurring updates.

---

## Template set for the onboarding site

These are the minimum template types recommended for this landing-page use case.

### 1. `forgotPassword`
Used when an onboarding console user requests a password reset.

**Variables**
- `full_name`
- `username`
- `reset_link`
- `expires_in`
- `support_email`
- `site_name`

### 2. `onboardingSubmissionConfirmation`
Sent to the public applicant after `POST /interest` succeeds.

**Variables**
- `full_name`
- `email`
- `institution`
- `country`
- `mission_need`
- `role_label`
- `thank_you_note`
- `site_name`
- `support_email`

### 3. `onboardingSubmissionAdminNotification`
Sent to the internal/admin contact when a new onboarding submission is created.

**Variables**
- `full_name`
- `email`
- `institution`
- `country`
- `mission_need`
- `role_label`
- `submitted_at`
- `admin_dashboard_link`
- `site_name`

### 4. `onboardingStatusUpdate`
Sent later when the team wants to update applicants about cohort status, review progress, eligibility checks, waitlist changes, or invitations.

**Variables**
- `full_name`
- `email`
- `role_label`
- `update_title`
- `update_body`
- `next_step`
- `cta_link`
- `site_name`
- `support_email`

### 5. Optional `onboardingUserWelcome`
Sent when a super admin creates a new onboarding console admin/user account.

**Variables**
- `full_name`
- `username`
- `temporary_password_notice`
- `login_link`
- `site_name`

---

## Workflow design by use case

## 1) Forgot password for onboarding console users

### Trigger
Add a public endpoint such as:

- `POST /auth/forgot-password`
- `POST /auth/reset-password`

### Proposed flow

1. Normalize the submitted username or email.
2. Resolve the onboarding user record.
3. If the account exists and is active, generate a random token.
4. Hash the token with SHA-256 before storing it.
5. Delete or invalidate previous reset rows for that user.
6. Store the new reset record with an explicit expiry.
7. Build the reset URL for the frontend reset page.
8. Render the `forgotPassword` template.
9. Send the email through `sendMail()`.
10. Return a generic success response to avoid disclosing account existence.

### Completion flow

1. Accept token + new password.
2. Find a valid unexpired reset record by comparing token hashes.
3. Reject used or expired tokens.
4. Update the user password hash.
5. Mark reset token used or delete it.
6. Optionally email a password-changed confirmation later.

### Notes for this repo

- Password hashing already exists in `UserService`, so reset completion should reuse the same password hashing implementation.
- This should extend `OnboardingUser`, not create a parallel auth user model.

---

## 2) Confirmation email after onboarding form submission

### Trigger
After `LeadService.create()` successfully saves the lead.

### Proposed flow

1. Validate and persist the lead first.
2. Resolve the role metadata from `FormSettings.roles` if role selection is part of the submitted payload or later added to the lead record.
3. Build template variables using the lead fields and the matching role thank-you note.
4. Render `onboardingSubmissionConfirmation`.
5. Send to the applicant email as a best-effort notification.
6. Do **not** roll back the saved submission if the email fails.

### Why this fits the landing page

The current landing page already promises that applicants will receive onboarding updates by email. A confirmation email makes that promise explicit and gives the user a durable receipt that their submission entered the process.

---

## 3) Internal/admin notification for a new onboarding submission

### Trigger
Also after `LeadService.create()` succeeds.

### Proposed flow

1. Persist the lead first.
2. Resolve admin recipients from:
   - SMTP `from_address`,
   - a configured support/contact email,
   - optional admin notification list.
3. Render `onboardingSubmissionAdminNotification`.
4. Send to one or more internal recipients.
5. Allow partial failure if there are multiple recipients.
6. Keep the lead creation successful even if admin email fails.

### Recommended recipient policy

Prefer a dedicated system/admin inbox rather than sending only to the SMTP sender identity. For example:

- `ONBOARDING_SUPPORT_EMAIL`
- `ONBOARDING_NOTIFICATION_EMAILS`
- or a DB-managed site setting later.

---

## 4) System updates to already-submitted onboarding users

### Trigger
An admin initiates an update from the dashboard or an admin API.

### Proposed endpoint ideas

- `POST /notifications/onboarding-updates/send`
- `POST /admin/notifications/preview`
- `POST /admin/notifications/test`

### Proposed flow

1. Admin selects one or more leads by segment:
   - all leads,
   - role type,
   - country,
   - date range,
   - individual selection.
2. Admin chooses the `onboardingStatusUpdate` template.
3. Admin fills update variables like `update_title`, `update_body`, `next_step`, and `cta_link`.
4. System renders individualized emails for each lead.
5. Sends mail in batches.
6. Logs per-recipient result.
7. Returns a send summary.

### Why this matters

This is the operational feature that turns the landing page into a real onboarding communications surface rather than just a lead capture form.

---

## Admin UI requirements

To match the maintainability of the reviewed system, add the following admin surfaces.

### 1. SMTP settings panel

Admins should be able to:

- view current host / port / sender settings,
- update SMTP credentials,
- choose TLS behavior,
- set default from / reply-to / audit BCC,
- send a test email.

### 2. Email template editor

Admins should be able to:

- load a template by type,
- edit subject and HTML,
- see allowed placeholders,
- preview sample rendering,
- reset to default.

### 3. Onboarding update composer

Admins should be able to:

- choose audience filters,
- compose update copy,
- preview the rendered email,
- send immediately,
- review delivery summary.

---

## Suggested module layout for this repo

A landing-page-friendly folder layout would look like this.

```text
landing-page/backend/src/
  mail/
    mail.module.ts
    mail.service.ts
    smtp-settings.entity.ts
    smtp-settings.service.ts
    email-template.entity.ts
    email-template.service.ts
    notification-log.entity.ts          # optional
  auth/
    password-reset.entity.ts
    auth-notification.service.ts
  notification/
    notification.module.ts
    notification.service.ts
    dto/
      send-onboarding-update.dto.ts
      smtp-settings.dto.ts
      email-template.dto.ts
```

Related frontend admin surfaces could live in:

```text
landing-page/frontend/components/
  admin/
    SMTPSettingsPanel.tsx
    EmailTemplatesPanel.tsx
    OnboardingUpdateComposer.tsx
```

---

## API checkpoint proposal

These are the minimum routes to add for phase 1.

### Public auth routes

- `POST /auth/forgot-password`
- `POST /auth/reset-password`

### Admin email-management routes

- `GET /admin/email/smtp-settings`
- `PUT /admin/email/smtp-settings`
- `POST /admin/email/smtp-settings/test`
- `GET /admin/email/templates/:type`
- `PUT /admin/email/templates/:type`
- `POST /admin/email/templates/:type/reset`
- `GET /admin/email/notifications/history`

### Admin onboarding update routes

- `POST /admin/notifications/onboarding-updates/preview`
- `POST /admin/notifications/onboarding-updates/send`

---

## Delivery and failure policy

For the onboarding site, the recommended delivery policy is:

### Must not block the main transaction

These should be **best effort** and should not fail the main action when email delivery fails:

- onboarding form submission confirmation,
- admin new-submission notification,
- optional onboarding user welcome email.

### May block based on product expectations

These are more tightly coupled to the user journey and can justify stricter handling:

- forgot-password request should fail early if no SMTP configuration exists in non-development environments,
- reset-password completion itself should not depend on email, only on token validity.

### Logging expectations

At minimum, log:

- template type,
- recipient,
- event name,
- success/failure,
- provider error message if any.

---

## Security and operations guidance

### Password reset security

- Store only hashed reset tokens.
- Use short expiries, such as 60 minutes.
- Invalidate previous tokens when issuing a new one.
- Return generic responses from forgot-password to reduce enumeration risk.
- Use the existing password hashing approach consistently.

### SMTP operations

- Support env fallback for local/dev bootstrapping.
- Cache the resolved SMTP configuration briefly.
- Rebuild the transporter when settings change.
- Make audit BCC configurable, not hard-coded.

### Template safety

- Start with simple placeholder replacement.
- Escape or sanitize carefully if richer templating is added later.
- Keep a code-default version of every template so the system can still send even if DB records are missing.

### Scalability note

For early onboarding traffic, inline request-cycle sending is acceptable. If the landing page scales or starts broadcasting many updates, move dispatch to a queue/worker model.

---

## Checkpoint implementation plan

### Phase 1: foundation

- Add `smtp_settings`, `email_templates`, and `password_resets` entities.
- Add SMTP resolution service with DB > env fallback.
- Add shared Nodemailer delivery service.
- Add default onboarding templates in code.
- Add placeholder renderer.

### Phase 2: auth notifications

- Add forgot-password and reset-password routes.
- Add reset token creation/validation.
- Add forgot-password email sending.

### Phase 3: lead notifications

- Send applicant confirmation email after `LeadService.create()` succeeds.
- Send admin new-submission alert after lead creation.
- Add configuration for support/admin recipient addresses.

### Phase 4: admin operations

- Add SMTP admin endpoints.
- Add email template admin endpoints.
- Add test-send endpoint.
- Add dashboard UI panels.

### Phase 5: onboarding updates

- Add update-composer API and UI.
- Add optional notification audit log.
- Add filtered delivery to applicant segments.

---

## Definition of done for this checkpoint

The onboarding-site email system should be considered implemented when all of the following are true:

- Admins can configure SMTP without redeploying.
- Admins can edit onboarding email templates without code changes.
- Onboarding console users can request and complete password resets through email.
- Public onboarding applicants receive a confirmation email after successful submission.
- Internal admins receive a notification when a new onboarding submission is created.
- Admins can send onboarding status updates to selected applicants.
- Delivery behavior and failures are logged in a way that is operable by the team.

---

## Bottom line

For the landing-page onboarding site, the right replication of the reviewed mailing system is:

> **centralized SMTP settings + centralized mail delivery + editable templates + event-specific notification services for forgot password, onboarding submission confirmation, admin alerts, and applicant updates.**

That design fits the landing page’s existing architecture, extends the current NestJS + Next.js onboarding stack cleanly, and turns the onboarding site into a maintainable transactional email system instead of a one-off form sender.

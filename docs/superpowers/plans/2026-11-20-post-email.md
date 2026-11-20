# CHJ Post Email Implementation Plan

Goal: Add a fixed-recipient notification without risking saved comments or disclosing post contents.
Architecture: Pages/D1 durable outbox + private service-bound email Worker; explicit off-by-default sending.
Spec: ../specs/2026-11-20-post-email-design.md

## Constraints
- No test email or enabled automatic sending before exact content approval per AGENTS.md.
- No unapproved DNS, paid service, credential or security-access changes.
- Preserve existing posts, moderation and public API shapes. No backfill notification.

## Tasks
- [x] Backend: real-SQL outbox schema/trigger, leased delivery via CHJ_EMAIL_NOTIFIER service, admin-only summary/retry, failure isolation and regression tests. Owned files preview/_worker.js, backend/comments-schema.sql, backend/notification-migration.sql, tests/comments-worker.test.mjs.
- [x] Notifier: standalone backend/email-notifier-worker.mjs with fixed recipient/content and configurable validated sender, disabled by default, tests/email-notifier.test.mjs. No public route; no credentials.
- [x] UI: notification status and bounded retry control in existing admin, without claiming inbox arrival. Update meaningful failure tests and operating docs.
- [x] Preview: simulated mail transport only; verify comment receipt on failure and admin status/cancel/error paths. Review and run tests.
- [x] Cloudflare: inspect sender/destination configuration, prepare exact required settings. Present final email and any essential configuration approval after implementation is reviewable.
- [ ] After approval: configure, deploy, send only approved test, confirm transport acceptance and delivery if accessible, enable automatic notification and record verification.

Preparation complete 2026-11-20:122 tests pass, private notifier and production Pages code deployed with sending OFF. D1 migration and servicebinding saved. DNS onboarding and exact mail-content approval remain pending; no email has been sent. See workspace chj-email-preparation-review.md and chj-email-approval.md.

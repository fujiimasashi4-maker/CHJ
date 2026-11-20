# CHJ Moderation Operations Implementation Plan

**Goal:** Make the existing post-review screen usable for production operations.

**Architecture:** Extend the existing Pages Worker and admin HTML/JS. Retain Access authorization, schema and public submission API.

**Tech Stack:** vanilla HTML/CSS/JS, Cloudflare D1/Access, Node built-in tests.

**Spec:** ../specs/2026-11-20-moderation-operations-design.md

## Constraints
- No new contracts, credentials, administrator grants, external notifications or DNS changes.
- Preserve existing posts and schema. Public responses must not include private moderation metadata.
- Preview and test before production deployment; use existing assigned external Chrome tabs.

## Review Focus
- HTML login response must not be treated as saved data.
- A stale review must not overwrite a newer decision.
- Counts and pagination must cover all posts rather than only current page.
- Untrusted text uses textContent; private photos remain authenticated.
- A failed refresh must not allow stale or mismatched-filter actions.

## Task 1: Backend
- [x] Add failing SQLite tests for authenticated counts, private-only review metadata and stale-state rejection.
- [x] Add admin-only counts and list metadata; compare expected_status and expected_moderated_at when supplied, preserving older API compatibility.
- [x] Verify backend suite, including existing Access and upload tests.

## Task 2: Admin UI
- [x] Add meaningful UI regressions for confirmation-before-save, cancellation, stale conflict, HTML login failure, and filter-load failure.
- [x] Add counts, state badges, news context, timestamps, login recovery and a review dialog with cancel/save.
- [x] Refresh counts after saves; invalidate list on filter failure; avoid replacing an open review automatically.
- [x] Check desktop and mobile preview using local in-memory D1 and simulated local-only Access.

## Task 3: Production
- [x] Review diff and run all meaningful tests.
- [x] Commit/push source and package only the production whitelist; preserve other files byte-for-byte.
- [x] Deploy via existing Cloudflare Direct Upload UI. Verify authenticated review screen, counts and non-public photo display.
- [x] Save screenshots and document the daily review procedure and verification limits.

Completed 2026-11-20. Production code 3795ef4; 35 tests pass; review and core smoke pass. Live authenticated counts, private photo and cancel verified. Actual pending post untouched; saves exercised in local browser/SQLite and tests. See workspace chj-moderation-production-review.md.

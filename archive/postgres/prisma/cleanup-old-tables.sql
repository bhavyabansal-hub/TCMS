-- HISTORICAL (2026-10-14): this script targets the pre-restructure PostgreSQL
-- era (PascalCase tables). TCMS now runs on MySQL 8.4; kept for archive only.
-- ============================================================================
-- TCMS — one-time cleanup for databases created from the OLD schema
-- (pre-restructure tables: PascalCase names with generic "id" primary keys).
--
-- ⚠️  THIS ERASES ALL TCMS DATA in the database you run it against.
--     Only run it if the current data is demo/sample data you can re-seed.
--
-- Usage (Neon SQL Editor, or any psql session on your TCMS database):
--   1. Run THIS file once.
--   2. Then run prisma/database-setup.sql (the new table structure).
--   3. Seed the demo data (or start using the app fresh).
--
-- Safe to run on an empty database — every statement is IF EXISTS.
-- Covers BOTH possible old namings so it works no matter which version
-- of the project created your tables.
-- ============================================================================

-- Old naming style A: Prisma defaults (quoted PascalCase, generic id PK)
DROP TABLE IF EXISTS "BugTestCaseLink"     CASCADE;
DROP TABLE IF EXISTS "TestCaseHistory"     CASCADE;
DROP TABLE IF EXISTS "ReviewEvent"         CASCADE;
DROP TABLE IF EXISTS "ReviewRequest"       CASCADE;
DROP TABLE IF EXISTS "ModuleReviewRequest" CASCADE;
DROP TABLE IF EXISTS "TestCase"            CASCADE;
DROP TABLE IF EXISTS "ModulePermission"    CASCADE;
DROP TABLE IF EXISTS "Module"              CASCADE;
DROP TABLE IF EXISTS "Notification"        CASCADE;
DROP TABLE IF EXISTS "ActivityLog"         CASCADE;
DROP TABLE IF EXISTS "TaskReport"          CASCADE;
DROP TABLE IF EXISTS "Bug"                 CASCADE;
DROP TABLE IF EXISTS "RefreshToken"        CASCADE;
DROP TABLE IF EXISTS "LoginAttempt"        CASCADE;
DROP TABLE IF EXISTS "RolePermission"      CASCADE;
DROP TABLE IF EXISTS "User"                CASCADE;

-- Old naming style B: snake_case tables from an earlier partial migration
DROP TABLE IF EXISTS bug_test_case_links    CASCADE;
DROP TABLE IF EXISTS test_case_history      CASCADE;
DROP TABLE IF EXISTS review_events          CASCADE;
DROP TABLE IF EXISTS review_requests        CASCADE;
DROP TABLE IF EXISTS module_review_requests CASCADE;
DROP TABLE IF EXISTS test_cases             CASCADE;
DROP TABLE IF EXISTS module_permissions     CASCADE;
DROP TABLE IF EXISTS modules                CASCADE;
DROP TABLE IF EXISTS notifications          CASCADE;
DROP TABLE IF EXISTS activity_logs          CASCADE;
DROP TABLE IF EXISTS task_reports           CASCADE;
DROP TABLE IF EXISTS bugs                   CASCADE;
DROP TABLE IF EXISTS refresh_tokens         CASCADE;
DROP TABLE IF EXISTS login_attempts         CASCADE;
DROP TABLE IF EXISTS role_permissions       CASCADE;
DROP TABLE IF EXISTS users                  CASCADE;

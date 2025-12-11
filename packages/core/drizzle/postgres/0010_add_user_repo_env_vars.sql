-- Add user_repo_env_vars table for per-user, per-repo environment variables (PostgreSQL)
-- This enables users to set personalized environment variables for specific repositories

CREATE TABLE "user_repo_env_vars" (
  "id" varchar(36) PRIMARY KEY NOT NULL,
  "user_id" varchar(36) NOT NULL REFERENCES "users"("user_id") ON DELETE CASCADE,
  "repo_id" varchar(36) NOT NULL REFERENCES "repos"("repo_id") ON DELETE CASCADE,
  "env_vars" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL
);

-- Composite unique constraint: one record per user + repo combination
CREATE UNIQUE INDEX "user_repo_env_vars_user_repo_unique" ON "user_repo_env_vars" ("user_id", "repo_id");
-- Index for user lookups (list all repos a user has env vars for)
CREATE INDEX "user_repo_env_vars_user_idx" ON "user_repo_env_vars" ("user_id");
-- Index for repo lookups (list all users who have env vars for a repo)
CREATE INDEX "user_repo_env_vars_repo_idx" ON "user_repo_env_vars" ("repo_id");

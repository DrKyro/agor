-- Add install_command column to worktrees (PostgreSQL)
ALTER TABLE "worktrees" ADD COLUMN "install_command" text;


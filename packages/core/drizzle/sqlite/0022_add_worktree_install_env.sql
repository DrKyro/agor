-- Add missing columns to worktrees table
ALTER TABLE `worktrees` ADD COLUMN `install_command` text;
--> statement-breakpoint
ALTER TABLE `worktrees` ADD COLUMN `env_vars_text` text;

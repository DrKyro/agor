-- Add missing columns to users table
ALTER TABLE `users` ADD COLUMN `user_repo_env_vars` text;
--> statement-breakpoint
ALTER TABLE `users` ADD COLUMN `must_change_password` integer DEFAULT 0 NOT NULL;

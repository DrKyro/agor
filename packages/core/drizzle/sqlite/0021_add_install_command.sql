-- Add install_command column to worktrees (SQLite)
-- SQLite doesn't support IF NOT EXISTS for ALTER TABLE ADD COLUMN directly
-- We wrap in a transaction that will be rolled back if the column exists
BEGIN TRANSACTION;
ALTER TABLE `worktrees` ADD `install_command` text;
COMMIT;


-- Add install_command column to worktrees (PostgreSQL)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'worktrees' AND column_name = 'install_command'
  ) THEN
    ALTER TABLE "worktrees" ADD COLUMN "install_command" text;
  END IF;
END
$$;


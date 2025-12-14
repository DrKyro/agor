-- Add env_vars_text column to worktrees (PostgreSQL)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'worktrees' AND column_name = 'env_vars_text'
  ) THEN
    ALTER TABLE "worktrees" ADD COLUMN "env_vars_text" text;
  END IF;
END
$$;
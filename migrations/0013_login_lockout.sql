-- Login lockout bookkeeping.
--
-- auth.ts counts consecutive failed sign-ins and locks an account for a few
-- minutes after too many, so a stolen password cannot be brute forced. These
-- columns are added idempotently: the migration runner skips an ALTER TABLE
-- when the column already exists.

ALTER TABLE users ADD COLUMN failed_login_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN locked_until TEXT;

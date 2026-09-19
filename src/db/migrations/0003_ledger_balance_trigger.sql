-- Enforce double-entry balance in the database, not in the application.
--
-- An entry whose debits do not equal its credits is money appearing from nowhere or
-- vanishing into it. An application-level check is bypassed by any code path that
-- writes lines directly — a fix-up script, a migration, a future module written in a
-- hurry. A constraint is not.
--
-- DEFERRABLE INITIALLY DEFERRED, so it runs at COMMIT. It has to: the lines of one
-- entry are inserted as separate rows and the entry is legitimately unbalanced in
-- between. Checking per statement would reject every entry at its first line.
--
-- FOR EACH ROW rather than FOR EACH STATEMENT, because a CONSTRAINT TRIGGER must be
-- row-level — which also rules out transition tables, hence OLD/NEW below.

CREATE OR REPLACE FUNCTION assert_ledger_entry_balances() RETURNS trigger AS $$
DECLARE
  target  uuid;
  debits  bigint;
  credits bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    target := OLD.entry_id;
  ELSE
    target := NEW.entry_id;
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN direction = 'debit'  THEN amount_paise ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_paise ELSE 0 END), 0)
  INTO debits, credits
  FROM ledger_lines
  WHERE entry_id = target;

  -- No lines left. Legitimate when the whole entry was deleted and the lines went with
  -- it; a bug when the entry is still there with nothing under it.
  IF debits = 0 AND credits = 0 THEN
    IF EXISTS (SELECT 1 FROM ledger_entries WHERE id = target) THEN
      RAISE EXCEPTION 'ledger entry % has no lines', target
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NULL;
  END IF;

  IF debits <> credits THEN
    RAISE EXCEPTION 'ledger entry % does not balance: debits %, credits %',
      target, debits, credits
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER ledger_lines_balance_insert
  AFTER INSERT ON ledger_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_entry_balances();
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER ledger_lines_balance_update
  AFTER UPDATE ON ledger_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_entry_balances();
--> statement-breakpoint

CREATE CONSTRAINT TRIGGER ledger_lines_balance_delete
  AFTER DELETE ON ledger_lines
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_entry_balances();

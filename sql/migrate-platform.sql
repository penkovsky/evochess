-- Adds `platform` to `events`, against a collector that already has the table.
-- Safe to re-run.
--
-- `default 'web'` is the truth, not a placeholder: every existing row came from
-- the browser, so there is nothing to backfill.
--
-- Apply BEFORE shipping any client that sends the column: the anon grant is
-- column-level, so without the grant the insert is rejected and telemetry
-- swallows it.

begin;

alter table public.events
  add column if not exists platform text not null default 'web';

grant insert (platform) on public.events to anon;

commit;

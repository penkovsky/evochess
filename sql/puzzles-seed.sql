-- Daily puzzle seed. One row per UTC day.

insert into public.puzzles (publish_date, param, mate_in, source_id, mate_san, solution) values
  ('2026-08-01', 'AQAABIECCAJAAFAHKzYQQAQAAuCJ-w', 4, 'puzzle-03', 'Nh3=R#', array['hxg4', 'Kg5', 'Rg7+', 'Kh6', 'g5=N', 'Kh5', 'Nh3=R#'])
on conflict (publish_date) do nothing;

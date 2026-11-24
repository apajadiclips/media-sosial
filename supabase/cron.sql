-- Jalankan SEKALI dalam Supabase Dashboard -> SQL Editor, selepas fungsi `api` di-deploy.
-- Gantikan GANTI_PROJECT_REF. Rahsia diambil dari Vault (nama: cron_secret), sama dengan rahsia CRON_SECRET fungsi:
--   select vault.create_secret('<CRON_SECRET>', 'cron_secret');
-- Ini memanggil fungsi setiap minit untuk menyiarkan hantaran yang tiba masanya.

select cron.unschedule('media-sosial-sender-tick')
where exists (select 1 from cron.job where jobname = 'media-sosial-sender-tick');

select cron.schedule(
  'media-sosial-sender-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://GANTI_PROJECT_REF.supabase.co/functions/v1/api/cron',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 10000
  );
  $$
);

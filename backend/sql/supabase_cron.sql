-- Drive AssetFlow's background jobs from Postgres instead of from the API process.
--
-- WHY: node-cron only fires while the API process is alive. A free host that sleeps
-- an idle web service runs no cron, so notifications and SLA escalations stop
-- silently. pg_cron lives in the database, which never sleeps, and pg_net makes the
-- HTTP call that both triggers the job and wakes the API.
--
-- Run this ONCE in the Supabase SQL editor. It is deliberately not part of
-- backend/migrations.js: CREATE EXTENSION is not something that should happen
-- implicitly every time the server boots.
--
-- Prerequisites on the API side:
--   DISABLE_INTERNAL_CRON=true      (stop the in-process schedules)
--   CRON_SECRET=<32+ random chars>  (same value as below)
--
-- Generate a secret with:  node -e "console.log(require('crypto').randomBytes(24).toString('base64url'))"

-- 1. Extensions. Supabase ships both; `extensions` is the schema it expects.
create extension if not exists pg_cron with schema extensions;
create extension if not exists pg_net with schema extensions;

-- 2. Keep the secret out of the job definition, which is world-readable in cron.job.
--    Supabase Vault encrypts it at rest.
select vault.create_secret(
  'REPLACE_WITH_YOUR_CRON_SECRET',
  'assetflow_cron_secret',
  'Shared secret for POST /api/internal/cron/* endpoints'
);

-- 3. A helper so the three jobs do not repeat the URL, headers and timeout.
--    timeout is generous on purpose: a sleeping free-tier host takes 30-60s to
--    cold start, and the first request of the day pays for the wake-up.
create or replace function public.assetflow_trigger_cron(job_path text)
returns bigint
language plpgsql
security definer
set search_path = public, extensions, vault
as $$
declare
  api_base text := 'https://REPLACE_WITH_YOUR_API_HOST';  -- no trailing slash
  secret   text;
  req_id   bigint;
begin
  select decrypted_secret into secret
  from vault.decrypted_secrets
  where name = 'assetflow_cron_secret';

  if secret is null then
    raise exception 'assetflow_cron_secret is not present in vault';
  end if;

  select net.http_post(
    url := api_base || '/api/internal/cron/' || job_path,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', secret
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 120000
  ) into req_id;

  return req_id;
end;
$$;

-- 4. The schedules, mirroring what node-cron used to run.
select cron.schedule('assetflow-daily-checks', '0 0 * * *',
  $$select public.assetflow_trigger_cron('daily-checks')$$);

select cron.schedule('assetflow-sla-checks', '0 * * * *',
  $$select public.assetflow_trigger_cron('sla-checks')$$);

select cron.schedule('assetflow-retry-failed', '*/15 * * * *',
  $$select public.assetflow_trigger_cron('retry-failed')$$);

-- ---------------------------------------------------------------------------
-- Verifying it works
-- ---------------------------------------------------------------------------
-- Trigger one by hand and read the response:
--   select public.assetflow_trigger_cron('sla-checks');
--   select id, status_code, content, error_msg, created
--     from net._http_response order by id desc limit 5;
--
-- A 401 means CRON_SECRET on the API does not match the vault secret.
-- A 409 means that job was already running.
-- A timeout with no status_code usually means the host was asleep and did not wake
-- inside 120s; the next scheduled run will find it warm.
--
-- Scheduled runs and their outcomes:
--   select * from cron.job;
--   select * from cron.job_run_details order by start_time desc limit 20;
--
-- To remove a schedule:
--   select cron.unschedule('assetflow-sla-checks');

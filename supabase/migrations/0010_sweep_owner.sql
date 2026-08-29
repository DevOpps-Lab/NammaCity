-- Owner-scoped SLA sweep, so reports with no logged-in owner still escalate.
--
-- `civic_sweep(p_now)` is `security invoker` and filters on `auth.uid()`, which
-- is exactly right for the app: the citizen's own session sweeps their own
-- ledger on a timer. But `auth.uid()` is NULL under the service-role client, so
-- the function is a silent no-op there.
--
-- That matters now that reports arrive over WhatsApp. Those are owned by the
-- shared intake account, which nobody ever logs into, so nothing would ever
-- move them from 'filed' to 'past_sla' to 'escalated'. They would sit at 'filed'
-- forever while their deadline receded — the one thing this product exists to
-- not let happen.
--
-- This is the same body with the owner passed in explicitly instead of read
-- from the session, and `security definer` so the webhook can call it. The
-- precedent is `verify_and_close(p_owner, ...)`, which takes an owner for the
-- same reason.
create or replace function public.civic_sweep_owner(p_owner uuid, p_now bigint)
returns table (id text, status text)
language plpgsql
security definer
set search_path = public
as $$
begin
  -- filed / acknowledged / transferred past the deadline -> past_sla
  with promoted as (
    update public.reports r
       set status = 'past_sla'
     where r.user_id = p_owner
       and r.status in ('filed', 'acknowledged', 'transferred')
       and p_now > r.sla_deadline
    returning r.id, r.user_id
  )
  insert into public.timeline_events (report_id, user_id, at, kind, detail)
  select p.id, p.user_id, p_now, 'past_sla',
         'SLA breached — authority missed its own published deadline'
    from promoted p;

  -- past_sla for 6h+ -> escalated
  with escalated as (
    update public.reports r
       set status = 'escalated',
           escalation_post_id = coalesce(r.escalation_post_id, 'post_' || r.id)
     where r.user_id = p_owner
       and r.status = 'past_sla'
       and p_now > r.sla_deadline + 6 * 3600000
    returning r.id, r.user_id
  )
  insert into public.timeline_events (report_id, user_id, at, kind, detail)
  select e.id, e.user_id, p_now, 'escalated', 'Published to the public ledger'
    from escalated e;

  return query
    select r.id, r.status
      from public.reports r
     where r.user_id = p_owner
       and r.status in ('past_sla', 'escalated');
end;
$$;

-- Not granted to anon or authenticated: it takes an owner as an argument, so a
-- signed-in caller could sweep somebody else's ledger. Only the service-role
-- client (which bypasses grants) is meant to call this; the app keeps using
-- `civic_sweep`, which is bounded by the caller's own session.
revoke execute on function public.civic_sweep_owner(uuid, bigint) from public;
revoke execute on function public.civic_sweep_owner(uuid, bigint) from anon;
revoke execute on function public.civic_sweep_owner(uuid, bigint) from authenticated;

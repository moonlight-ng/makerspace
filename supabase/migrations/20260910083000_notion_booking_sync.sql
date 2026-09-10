alter table public.makerspace_bookings
    add column if not exists notion_page_id text,
    add column if not exists notion_sync_status text not null default 'pending',
    add column if not exists notion_sync_version bigint not null default 1,
    add column if not exists notion_synced_version bigint not null default 0,
    add column if not exists notion_sync_attempts integer not null default 0,
    add column if not exists notion_sync_started_at timestamptz,
    add column if not exists notion_synced_at timestamptz,
    add column if not exists notion_sync_error text;

alter table public.makerspace_bookings
    drop constraint if exists makerspace_bookings_notion_sync_status_check;

alter table public.makerspace_bookings
    add constraint makerspace_bookings_notion_sync_status_check
    check (notion_sync_status in ('pending', 'processing', 'synced'));

create index if not exists makerspace_bookings_notion_sync_idx
    on public.makerspace_bookings (notion_sync_status, created_at);

create or replace function public.mark_makerspace_booking_for_notion_sync()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if row(
        old.class_slug,
        old.event_slug,
        old.session_date,
        old.session_period,
        old.customer_name,
        old.customer_email,
        old.quantity,
        old.status,
        old.expires_at
    ) is distinct from row(
        new.class_slug,
        new.event_slug,
        new.session_date,
        new.session_period,
        new.customer_name,
        new.customer_email,
        new.quantity,
        new.status,
        new.expires_at
    ) then
        new.notion_sync_status := 'pending';
        new.notion_sync_version := old.notion_sync_version + 1;
        new.notion_sync_started_at := null;
        new.notion_sync_error := null;
    end if;

    return new;
end;
$$;

drop trigger if exists makerspace_booking_notion_sync_trigger
on public.makerspace_bookings;

create trigger makerspace_booking_notion_sync_trigger
before update of
    class_slug,
    event_slug,
    session_date,
    session_period,
    customer_name,
    customer_email,
    quantity,
    status,
    expires_at
on public.makerspace_bookings
for each row
execute function public.mark_makerspace_booking_for_notion_sync();

create or replace function public.mark_makerspace_payment_for_notion_sync()
returns trigger
language plpgsql
set search_path = public
as $$
begin
    if tg_op = 'INSERT' then
        update public.makerspace_bookings
        set notion_sync_status = 'pending',
            notion_sync_version = notion_sync_version + 1,
            notion_sync_started_at = null,
            notion_sync_error = null
        where id = new.booking_id;
    elsif row(
            old.reference,
            old.environment,
            old.event_slug,
            old.customer_email,
            old.amount,
            old.currency,
            old.status,
            old.provider_status,
            old.paid_at
        ) is distinct from row(
            new.reference,
            new.environment,
            new.event_slug,
            new.customer_email,
            new.amount,
            new.currency,
            new.status,
            new.provider_status,
            new.paid_at
        ) then
        update public.makerspace_bookings
        set notion_sync_status = 'pending',
            notion_sync_version = notion_sync_version + 1,
            notion_sync_started_at = null,
            notion_sync_error = null
        where id = new.booking_id;
    end if;

    return new;
end;
$$;

drop trigger if exists makerspace_payment_notion_sync_trigger
on public.makerspace_payments;

create trigger makerspace_payment_notion_sync_trigger
after insert or update of
    reference,
    environment,
    event_slug,
    customer_email,
    amount,
    currency,
    status,
    provider_status,
    paid_at
on public.makerspace_payments
for each row
execute function public.mark_makerspace_payment_for_notion_sync();

create or replace function public.claim_makerspace_notion_sync(
    p_limit integer default 10,
    p_booking_id uuid default null
)
returns table (booking_id uuid, sync_version bigint)
language sql
security definer
set search_path = public
as $$
    with candidates as (
        select booking.id
        from public.makerspace_bookings as booking
        where (
            booking.notion_sync_status = 'pending'
            or (
                booking.notion_sync_status = 'processing'
                and booking.notion_sync_started_at < now() - interval '15 minutes'
            )
        )
          and (p_booking_id is null or booking.id = p_booking_id)
        order by booking.created_at
        limit greatest(1, least(coalesce(p_limit, 10), 25))
        for update skip locked
    )
    update public.makerspace_bookings as booking
    set notion_sync_status = 'processing',
        notion_sync_attempts = booking.notion_sync_attempts + 1,
        notion_sync_started_at = now()
    from candidates
    where booking.id = candidates.id
    returning booking.id as booking_id,
              booking.notion_sync_version as sync_version;
$$;

revoke all on function public.claim_makerspace_notion_sync(integer, uuid)
from public, anon, authenticated;

grant execute on function public.claim_makerspace_notion_sync(integer, uuid)
to service_role;

create or replace function public.list_makerspace_studio_orders(
    p_query text default null,
    p_status text default 'all',
    p_environment text default 'all',
    p_limit integer default 30,
    p_offset integer default 0
)
returns jsonb
language sql
stable
security invoker
set search_path = public
as $$
    with order_source as materialized (
        select
            booking.id as booking_id,
            booking.class_slug,
            booking.event_slug,
            booking.session_date,
            booking.session_period,
            booking.customer_name,
            booking.customer_email,
            booking.quantity,
            booking.status as booking_status,
            booking.expires_at,
            booking.created_at as booking_created_at,
            payment.provider,
            payment.reference,
            payment.environment,
            payment.amount,
            payment.currency,
            payment.status as payment_status,
            payment.provider_status,
            payment.provider_transaction_id,
            payment.paid_at,
            payment.verified_at,
            payment.created_at as payment_created_at,
            case
                when payment.status = 'success' or booking.status = 'paid' then 'paid'
                when booking.status = 'cancelled' then 'cancelled'
                when booking.status = 'reserved' and booking.expires_at <= now() then 'expired'
                when payment.status = 'failed' then 'failed'
                else 'pending'
            end as order_state
        from public.makerspace_bookings as booking
        join public.makerspace_payments as payment
          on payment.booking_id = booking.id
    ),
    filtered_orders as materialized (
        select *
        from order_source
        where (
                nullif(btrim(p_query), '') is null
                or customer_name ilike '%' || btrim(p_query) || '%'
                or customer_email ilike '%' || btrim(p_query) || '%'
                or booking_id::text ilike '%' || btrim(p_query) || '%'
                or reference ilike '%' || btrim(p_query) || '%'
                or coalesce(provider_transaction_id, '') ilike '%' || btrim(p_query) || '%'
                or class_slug ilike '%' || btrim(p_query) || '%'
                or event_slug ilike '%' || btrim(p_query) || '%'
                or session_date::text ilike '%' || btrim(p_query) || '%'
            )
          and (coalesce(p_status, 'all') = 'all' or order_state = p_status)
          and (coalesce(p_environment, 'all') = 'all' or environment = p_environment)
    ),
    page_rows as (
        select *
        from filtered_orders
        order by booking_created_at desc, booking_id desc
        limit greatest(1, least(coalesce(p_limit, 30), 100))
        offset greatest(0, coalesce(p_offset, 0))
    )
    select jsonb_build_object(
        'orders', coalesce(
            (
                select jsonb_agg(to_jsonb(page_rows) order by booking_created_at desc, booking_id desc)
                from page_rows
            ),
            '[]'::jsonb
        ),
        'total', (select count(*) from filtered_orders)
    );
$$;

revoke all on function public.list_makerspace_studio_orders(text, text, text, integer, integer)
from public, anon, authenticated;

grant execute on function public.list_makerspace_studio_orders(text, text, text, integer, integer)
to service_role;

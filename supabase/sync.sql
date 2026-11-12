-- AG Horizon sync: what the Supabase project needs. Run it once in the SQL editor (it is safe to run again).
--
-- The app never logs in. A sync code gives each group of computers a random vault id and an access token; the
-- server keeps the vault id, a SHA-256 of the token, and one encrypted blob per computer. It can't read the blobs:
-- the key never leaves the computers. The tables are closed to the public API key; everything goes through the
-- three functions below, which check the token.

create table if not exists public.sync_vault (
  id          text primary key check (id ~ '^[0-9a-f]{64}$'),
  token_hash  bytea not null,
  created_at  timestamptz not null default now(),
  last_seen   timestamptz not null default now()
);

create table if not exists public.sync_blob (
  vault_id    text not null references public.sync_vault (id) on delete cascade,
  device_id   text not null check (device_id ~ '^[0-9a-f]{16,32}$'),
  updated_at  timestamptz not null default now(),
  blob        bytea not null,
  primary key (vault_id, device_id)
);

-- Row level security on and no policies: the public (anon) key can't read or write the tables directly.
alter table public.sync_vault enable row level security;
alter table public.sync_blob enable row level security;
revoke all on public.sync_vault, public.sync_blob from anon, authenticated;

-- Which networks made a vault in the last day: a SHA-256 of the address only, deleted after a day.
create table if not exists public.sync_new_vault (
  net_hash    bytea not null,
  created_at  timestamptz not null default now()
);
alter table public.sync_new_vault enable row level security;
revoke all on public.sync_new_vault from anon, authenticated;

-- The caller's address as Supabase's proxy saw it. Not the first X-Forwarded-For entry: that's whatever the client
-- sent, and the real address is added after it. An IPv6 address counts as its /64, which one household usually has.
-- Null when called outside the API (the SQL editor) or the header can't be read.
create or replace function public.sync_client_net()
returns inet language plpgsql stable set search_path = public, pg_temp as $$
declare
  h json;
  ip inet;
begin
  h := current_setting('request.headers', true)::json;
  ip := coalesce(h->>'cf-connecting-ip', trim(split_part(h->>'x-forwarded-for', ',', -1)))::inet;
  return case when family(ip) = 6 then network(set_masklen(ip, 64)) else ip end;
exception when others then return null;
end $$;

-- Checks the token; creates the vault the first time its token is used. Returns nothing, raises 'denied'.
create or replace function public.sync_check(p_vault text, p_token text, p_create boolean)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
declare
  h bytea := sha256(convert_to(coalesce(p_token, ''), 'UTF8'));
  net inet;
  nh bytea;
begin
  if p_vault !~ '^[0-9a-f]{64}$' or p_token !~ '^[0-9a-f]{64}$' then raise exception 'denied'; end if;
  if p_create and not exists (select 1 from sync_vault where id = p_vault) then
    -- The public key is in the app, so anyone can make vaults. At most 5 a day per network, and 10 an hour in all,
    -- keeps a script from filling the database (10 × 10 computers × 256 KB = 25 MB an hour at worst).
    net := sync_client_net();
    if net is not null then
      nh := sha256(convert_to(net::text, 'UTF8'));
      delete from sync_new_vault where created_at < now() - interval '1 day';
      if (select count(*) from sync_new_vault where net_hash = nh) >= 5 then raise exception 'too many new codes'; end if;
      insert into sync_new_vault (net_hash) values (nh);
    end if;
    if (select count(*) from sync_vault where created_at > now() - interval '1 hour') >= 10 then raise exception 'busy'; end if;
    insert into sync_vault (id, token_hash) values (p_vault, h) on conflict (id) do nothing;
  end if;
  update sync_vault set last_seen = now() where id = p_vault and token_hash = h;
  if not found then raise exception 'denied'; end if;
end $$;

-- Save this computer's blob (base64). At most 10 computers per vault and 256 KB per blob (a heavy user's is ~80 KB).
create or replace function public.sync_put(p_vault text, p_token text, p_device text, p_blob text)
returns timestamptz language plpgsql security definer set search_path = public, pg_temp as $$
declare
  b bytea := decode(p_blob, 'base64');
  t timestamptz := clock_timestamp();
begin
  perform sync_check(p_vault, p_token, true);
  if p_device !~ '^[0-9a-f]{16,32}$' then raise exception 'bad device'; end if;
  if octet_length(b) > 262144 then raise exception 'too large'; end if;
  if not exists (select 1 from sync_blob where vault_id = p_vault and device_id = p_device)
     and (select count(*) from sync_blob where vault_id = p_vault) >= 10 then
    raise exception 'too many devices';
  end if;
  insert into sync_blob (vault_id, device_id, updated_at, blob) values (p_vault, p_device, t, b)
    on conflict (vault_id, device_id) do update set blob = excluded.blob, updated_at = excluded.updated_at;
  return t;
end $$;

-- Every computer's blob in the vault, or only those changed after p_since.
create or replace function public.sync_get(p_vault text, p_token text, p_since timestamptz default null)
returns table (device_id text, updated_at timestamptz, blob text)
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform sync_check(p_vault, p_token, false);
  return query
    select b.device_id, b.updated_at, encode(b.blob, 'base64')
    from sync_blob b
    where b.vault_id = p_vault and (p_since is null or b.updated_at > p_since)
    order by b.updated_at;
end $$;

-- Remove one computer's blob, or (p_device null) the whole vault.
create or replace function public.sync_delete(p_vault text, p_token text, p_device text default null)
returns void language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform sync_check(p_vault, p_token, false);
  if p_device is null then delete from sync_vault where id = p_vault;
  else delete from sync_blob where vault_id = p_vault and device_id = p_device;
  end if;
end $$;

revoke all on function public.sync_check(text, text, boolean), public.sync_client_net() from public, anon, authenticated;
revoke all on function public.sync_put(text, text, text, text), public.sync_get(text, text, timestamptz),
  public.sync_delete(text, text, text) from public;
grant execute on function public.sync_put(text, text, text, text), public.sync_get(text, text, timestamptz),
  public.sync_delete(text, text, text) to anon, authenticated;

-- Optional, but promised in the privacy text: forget vaults nobody has used for 12 months.
-- Needs the pg_cron extension (Database › Extensions › pg_cron). Run this part after turning it on:
--
--   select cron.schedule('agh-sync-cleanup', '17 3 * * *',
--     $$delete from public.sync_vault where last_seen < now() - interval '12 months'$$);

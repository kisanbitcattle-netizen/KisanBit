-- ============================================================
-- KISANBIT — Complete Supabase Schema (run this ONE file, top to bottom)
-- ============================================================

create extension if not exists postgis;
create extension if not exists "uuid-ossp";

-- ------------------------------------------------------------
-- 1. USERS  (extends auth.users)
-- ------------------------------------------------------------
create type user_role as enum ('farmer', 'buyer', 'super_admin');
create type subscription_tier as enum ('free', 'premium');

create table public.users (
  id              uuid primary key references auth.users(id) on delete cascade,
  full_name       text not null,
  phone           text unique,
  role            user_role not null default 'farmer',
  subscription    subscription_tier not null default 'free',
  created_at      timestamptz not null default now()
);

alter table public.users enable row level security;

create policy "users_select_own_or_admin"
  on public.users for select
  using (auth.uid() = id or exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'super_admin'
  ));

create policy "users_update_own"
  on public.users for update
  using (auth.uid() = id);

create policy "users_insert_self"
  on public.users for insert
  with check (auth.uid() = id);


-- ------------------------------------------------------------
-- 2. CATTLE
-- ------------------------------------------------------------
create type animal_type as enum ('cow', 'buffalo', 'goat', 'sheep');

create table public.cattle (
  id                  uuid primary key default uuid_generate_v4(),
  owner_id            uuid not null references public.users(id) on delete cascade,
  name                text not null,
  animal_type         animal_type not null,
  collar_id           text unique,                 -- links a LoRa collar to this animal
  live_location       geography(Point, 4326),
  last_updated        timestamptz default now(),
  geofence_center     geography(Point, 4326),
  geofence_radius_m   integer default 1000,
  local_image_path    text,
  marketplace_photo_url text,
  is_listed_for_sale  boolean not null default false,
  sale_price          numeric(10,2),
  created_at          timestamptz not null default now()
);

create index cattle_owner_idx on public.cattle (owner_id);
create index cattle_live_location_gix on public.cattle using gist (live_location);
create index cattle_geofence_gix on public.cattle using gist (geofence_center);
create index cattle_collar_id_idx on public.cattle (collar_id);

alter table public.cattle enable row level security;

create policy "cattle_owner_full_access"
  on public.cattle for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "cattle_public_listed_select"
  on public.cattle for select
  using (is_listed_for_sale = true);

create view public.cattle_public_view as
select
  id,
  name,
  animal_type,
  geofence_center,
  geofence_radius_m,
  marketplace_photo_url,
  sale_price,
  owner_id
from public.cattle
where is_listed_for_sale = true;

grant select on public.cattle_public_view to anon, authenticated;


-- ------------------------------------------------------------
-- 3. FIELDS  (farm/crop boundary polygons)
-- ------------------------------------------------------------
create table public.fields (
  id              uuid primary key default uuid_generate_v4(),
  owner_id        uuid not null references public.users(id) on delete cascade,
  name            text not null,
  boundary        geography(Polygon, 4326) not null,
  is_public       boolean not null default false,
  created_at      timestamptz not null default now()
);

create index fields_owner_idx on public.fields (owner_id);
create index fields_boundary_gix on public.fields using gist (boundary);

alter table public.fields enable row level security;

create policy "fields_owner_full_access"
  on public.fields for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "fields_public_select"
  on public.fields for select
  using (is_public = true);


-- ------------------------------------------------------------
-- 4. CROPS MARKETPLACE
-- ------------------------------------------------------------
create type crop_status as enum ('growing', 'ready_to_harvest', 'harvested');
create type delivery_type as enum ('transportable', 'in_hand');

create table public.crops_marketplace (
  id                uuid primary key default uuid_generate_v4(),
  field_id          uuid not null references public.fields(id) on delete cascade,
  owner_id          uuid not null references public.users(id) on delete cascade,
  crop_type         text not null,
  status            crop_status not null default 'growing',
  harvest_date      date,
  market_price      numeric(10,2),
  delivery_type     delivery_type not null default 'in_hand',
  is_listed         boolean not null default false,
  photo_url         text,
  created_at        timestamptz not null default now()
);

create index crops_owner_idx on public.crops_marketplace (owner_id);
create index crops_field_idx on public.crops_marketplace (field_id);

alter table public.crops_marketplace enable row level security;

create policy "crops_owner_full_access"
  on public.crops_marketplace for all
  using (auth.uid() = owner_id)
  with check (auth.uid() = owner_id);

create policy "crops_public_listed_select"
  on public.crops_marketplace for select
  using (is_listed = true);

create or replace function public.sync_field_public_flag()
returns trigger as $$
begin
  update public.fields f
  set is_public = exists (
    select 1 from public.crops_marketplace c
    where c.field_id = f.id and c.is_listed = true
  )
  where f.id = coalesce(new.field_id, old.field_id);
  return new;
end;
$$ language plpgsql security definer;

create trigger trg_sync_field_public
after insert or update or delete on public.crops_marketplace
for each row execute function public.sync_field_public_flag();


-- ------------------------------------------------------------
-- 5. LORA GATEWAYS  (IoT hardware, Super Admin managed)
-- ------------------------------------------------------------
create table public.lora_gateways (
  id                  uuid primary key default uuid_generate_v4(),
  owner_id            uuid references public.users(id) on delete set null,
  gateway_code        text unique not null,
  location            geography(Point, 4326),
  status              text not null default 'active',
  encryption_key_hash text not null,
  registered_at       timestamptz not null default now()
);

alter table public.lora_gateways enable row level security;

create policy "gateways_owner_select"
  on public.lora_gateways for select
  using (auth.uid() = owner_id or exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'super_admin'
  ));

create policy "gateways_admin_write"
  on public.lora_gateways for all
  using (exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'super_admin'
  ))
  with check (exists (
    select 1 from public.users u where u.id = auth.uid() and u.role = 'super_admin'
  ));


-- ------------------------------------------------------------
-- 6. CATTLE LOCATION HISTORY  (for "today's movement trail")
-- ------------------------------------------------------------
create table public.cattle_location_history (
  id            uuid primary key default uuid_generate_v4(),
  cattle_id     uuid not null references public.cattle(id) on delete cascade,
  location      geography(Point, 4326) not null,
  recorded_at   timestamptz not null default now()
);

create index cattle_history_cattle_idx
  on public.cattle_location_history (cattle_id, recorded_at desc);

alter table public.cattle_location_history enable row level security;

create policy "history_owner_select"
  on public.cattle_location_history for select
  using (
    exists (
      select 1 from public.cattle c
      where c.id = cattle_id and c.owner_id = auth.uid()
    )
  );

create policy "history_owner_insert"
  on public.cattle_location_history for insert
  with check (
    exists (
      select 1 from public.cattle c
      where c.id = cattle_id and c.owner_id = auth.uid()
    )
  );


-- ------------------------------------------------------------
-- 7. REALTIME
-- ------------------------------------------------------------
alter publication supabase_realtime add table public.cattle;
alter publication supabase_realtime add table public.cattle_location_history;

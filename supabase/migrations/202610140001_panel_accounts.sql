-- Cloud-backed panel accounts and sessions. Secrets and session tokens are never
-- readable through the public REST API; the Edge Function uses service_role.
create table if not exists public.panel_users (
  username text primary key,
  role text not null check (role in ('owner', 'admin', 'seller')),
  salt text not null,
  password_hash text not null,
  is_bootstrap boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.panel_sessions (
  token_hash text primary key,
  username text not null references public.panel_users(username) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists panel_sessions_expiry_idx on public.panel_sessions (expires_at);
alter table public.panel_users enable row level security;
alter table public.panel_sessions enable row level security;
revoke all on public.panel_users, public.panel_sessions from anon, authenticated;
grant all on public.panel_users, public.panel_sessions to service_role;

-- Keep the bundled public key from bypassing role checks through table REST APIs.
revoke all on public.licenses, public.banned_hwids from anon, authenticated;

-- Expired sessions can be cleared without exposing session data.
create or replace function public.panel_cleanup_expired_sessions()
returns void language sql security definer set search_path = '' as $$
  delete from public.panel_sessions where expires_at <= now();
$$;
revoke all on function public.panel_cleanup_expired_sessions() from public, anon, authenticated;
grant execute on function public.panel_cleanup_expired_sessions() to service_role;

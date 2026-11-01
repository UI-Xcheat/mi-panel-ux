-- ============================================================================
-- UXTREAM / UX - Migración de Seguridad: RPC verify_license y RLS Estricto
-- Archivo: 202610280002_verify_license_rpc.sql
-- ============================================================================

-- 1. Asegurar la estructura de tablas para licencias y bloqueos de HWID
create table if not exists public.licenses (
  id bigint generated always as identity primary key,
  key text not null unique,
  hwid text,
  status text not null default 'active' check (status in ('active', 'expired', 'revoked', 'blocked')),
  edition text not null default 'ALL' check (edition in ('AIM', 'FULL', 'VISUALS', 'ALL')),
  duration text not null default '30d' check (duration in ('1d', '7d', '30d', 'custom', 'lifetime')),
  custom_days integer default 30,
  created_at timestamptz not null default now(),
  activated_at timestamptz,
  expires_at timestamptz
);

create table if not exists public.banned_hwids (
  id bigint generated always as identity primary key,
  hwid text not null unique,
  reason text not null default 'Baneado por administrador',
  banned_at timestamptz not null default now()
);

-- Índices de consulta rápida
create index if not exists idx_licenses_key on public.licenses(key);
create index if not exists idx_licenses_hwid on public.licenses(hwid);
create index if not exists idx_banned_hwids_hwid on public.banned_hwids(hwid);

-- 2. POLÍTICA DE PRIVACIDAD Y SEGURIDAD RLS ESTRICTA (Zero-Trust)
-- La clave pública 'sb_publishable_...' o 'anon' NUNCA debe poder leer ni escribir
-- directamente en las tablas 'licenses' o 'banned_hwids' vía REST API PostgREST.
alter table public.licenses enable row level security;
alter table public.banned_hwids enable row level security;

-- Revocar acceso directo a usuarios anónimos y autenticados genéricos
revoke all on public.licenses from public, anon, authenticated;
revoke all on public.banned_hwids from public, anon, authenticated;

-- Acceso de lectura y escritura exclusivo para el rol de servicio (backend de administración)
grant all on public.licenses to service_role;
grant all on public.banned_hwids to service_role;

-- 3. FUNCIÓN RPC verify_license (SECURITY DEFINER)
-- Se ejecuta con privilegios elevados del servidor sin exponer las tablas subyacentes.
create or replace function public.verify_license(
  p_key text,
  p_hwid text,
  p_edition text default 'FULL'
)
returns json
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_lic record;
  v_banned boolean := false;
  v_now bigint := extract(epoch from now())::bigint;
  v_rem_sec bigint := 0;
  v_exp_ts bigint := 0;
  v_req_edition text;
begin
  -- A. Sanitización estricta de parámetros
  p_key := trim(coalesce(p_key, ''));
  p_hwid := trim(coalesce(p_hwid, ''));
  v_req_edition := upper(trim(coalesce(p_edition, 'FULL')));

  if p_key = '' or p_hwid = '' then
    return json_build_object(
      'success', false,
      'status', 'invalid_params',
      'message', 'Clave o identificador de máquina vacío.'
    );
  end if;

  -- B. Verificar si el HWID está en la lista de equipos baneados
  select exists(select 1 from public.banned_hwids where hwid = p_hwid) into v_banned;
  if v_banned then
    return json_build_object(
      'success', false,
      'status', 'banned',
      'message', 'Este equipo ha sido bloqueado por el administrador.'
    );
  end if;

  -- C. Buscar la licencia en la base de datos
  select * into v_lic from public.licenses where key = p_key limit 1;
  if not found then
    return json_build_object(
      'success', false,
      'status', 'not_found',
      'message', 'La clave proporcionada no existe o no es válida.'
    );
  end if;

  -- D. Comprobar si la clave ha sido revocada o bloqueada administrativamente
  if v_lic.status = 'revoked' or v_lic.status = 'blocked' then
    return json_build_object(
      'success', false,
      'status', 'blocked',
      'edition', coalesce(v_lic.edition, 'ALL'),
      'message', 'Esta licencia ha sido revocada o suspendida por el administrador.'
    );
  end if;

  -- E. Vinculación y validación de HWID (Hardware ID)
  if v_lic.hwid is null or v_lic.hwid = '' then
    -- Primera activación: vincular HWID de la máquina actual
    update public.licenses
    set hwid = p_hwid,
        status = 'active',
        activated_at = coalesce(v_lic.activated_at, now())
    where key = p_key;
    v_lic.hwid := p_hwid;
  elsif v_lic.hwid <> p_hwid then
    return json_build_object(
      'success', false,
      'status', 'hwid_mismatch',
      'edition', coalesce(v_lic.edition, 'ALL'),
      'message', 'Esta clave ya está vinculada a otro equipo.'
    );
  end if;

  -- F. Comprobar autorización de edición en el servidor (AIM, FULL, VISUALS, ALL)
  if v_lic.edition is not null and upper(v_lic.edition) <> 'ALL' then
    if upper(v_lic.edition) <> v_req_edition then
      return json_build_object(
        'success', false,
        'status', 'edition_mismatch',
        'edition', v_lic.edition,
        'message', 'Esta clave pertenece a la edición ' || v_lic.edition || ' y no puede usarse en ' || v_req_edition || '.'
      );
    end if;
  end if;

  -- G. Validación de Vencimiento
  if v_lic.duration = 'lifetime' then
    return json_build_object(
      'success', true,
      'status', 'active',
      'edition', coalesce(v_lic.edition, 'ALL'),
      'is_lifetime', true,
      'expires_at', 99999999999,
      'remaining_seconds', 99999999999,
      'message', 'Licencia Vitalicia autorizada con éxito.'
    );
  else
    -- Calcular fecha límite de expiración
    if v_lic.expires_at is null then
      declare
        v_days integer := coalesce(v_lic.custom_days, 30);
      begin
        if v_lic.duration = '1d' then v_days := 1;
        elsif v_lic.duration = '7d' then v_days := 7;
        elsif v_lic.duration = '30d' then v_days := 30;
        end if;
        v_exp_ts := v_now + (v_days * 86400);
        update public.licenses set expires_at = to_timestamp(v_exp_ts) where key = p_key;
      end;
    else
      v_exp_ts := extract(epoch from v_lic.expires_at)::bigint;
    end if;

    -- Si la fecha límite ya pasó
    if v_exp_ts <= v_now then
      update public.licenses set status = 'expired' where key = p_key;
      return json_build_object(
        'success', false,
        'status', 'expired',
        'edition', coalesce(v_lic.edition, 'ALL'),
        'is_lifetime', false,
        'expires_at', v_exp_ts,
        'remaining_seconds', 0,
        'message', 'Tu licencia ha expirado. Contacta con soporte para renovarla.'
      );
    end if;

    v_rem_sec := v_exp_ts - v_now;
    return json_build_object(
      'success', true,
      'status', 'active',
      'edition', coalesce(v_lic.edition, 'ALL'),
      'is_lifetime', false,
      'expires_at', v_exp_ts,
      'remaining_seconds', v_rem_sec,
      'message', 'Licencia autorizada con éxito.'
    );
  end if;
end;
$$;

-- Permisos exclusivos de ejecución del RPC
revoke all on function public.verify_license(text, text, text) from public;
grant execute on function public.verify_license(text, text, text) to anon, authenticated, service_role;

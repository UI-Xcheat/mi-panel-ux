import { createClient } from 'npm:@supabase/supabase-js@2';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json' },
});
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
const SESSION_MS = 8 * 60 * 60 * 1000;
const enc = new TextEncoder();

function randomHex(bytes = 32) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  return [...raw].map((value) => value.toString(16).padStart(2, '0')).join('');
}
async function digest(value: string) {
  const result = await crypto.subtle.digest('SHA-256', enc.encode(value));
  return [...new Uint8Array(result)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: enc.encode(salt), iterations: 210_000, hash: 'SHA-256' }, key, 256);
  return [...new Uint8Array(bits)].map((value) => value.toString(16).padStart(2, '0')).join('');
}
function same(a: string, b: string) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}
async function ensureBootstrapAccounts() {
  const seeds = [
    { username: Deno.env.get('OWNER_USERNAME') || '', password: Deno.env.get('OWNER_PASSWORD') || '', role: 'owner' },
    ...(Deno.env.get('ADMIN_USERNAMES') || Deno.env.get('ADMIN_USERNAME') || '').split(',').map((username) => ({
      username: username.trim(), password: Deno.env.get('ADMIN_PASSWORD') || '', role: 'admin',
    })),
  ].filter((user) => user.username && user.password);
  for (const seed of seeds) {
    const { data: existing } = await db.from('panel_users').select('username').eq('username', seed.username).maybeSingle();
    if (existing) continue;
    const salt = randomHex(16);
    const { error } = await db.from('panel_users').insert({
      username: seed.username, role: seed.role, salt,
      password_hash: await passwordHash(seed.password, salt), is_bootstrap: true,
    });
    if (error && error.code !== '23505') throw error;
  }
}
async function requireSession(req: Request) {
  const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data } = await db.from('panel_sessions').select('username, expires_at').eq('token_hash', await digest(token)).maybeSingle();
  if (!data || Date.parse(data.expires_at) <= Date.now()) return null;
  const { data: user } = await db.from('panel_users').select('username, role').eq('username', data.username).maybeSingle();
  return user || null;
}
function resolveLicenseProduct(value: unknown) {
  const norm = String(value || '').trim().toLowerCase();
  if (norm === 'only_aim' || norm === 'only aim') return { id: 'only_aim', name: 'Only Aim', prefix: 'AX' };
  if (norm === 'externalux' || norm === 'external ux') return { id: 'externalux', name: 'ExternalUX', prefix: 'EX' };
  if (norm === 'privateux' || norm === 'private ux') return { id: 'privateux', name: 'PrivateUX', prefix: 'PX' };
  return null;
}
function keyPrefixMatchesProduct(key: string, product: { id: string; name: string; prefix: string }) {
  const upper = String(key || '').trim().toUpperCase();
  const hasPrefix = upper.length >= 3 && upper[2] === '-';
  if (product.id === 'only_aim') {
    if (!hasPrefix) return true;
    return upper.startsWith(product.prefix + '-');
  }
  return hasPrefix && upper.startsWith(product.prefix + '-');
}
function licenseMatchesProduct(lic: Record<string, any>, key: string, product: { id: string; name: string; prefix: string }) {
  if (lic.product) {
    const licProd = resolveLicenseProduct(lic.product);
    if (licProd && licProd.id !== product.id) return false;
  }
  return keyPrefixMatchesProduct(key, product);
}
function supabaseDurationHours(lic: Record<string, any>) {
  const duration = String(lic.duration || '');
  if (duration === '1_hour') return 1;
  if (duration === '1_day') return 24;
  if (duration === '7_days') return 168;
  if (duration === '30_days') return 720;
  if (duration === 'custom') return (lic.custom_days || 1) * 24;
  if (duration.startsWith('custom_hours_')) return Number(duration.slice(13)) || 24;
  if (duration === 'lifetime') return 0;
  return 24;
}

function keyCode() {
  const part = () => randomHex(3).toUpperCase();
  return `UIX-${part()}-${part()}-${part()}`;
}
function keyLabel(row: Record<string, any>) {
  const duration = String(row.duration || '');
  if (duration === 'lifetime') return 'Permanente (Lifetime)';
  if (duration.startsWith('custom_hours_')) return `${duration.slice(13)} Horas`;
  if (duration === 'custom') return `${row.custom_days || 1} Días`;
  return ({ '1_hour': '1 Hora', '1_day': '1 Día', '7_days': '7 Días', '30_days': '30 Días' } as Record<string, string>)[duration] || duration;
}
function uiKey(row: Record<string, any>) {
  const lifetime = row.duration === 'lifetime';
  const blocked = row.status === 'blocked';
  const expires = Number(row.expires_at || 0);
  const expired = !lifetime && expires > 0 && expires * 1000 <= Date.now();
  const status = blocked ? 'bloqueada' : !row.hwid ? (expired ? 'expirada' : 'disponible') : expired ? 'expirada' : 'activa';
  return {
    id: row.id, key: row.key, duration_type: keyLabel(row), note: row.note || 'Cliente',
    created_at: row.created_at ? Date.parse(row.created_at) : Date.now(),
    activated_at: row.activated_at ? Number(row.activated_at) * 1000 : null,
    expires_at: expires ? expires * 1000 : null, hwid: row.hwid || null,
    status, is_blocked: blocked, is_lifetime: lifetime,
    remaining_ms: lifetime ? -1 : expires ? Math.max(0, expires * 1000 - Date.now()) : 0,
  };
}
function durationData(body: Record<string, any>, role: string) {
  const duration = String(body.duration || '7d');
  const fixed: Record<string, [number, string, number]> = {
    '1h': [1, '1_hour', 0], '1d': [24, '1_day', 0], '3d': [72, 'custom', 3],
    '7d': [168, '7_days', 0], '15d': [360, 'custom', 15], '30d': [720, '30_days', 0],
    '90d': [2160, 'custom', 90],
  };
  let hours: number, stored: string, days: number;
  if (duration === 'lifetime' && role === 'owner') return { hours: Infinity, stored: 'lifetime', days: 0 };
  if (duration === 'custom') {
    const amount = Math.floor(Number(body.custom_amount ?? body.custom_hours ?? 24));
    const unit = body.custom_unit === 'days' ? 'days' : 'hours';
    if (!Number.isFinite(amount) || amount < 1 || (role !== 'owner' && amount > (unit === 'days' ? 105 : 2520))) {
      throw new Error('Duración inválida. Admin y Vendedor pueden crear hasta 105 días.');
    }
    hours = unit === 'days' ? amount * 24 : amount;
    stored = unit === 'days' ? 'custom' : `custom_hours_${amount}`;
    days = unit === 'days' ? amount : 0;
  } else {
    [hours, stored, days] = fixed[duration] || fixed['7d'];
  }
  if (role !== 'owner' && hours > 2520) throw new Error('Admin y Vendedor pueden crear claves de hasta 15 semanas (105 días).');
  return { hours, stored, days };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ success: false, message: 'Método no permitido.' }, 405);
  try {
    await ensureBootstrapAccounts();
    const body = await req.json().catch(() => ({}));
    const action = String(body.action || '');

    if (action === 'login') {
      const username = String(body.username || '').trim();
      const password = String(body.password || '');
      const { data: user } = await db.from('panel_users').select('username, role, salt, password_hash').eq('username', username).maybeSingle();
      if (!user || !same(await passwordHash(password, user.salt), user.password_hash)) {
        return json({ success: false, message: 'Usuario o contraseña incorrectos.' }, 401);
      }
      const token = randomHex();
      await db.from('panel_sessions').delete().lte('expires_at', new Date().toISOString());
      const { error } = await db.from('panel_sessions').insert({ token_hash: await digest(token), username, expires_at: new Date(Date.now() + SESSION_MS).toISOString() });
      if (error) throw error;
      return json({ success: true, username, role: user.role, session_token: token });
    }

    // =========================================================================
    // API PUBLICA PARA EL CLIENTE C++ (Cheat Client)
    // =========================================================================
    if (action === 'activate' || action === 'client-activate') {
      const key = String(body.key || '').trim();
      const hwid = String(body.hwid || '').trim();
      const product = resolveLicenseProduct(body.product);

      if (!key) return json({ success: false, message: 'Se requiere una clave de licencia.' }, 400);
      if (!product) return json({ success: false, message: 'Se requiere un producto válido (only_aim, externalux o privateux).' }, 400);
      if (!keyPrefixMatchesProduct(key, product)) {
        return json({ success: false, code: 'PRODUCT_MISMATCH', message: 'Esta key pertenece a otro producto.' }, 403);
      }

      if (hwid) {
        const { data: ban } = await db.from('banned_hwids').select('hwid').ilike('hwid', hwid).maybeSingle();
        if (ban) {
          return json({
            success: false,
            message: 'ACCESO DENEGADO / BANEADO: Esta computadora (HWID) ha sido BANEADA permanentemente por el administrador.'
          }, 403);
        }
      }

      const { data: supaLic, error } = await db.from('licenses').select('*').eq('key', key).maybeSingle();
      if (error || !supaLic) {
        return json({ success: false, message: 'Clave de licencia inválida o inexistente.' }, 404);
      }

      if (!licenseMatchesProduct(supaLic, key, product)) {
        return json({ success: false, code: 'PRODUCT_MISMATCH', message: 'Esta key pertenece a otro producto.' }, 403);
      }

      if (supaLic.status === 'blocked') {
        return json({
          success: false,
          message: 'Clave DENEGADA / BANEADA: Esta licencia ha sido bloqueada/revocada por el administrador.'
        }, 403);
      }

      const nowSec = Math.floor(Date.now() / 1000);
      const isLifetime = (supaLic.duration === 'lifetime');

      if (!supaLic.hwid) {
        const durSec = supabaseDurationHours(supaLic) * 3600;
        const newExpires = isLifetime ? 0 : (nowSec + durSec);
        const { error: updateErr } = await db.from('licenses').update({
          hwid: hwid || 'HWID-AUTO',
          status: 'active',
          activated_at: nowSec,
          expires_at: newExpires
        }).eq('key', supaLic.key);
        if (updateErr) throw updateErr;
        supaLic.hwid = hwid || 'HWID-AUTO';
        supaLic.expires_at = newExpires;
      } else {
        if (hwid && supaLic.hwid !== hwid) {
          return json({
            success: false,
            message: 'Clave vinculada a otra PC. Pide al administrador resetear el HWID.'
          }, 403);
        }
        if (!isLifetime && supaLic.expires_at > 0 && nowSec >= supaLic.expires_at) {
          return json({
            success: false,
            message: 'Tu suscripción ha expirado. Contacta al administrador para renovar.'
          }, 403);
        }
      }

      const remainingSeconds = isLifetime ? 999999999 : Math.max(0, (supaLic.expires_at || (nowSec + 86400)) - nowSec);
      return json({
        success: true,
        key: supaLic.key,
        product: product.id,
        is_lifetime: isLifetime,
        expires_at: supaLic.expires_at ? supaLic.expires_at * 1000 : null,
        remaining_seconds: remainingSeconds,
        hwid: supaLic.hwid,
        message: 'Licencia autorizada con éxito.'
      });
    }

    if (action === 'check' || action === 'client-check') {
      const key = String(body.key || '').trim();
      const hwid = String(body.hwid || '').trim();
      const product = resolveLicenseProduct(body.product);

      if (!key) return json({ valid: false, message: 'Falta parámetro key' }, 400);
      if (!product) return json({ valid: false, message: 'Falta parámetro product' }, 400);
      if (!keyPrefixMatchesProduct(key, product)) {
        return json({ valid: false, blocked: true, code: 'PRODUCT_MISMATCH', message: 'Esta key pertenece a otro producto.' });
      }

      if (hwid) {
        const { data: ban } = await db.from('banned_hwids').select('hwid').ilike('hwid', hwid).maybeSingle();
        if (ban) return json({ valid: false, blocked: true, message: 'HWID BANEADO permanentemente' });
      }

      const { data: supaLic } = await db.from('licenses').select('*').eq('key', key).maybeSingle();
      if (!supaLic) return json({ valid: false, blocked: true, message: 'Clave no encontrada' });
      if (!licenseMatchesProduct(supaLic, key, product)) {
        return json({ valid: false, blocked: true, code: 'PRODUCT_MISMATCH', message: 'Esta key pertenece a otro producto.' });
      }
      if (supaLic.status === 'blocked') return json({ valid: false, blocked: true, message: 'Clave revocada por administrador' });
      if (hwid && supaLic.hwid && supaLic.hwid !== hwid) return json({ valid: false, blocked: true, message: 'HWID no coincide' });

      const nowSec = Math.floor(Date.now() / 1000);
      const isLifetime = (supaLic.duration === 'lifetime');
      if (!isLifetime && supaLic.expires_at > 0 && nowSec >= supaLic.expires_at) {
        return json({ valid: false, expired: true, message: 'Licencia expirada' });
      }
      const remainingSeconds = isLifetime ? 999999999 : Math.max(0, (supaLic.expires_at || nowSec) - nowSec);
      return json({
        valid: true,
        product: product.id,
        blocked: false,
        expired: false,
        is_lifetime: isLifetime,
        remaining_seconds: remainingSeconds,
        message: 'Licencia activa'
      });
    }

    const user = await requireSession(req);
    if (!user) return json({ success: false, message: 'Inicia sesión para continuar.' }, 401);
    if (action === 'session') return json({ success: true, username: user.username, role: user.role });
    if (action === 'logout') {
      const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
      await db.from('panel_sessions').delete().eq('token_hash', await digest(token));
      return json({ success: true });
    }
    if (action === 'users') {
      if (user.role !== 'owner') return json({ success: false, message: 'Esta acción requiere permisos de Owner.' }, 403);
      if (body.method === 'GET') {
        const { data, error } = await db.from('panel_users').select('username, role, is_bootstrap').order('created_at');
        if (error) throw error;
        return json({ success: true, users: (data || []).map((account) => ({ ...account, managed: !account.is_bootstrap })) });
      }
      if (body.method === 'POST') {
        const username = String(body.username || '').trim();
        const password = String(body.password || '');
        const role = body.role === 'admin' ? 'admin' : 'seller';
        if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) return json({ success: false, message: 'Usuario inválido.' }, 400);
        if (password.length < 10 || password.length > 128) return json({ success: false, message: 'La contraseña debe tener entre 10 y 128 caracteres.' }, 400);
        const salt = randomHex(16);
        const { error } = await db.from('panel_users').insert({ username, role, salt, password_hash: await passwordHash(password, salt) });
        if (error?.code === '23505') return json({ success: false, message: 'Ya existe una cuenta con ese usuario.' }, 409);
        if (error) throw error;
        return json({ success: true, message: `Cuenta ${role === 'admin' ? 'Admin' : 'Vendedor'} creada.`, user: { username, role, managed: true } }, 201);
      }
      if (body.method === 'DELETE') {
        const username = String(body.username || '');
        const { data, error } = await db.from('panel_users').delete().eq('username', username).eq('is_bootstrap', false).select('username');
        if (error) throw error;
        if (!data?.length) return json({ success: false, message: 'Solo se pueden quitar las cuentas creadas desde el panel.' }, 404);
        return json({ success: true, message: `Cuenta ${username} eliminada.` });
      }
    }

    if (action === 'keys-list') {
      const [{ data: rows, error }, { data: bans, error: banError }] = await Promise.all([
        db.from('licenses').select('*').order('id', { ascending: false }),
        db.from('banned_hwids').select('hwid'),
      ]);
      if (error) throw error;
      if (banError) throw banError;
      return json({ success: true, cloud: true, total: rows?.length || 0, keys: (rows || []).map(uiKey), banned_hwids: (bans || []).map((row) => row.hwid) });
    }
    if (action === 'keys-create') {
      const { hours, stored, days } = durationData(body, user.role);
      const key = keyCode();
      const { error } = await db.from('licenses').insert({ key, duration: stored, custom_days: days, status: 'unused', hwid: null, note: String(body.note || 'Cliente').slice(0, 80) });
      if (error) throw error;
      return json({ success: true, message: 'Clave guardada en Supabase.', key: { key, duration_type: stored === 'lifetime' ? 'Permanente (Lifetime)' : days ? `${days} Días` : stored, note: body.note || 'Cliente', status: 'disponible', is_blocked: false, is_lifetime: stored === 'lifetime' } }, 201);
    }
    if (action === 'key-block') {
      if (user.role === 'seller') return json({ success: false, message: 'El rol Vendedor solo puede crear claves.' }, 403);
      const key = String(body.key || '').trim();
      const { data: row, error: readError } = await db.from('licenses').select('hwid').eq('key', key).maybeSingle();
      if (readError) throw readError;
      if (!row) return json({ success: false, message: 'Clave no encontrada.' }, 404);
      const blocked = body.is_blocked !== undefined ? Boolean(body.is_blocked) : true;
      const { error } = await db.from('licenses').update({ status: blocked ? 'blocked' : row.hwid ? 'active' : 'unused' }).eq('key', key);
      if (error) throw error;
      return json({ success: true, is_blocked: blocked, message: blocked ? 'Clave bloqueada.' : 'Clave desbloqueada.' });
    }

    if (user.role !== 'owner') return json({ success: false, message: 'Esta acción requiere permisos de Owner.' }, 403);
    const key = String(body.key || '').trim();
    if (action === 'key-delete') {
      const { error } = await db.from('licenses').delete().eq('key', key);
      if (error) throw error;
      return json({ success: true, message: 'Clave eliminada permanentemente.' });
    }
    if (action === 'key-reset-hwid' || action === 'key-deactivate') {
      const patch = action === 'key-deactivate' ? { status: 'unused', hwid: null, activated_at: 0, expires_at: 0 } : { hwid: null };
      const { error } = await db.from('licenses').update(patch).eq('key', key);
      if (error) throw error;
      return json({ success: true, message: action === 'key-deactivate' ? 'Clave desactivada.' : 'HWID desvinculado.' });
    }
    if (action === 'key-set-hwid') {
      const { error } = await db.from('licenses').update({ hwid: String(body.hwid || '') }).eq('key', key);
      if (error) throw error;
      return json({ success: true, message: 'HWID actualizado.' });
    }
    if (action === 'hwid-ban' || action === 'hwid-unban') {
      const hwid = String(body.hwid || '').trim();
      if (action === 'hwid-ban') {
        const { error } = await db.from('banned_hwids').upsert({ hwid, reason: String(body.reason || 'Baneado por Owner') }, { onConflict: 'hwid' });
        if (error) throw error;
        await db.from('licenses').update({ status: 'blocked' }).eq('hwid', hwid);
      } else {
        const { error } = await db.from('banned_hwids').delete().eq('hwid', hwid);
        if (error) throw error;
      }
      const { data } = await db.from('banned_hwids').select('hwid');
      return json({ success: true, banned_hwids: (data || []).map((row) => row.hwid) });
    }
    if (action === 'key-extend') {
      const amount = Math.floor(Number(body.amount));
      const unit = body.unit === 'days' ? 'days' : 'hours';
      if (!Number.isFinite(amount) || amount < 1) return json({ success: false, message: 'Duración inválida.' }, 400);
      const { data: row, error } = await db.from('licenses').select('expires_at').eq('key', key).maybeSingle();
      if (error) throw error;
      if (!row) return json({ success: false, message: 'Clave no encontrada.' }, 404);
      const nowSec = Math.floor(Date.now() / 1000);
      const base = Math.max(Number(row.expires_at || 0), nowSec);
      const expires_at = base + amount * (unit === 'days' ? 86400 : 3600);
      const { error: updateError } = await db.from('licenses').update({ expires_at, status: 'active' }).eq('key', key);
      if (updateError) throw updateError;
      return json({ success: true, message: 'Duración extendida.' });
    }
    return json({ success: false, message: 'Acción no reconocida.' }, 400);
  } catch (error) {
    console.error('panel-api error:', error);
    return json({ success: false, message: error instanceof Error ? error.message : 'Error interno del servicio.' }, 500);
  }
});

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const SupabaseDb = require('./supabase_client');

const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const RESOURCE_CANDIDATES = [__dirname, path.dirname(__dirname), process.cwd()];
const RESOURCE_DIR = process.pkg
  ? (RESOURCE_CANDIDATES.find(dir => fs.existsSync(path.join(dir, 'public', 'index.html'))) || RESOURCE_CANDIDATES[0])
  : APP_DIR;

// Cargar .env si existe
const ENV_PATH = path.join(APP_DIR, '.env');
if (fs.existsSync(ENV_PATH)) {
  try {
    const envContent = fs.readFileSync(ENV_PATH, 'utf8');
    for (const line of envContent.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx !== -1) {
        const key = trimmed.slice(0, eqIdx).trim();
        const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
        if (!process.env[key]) {
          process.env[key] = val;
        }
      }
    }
  } catch (_) {}
}

const PORT = process.env.PORT || 8000;
const DATA_DIR = path.join(APP_DIR, 'data');
const DB_FILE = path.join(DATA_DIR, 'licenses.json');
const BANNED_HWIDS_FILE = path.join(DATA_DIR, 'banned_hwids.json');
const PANEL_USERS_FILE = path.join(DATA_DIR, 'panel_users.json');
const ADMIN_MAX_HOURS = 15 * 7 * 24;
const LICENSE_PRODUCTS = [
  { id: 'only_aim', name: 'Only Aim', prefix: 'AX' },
  { id: 'externalux', name: 'ExternalUX', prefix: 'EX' },
  { id: 'privateux', name: 'PrivateUX', prefix: 'PX' },
  { id: 'colorbot', name: 'ColorBot', prefix: 'CB' },
  { id: 'skins', name: 'UiXtream Skins', prefix: 'USK' }
];
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

function resolveLicenseProduct(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'cb' || normalized === 'uxcolor' || normalized === 'color bot') {
    return LICENSE_PRODUCTS.find(p => p.id === 'colorbot') || null;
  }
  if (normalized === 'usk' || normalized === 'skin' || normalized === 'skin remover') {
    return LICENSE_PRODUCTS.find(p => p.id === 'skins') || null;
  }
  return LICENSE_PRODUCTS.find(product => product.id === normalized || product.name.toLowerCase() === normalized) || null;
}

function keyPrefixMatchesProduct(key, product) {
  const match = /^([A-Z]{2,4})-/i.exec(String(key || '').trim());
  return match ? match[1].toUpperCase() === product.prefix : product.id === 'only_aim';
}

function licenseMatchesProduct(license, key, product) {
  if (!keyPrefixMatchesProduct(key, product)) return false;
  const keyPrefix = String(key || '').trim().split('-', 1)[0].toUpperCase();
  const keyProduct = LICENSE_PRODUCTS.find(item => item.prefix === keyPrefix);
  const storedProduct = license.product || keyProduct?.name || 'Only Aim';
  return storedProduct === product.name;
}

function readPublicSupabaseConfig() {
  try {
    const configPath = path.join(__dirname, 'supabase_public.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.supabase_url && config.supabase_anon_key) return config;
  } catch (_) {}
  return null;
}
const PUBLIC_SUPABASE = readPublicSupabaseConfig();
const REMOTE_PANEL_MODE = !SupabaseDb.isConfigured() && Boolean(PUBLIC_SUPABASE);

async function remotePanelRequest(action, payload = {}, token = '') {
  const response = await fetch(`${PUBLIC_SUPABASE.supabase_url.replace(/\/+$/, '')}/functions/v1/panel-api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': PUBLIC_SUPABASE.supabase_anon_key,
      ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    },
    body: JSON.stringify({ action, ...payload })
  });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

function sessionFromRequest(req) {
  const cookie = req.headers.cookie || '';
  const token = cookie.split(';').map(part => part.trim()).find(part => part.startsWith('uix_session='))?.slice('uix_session='.length);
  if (!token) return { token: '', session: null };
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return { token, session: null };
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return { token, session };
}

function safeEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left)).digest();
  const b = crypto.createHash('sha256').update(String(right)).digest();
  return crypto.timingSafeEqual(a, b);
}

function readSession(req) {
  const cookie = req.headers.cookie || '';
  const token = cookie.split(';').map(part => part.trim()).find(part => part.startsWith('uix_session='))?.slice('uix_session='.length);
  if (!token) return null;
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return session;
}

function sessionCookie(req, token, maxAge = SESSION_TTL_MS / 1000) {
  const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
  return `uix_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}

// Crear directorio de datos si no existe
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Cargar o inicializar base de datos
let licenses = [];
let bannedHwids = [];

function safeWriteJson(targetPath, data) {
  try {
    const serialized = JSON.stringify(data, null, 2);
    // Si el archivo ya existe, asegurar copia de respaldo previa
    if (fs.existsSync(targetPath)) {
      try {
        fs.copyFileSync(targetPath, targetPath + '.bak');
      } catch (_) {}
    }
    const tempPath = targetPath + '.tmp';
    fs.writeFileSync(tempPath, serialized, 'utf8');
    fs.renameSync(tempPath, targetPath);
  } catch (err) {
    console.error(`Error guardando archivo en ${targetPath}:`, err);
  }
}

function readManagedUsers() {
  try {
    const users = JSON.parse(fs.readFileSync(PANEL_USERS_FILE, 'utf8'));
    return Array.isArray(users) ? users : [];
  } catch (_) {
    return [];
  }
}

function saveManagedUsers(users) {
  safeWriteJson(PANEL_USERS_FILE, users);
}

function bootstrapUsers() {
  const admins = String(process.env.ADMIN_USERNAMES || process.env.ADMIN_USERNAME || '')
    .split(',').map(name => name.trim()).filter(Boolean);
  return [
    ...(process.env.OWNER_USERNAME ? [{ username: process.env.OWNER_USERNAME, role: 'owner', managed: false }] : []),
    ...admins.map(username => ({ username, role: 'admin', managed: false }))
  ];
}

function verifyManagedPassword(password, user) {
  try {
    const expected = Buffer.from(user.password_hash, 'hex');
    const actual = crypto.scryptSync(String(password), user.salt, expected.length);
    return expected.length > 0 && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

function loadDatabase() {
  try {
    // 1. Cargar licencias (con respaldo automático si falla)
    if (fs.existsSync(DB_FILE)) {
      try {
        const data = fs.readFileSync(DB_FILE, 'utf8');
        licenses = JSON.parse(data);
      } catch (parseErr) {
        console.warn('DB_FILE corrupto, intentando cargar respaldo .bak...');
        if (fs.existsSync(DB_FILE + '.bak')) {
          const bakData = fs.readFileSync(DB_FILE + '.bak', 'utf8');
          licenses = JSON.parse(bakData);
        } else {
          throw parseErr;
        }
      }
    } else if (fs.existsSync(DB_FILE + '.bak')) {
      const bakData = fs.readFileSync(DB_FILE + '.bak', 'utf8');
      licenses = JSON.parse(bakData);
    } else {
      // Crear clave inicial de ejemplo (Lifetime)
      licenses = [
        {
          key: 'hmVQ-TpZg-yQkN-wRCh',
          duration_type: 'lifetime',
          duration_hours: 0,
          note: 'Master VIP Admin',
          created_at: Date.now(),
          activated_at: null,
          expires_at: null,
          hwid: null,
          is_blocked: false,
          is_lifetime: true
        }
      ];
      saveDatabase();
    }

    // 2. Cargar HWIDs baneados (con respaldo automático si falla)
    if (fs.existsSync(BANNED_HWIDS_FILE)) {
      try {
        const bData = fs.readFileSync(BANNED_HWIDS_FILE, 'utf8');
        bannedHwids = JSON.parse(bData);
      } catch (parseErr) {
        console.warn('BANNED_HWIDS_FILE corrupto, intentando cargar respaldo .bak...');
        if (fs.existsSync(BANNED_HWIDS_FILE + '.bak')) {
          const bakData = fs.readFileSync(BANNED_HWIDS_FILE + '.bak', 'utf8');
          bannedHwids = JSON.parse(bakData);
        } else {
          throw parseErr;
        }
      }
    } else if (fs.existsSync(BANNED_HWIDS_FILE + '.bak')) {
      const bakData = fs.readFileSync(BANNED_HWIDS_FILE + '.bak', 'utf8');
      bannedHwids = JSON.parse(bakData);
    } else {
      bannedHwids = [];
      saveBannedHwids();
    }
  } catch (err) {
    console.error('Error cargando base de datos:', err);
    if (!licenses || !Array.isArray(licenses)) licenses = [];
    if (!bannedHwids || !Array.isArray(bannedHwids)) bannedHwids = [];
  }
}

function saveDatabase() {
  safeWriteJson(DB_FILE, licenses);
}

function saveBannedHwids() {
  safeWriteJson(BANNED_HWIDS_FILE, bannedHwids);
}

loadDatabase();

// Genera claves con prefijo de producto y cuatro segmentos aleatorios.
function generateKey(product) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const segment = () => {
    let res = '';
    const bytes = crypto.randomBytes(4);
    for (let i = 0; i < 4; i++) {
      res += chars[bytes[i] % chars.length];
    }
    return res;
  };
  return `${product.prefix}-${segment()}-${segment()}-${segment()}-${segment()}`;
}

function supabaseDurationHours(license) {
  const encodedHours = /^custom_hours_(\d+)$/.exec(String(license?.duration || ''));
  if (encodedHours) return Math.max(1, Number(encodedHours[1]));

  const fixedHours = {
    '1_hour': 1,
    '1_day': 24,
    '7_days': 168,
    '30_days': 720
  };
  if (fixedHours[license?.duration]) return fixedHours[license.duration];
  if (Number(license?.custom_days) > 0) return Number(license.custom_days) * 24;
  return 168;
}

function supabaseDurationLabel(duration, customDays) {
  const encodedHours = /^custom_hours_(\d+)$/.exec(String(duration || ''));
  if (encodedHours) {
    const hours = Number(encodedHours[1]);
    return `${hours} ${hours === 1 ? 'Hora' : 'Horas'}`;
  }

  const labels = {
    '1_hour': '1 Hora',
    '1_day': '1 Día',
    '7_days': '7 Días',
    '30_days': '30 Días',
    lifetime: 'Permanente (Lifetime)'
  };
  if (labels[duration]) return labels[duration];
  if (Number(customDays) > 0) {
    const days = Number(customDays);
    return `${days} ${days === 1 ? 'Día' : 'Días'}`;
  }
  return String(duration || 'Personalizada');
}

// Helpers para parsear JSON body
function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(data));
}

// Servidor HTTP
const server = http.createServer(async (req, res) => {
  // Manejo de CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = urlObj.pathname;
  const searchParams = urlObj.searchParams;

  if (pathname === '/api/auth/login' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');

    // 1. Intentar sesión remota si está en modo remoto
    if (REMOTE_PANEL_MODE) {
      try {
        const remote = await remotePanelRequest('login', { username, password });
        if (remote.status >= 200 && remote.status < 300 && remote.data && remote.data.username) {
          const token = crypto.randomBytes(32).toString('hex');
          sessions.set(token, {
            username: remote.data.username,
            role: remote.data.role,
            remoteToken: remote.data.session_token,
            expiresAt: Date.now() + SESSION_TTL_MS
          });
          res.setHeader('Set-Cookie', sessionCookie(req, token));
          return sendJson(res, 200, { success: true, username: remote.data.username, role: remote.data.role });
        }
      } catch (_) {}
    }

    // 2. Autenticación Local / Directa con fallback robusto (case-insensitive)
    const expectedOwnerUser = (process.env.OWNER_USERNAME || 'UISTALIN').trim().toLowerCase();
    const expectedOwnerPass = (process.env.OWNER_PASSWORD || '277353MCXD').trim();
    const expectedAdminUser = (process.env.ADMIN_USERNAME || 'ADMIN1').trim().toLowerCase();
    const expectedAdminPass = (process.env.ADMIN_PASSWORD || 'HEART2838').trim();

    const uLower = username.toLowerCase();
    const isOwner = (uLower === expectedOwnerUser) && safeEqual(password, expectedOwnerPass);

    const adminUsernames = String(process.env.ADMIN_USERNAMES || process.env.ADMIN_USERNAME || 'ADMIN1')
      .split(',').map(name => name.trim().toLowerCase()).filter(Boolean);
    const isAdmin = (adminUsernames.includes(uLower) || uLower === expectedAdminUser) &&
                    safeEqual(password, expectedAdminPass);

    let managed = readManagedUsers().find(user => user.username.toLowerCase() === uLower);
    if (!managed && SupabaseDb.isConfigured()) {
      try {
        const su = await SupabaseDb.getPanelUsers();
        if (Array.isArray(su)) {
          managed = su.find(user => user.username.toLowerCase() === uLower);
        }
      } catch (_) {}
    }
    const isManaged = Boolean(managed && verifyManagedPassword(password, managed));

    if (!isOwner && !isAdmin && !isManaged) {
      return sendJson(res, 401, { success: false, message: 'Usuario o contraseña incorrectos.' });
    }

    const token = crypto.randomBytes(32).toString('hex');
    const role = isOwner ? 'owner' : (isManaged ? managed.role : (isAdmin ? 'admin' : 'seller'));
    const finalUser = isOwner ? (process.env.OWNER_USERNAME || 'UISTALIN') : (isManaged ? managed.username : username);
    sessions.set(token, { username: finalUser, role, expiresAt: Date.now() + SESSION_TTL_MS });
    res.setHeader('Set-Cookie', sessionCookie(req, token));
    return sendJson(res, 200, { success: true, username: finalUser, role });
  }

  if (pathname === '/api/auth/session' && req.method === 'GET') {
    if (REMOTE_PANEL_MODE) {
      const { session } = sessionFromRequest(req);
      return session
        ? sendJson(res, 200, { success: true, username: session.username, role: session.role })
        : sendJson(res, 401, { success: false, message: 'Inicia sesión para continuar.' });
    }
    const session = readSession(req);
    return session
      ? sendJson(res, 200, { success: true, username: session.username, role: session.role })
      : sendJson(res, 401, { success: false, message: 'Inicia sesión para continuar.' });
  }

  if (pathname === '/api/auth/logout' && req.method === 'POST') {
    if (REMOTE_PANEL_MODE) {
      const { token, session } = sessionFromRequest(req);
      if (session?.remoteToken) {
        try { await remotePanelRequest('logout', {}, session.remoteToken); } catch (_) {}
      }
      if (token) sessions.delete(token);
      res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
      return sendJson(res, 200, { success: true });
    }
    const token = (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith('uix_session='))?.slice('uix_session='.length);
    if (token) sessions.delete(token);
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return sendJson(res, 200, { success: true });
  }

  const isAdminApi = pathname.startsWith('/api/admin/');
  const isOwnerApi = pathname.startsWith('/api/owner/');
  const session = isAdminApi || isOwnerApi ? readSession(req) : null;
  if ((isAdminApi || isOwnerApi) && !session) {
    return sendJson(res, 401, { success: false, message: 'Inicia sesión para administrar las licencias.' });
  }

  if (isOwnerApi && session.role !== 'owner') {
    return sendJson(res, 403, { success: false, message: 'Esta acción requiere permisos de Owner.' });
  }

  const ownerOnlyRoutes = new Set([
    '/api/admin/keys/reset-hwid', '/api/admin/keys/delete',
    '/api/admin/hwid/ban', '/api/admin/hwid/unban', '/api/admin/keys/deactivate',
    '/api/admin/keys/set-hwid', '/api/admin/keys/extend'
  ]);
  if (session?.role !== 'owner' && ownerOnlyRoutes.has(pathname)) {
    return sendJson(res, 403, { success: false, message: 'Esta acción requiere permisos de Owner.' });
  }
  if (pathname === '/api/admin/keys/block' && session.role === 'seller') {
    return sendJson(res, 403, { success: false, message: 'El rol Vendedor solo puede crear claves.' });
  }
  if (session?.role === 'seller' && isAdminApi && !(pathname === '/api/admin/keys' && req.method === 'GET') && !(pathname === '/api/admin/keys/generate' && req.method === 'POST')) {
    return sendJson(res, 403, { success: false, message: 'El rol Vendedor solo puede crear claves.' });
  }

  if (REMOTE_PANEL_MODE && (isAdminApi || isOwnerApi)) {
    const remoteActions = {
      '/api/owner/users': 'users',
      '/api/admin/keys': 'keys-list',
      '/api/admin/keys/generate': 'keys-create',
      '/api/admin/keys/block': 'key-block',
      '/api/admin/keys/reset-hwid': 'key-reset-hwid',
      '/api/admin/keys/delete': 'key-delete',
      '/api/admin/hwid/ban': 'hwid-ban',
      '/api/admin/hwid/unban': 'hwid-unban',
      '/api/admin/keys/deactivate': 'key-deactivate',
      '/api/admin/keys/set-hwid': 'key-set-hwid',
      '/api/admin/keys/extend': 'key-extend'
    };
    const action = remoteActions[pathname];
    if (!action) return sendJson(res, 404, { success: false, message: 'Ruta no encontrada.' });
    const { session: remoteSession } = sessionFromRequest(req);
    if (!remoteSession?.remoteToken) return sendJson(res, 401, { success: false, message: 'Inicia sesión para continuar.' });
    let payload = {};
    if (req.method === 'POST') payload = await parseJsonBody(req);
    if (action === 'keys-create') {
      const product = resolveLicenseProduct(payload.product);
      if (!product) {
        return sendJson(res, 400, { success: false, message: 'Selecciona un producto válido.' });
      }
      payload = {
        ...payload,
        product: product.name,
        product_id: product.id,
        product_prefix: product.prefix,
        generated_by: remoteSession.username
      };
    }
    if (action === 'users') {
      payload = { ...payload, method: req.method };
      if (req.method === 'DELETE') payload.username = searchParams.get('username') || '';
    }
    try {
      const remote = await remotePanelRequest(action, payload, remoteSession.remoteToken);
      return sendJson(res, remote.status, remote.data);
    } catch (_) {
      return sendJson(res, 503, { success: false, message: 'No se pudo conectar con la API segura de Supabase.' });
    }
  }

  if (pathname === '/api/owner/users' && req.method === 'GET') {
    let managed = [];
    const localManaged = readManagedUsers();
    const localMap = new Map();
    for (const u of localManaged) {
      localMap.set(u.username.toLowerCase(), u);
    }

    if (SupabaseDb.isConfigured()) {
      try {
        const su = await SupabaseDb.getPanelUsers();
        if (Array.isArray(su)) {
          managed = su.map(u => {
            const loc = localMap.get(u.username.toLowerCase()) || {};
            return {
              username: u.username,
              role: u.role,
              daily_limit: loc.daily_limit || 0,
              is_active: loc.is_active !== false,
              managed: !u.is_bootstrap
            };
          });
        }
      } catch (_) {}
    }
    if (!managed.length) {
      managed = localManaged.map(user => ({
        username: user.username,
        role: user.role,
        daily_limit: user.daily_limit || 0,
        is_active: user.is_active !== false,
        managed: true
      }));
    }
    const bootstrap = bootstrapUsers();
    const finalUsers = [
      ...bootstrap,
      ...managed.filter(m => !bootstrap.some(b => b.username.toLowerCase() === m.username.toLowerCase()))
    ];
    return sendJson(res, 200, { success: true, users: finalUsers });
  }

  if (pathname === '/api/owner/users' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const role = body.role === 'seller' ? 'seller' : 'admin';
    const dailyLimit = Math.max(0, parseInt(body.daily_limit || 0, 10));

    if (!/^[A-Za-z0-9_.-]{3,32}$/.test(username)) {
      return sendJson(res, 400, { success: false, message: 'El usuario debe tener entre 3 y 32 caracteres (letras, números, punto, guion o guion bajo).' });
    }
    if (password.length < 6 || password.length > 128) {
      return sendJson(res, 400, { success: false, message: 'La contraseña debe tener al menos 6 caracteres.' });
    }
    const existing = [...bootstrapUsers(), ...readManagedUsers()];
    if (existing.some(user => user.username.toLowerCase() === username.toLowerCase())) {
      return sendJson(res, 409, { success: false, message: 'Ya existe una cuenta con ese usuario.' });
    }
    if (SupabaseDb.isConfigured()) {
      try {
        const su = await SupabaseDb.getPanelUsers();
        if (Array.isArray(su) && su.some(u => u.username.toLowerCase() === username.toLowerCase())) {
          return sendJson(res, 409, { success: false, message: 'Ya existe una cuenta con ese usuario en Supabase.' });
        }
      } catch (_) {}
    }
    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(password, salt, 64).toString('hex');

    if (SupabaseDb.isConfigured()) {
      try {
        await SupabaseDb.createPanelUser({
          username,
          role,
          salt,
          password_hash: passwordHash,
          is_bootstrap: false
        });
      } catch (err) {
        console.error('[Supabase] Error al crear usuario en la nube:', err.message);
      }
    }

    const users = readManagedUsers();
    users.push({ username, role, salt, password_hash: passwordHash, daily_limit: dailyLimit, is_active: true });
    saveManagedUsers(users);
    return sendJson(res, 201, { success: true, message: `Cuenta ${role === 'admin' ? 'Admin' : 'Vendedor'} (${username}) guardada en Supabase y panel.`, user: { username, role, managed: true, daily_limit: dailyLimit, is_active: true } });
  }

  // Cambiar contraseña de cualquier Admin o Vendedor
  if (pathname === '/api/owner/users/change-password' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const username = String(body.username || '').trim();
    const newPassword = String(body.password || body.newPassword || '');

    if (!username || newPassword.length < 6) {
      return sendJson(res, 400, { success: false, message: 'La nueva contraseña debe tener al menos 6 caracteres.' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = crypto.scryptSync(newPassword, salt, 64).toString('hex');

    if (SupabaseDb.isConfigured()) {
      try {
        await SupabaseDb.updatePanelUser(username, { salt, password_hash: passwordHash });
      } catch (_) {}
    }

    const users = readManagedUsers();
    const idx = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
    if (idx !== -1) {
      users[idx].salt = salt;
      users[idx].password_hash = passwordHash;
      saveManagedUsers(users);
    }

    return sendJson(res, 200, { success: true, message: `Contraseña de ${username} actualizada con éxito.` });
  }

  // Configurar cuota de claves y estado activo/suspendido
  if (pathname === '/api/owner/users/set-quota' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const username = String(body.username || '').trim();
    const dailyLimit = Math.max(0, parseInt(body.daily_limit || 0, 10));
    const isActive = body.is_active !== false;
    const role = body.role === 'seller' ? 'seller' : 'admin';

    if (SupabaseDb.isConfigured()) {
      try {
        await SupabaseDb.updatePanelUser(username, { daily_limit: dailyLimit, is_active: isActive, role });
      } catch (_) {}
    }

    const users = readManagedUsers();
    const idx = users.findIndex(u => u.username.toLowerCase() === username.toLowerCase());
    if (idx !== -1) {
      users[idx].daily_limit = dailyLimit;
      users[idx].is_active = isActive;
      users[idx].role = role;
      saveManagedUsers(users);
    }

    return sendJson(res, 200, {
      success: true,
      message: `Configuración de ${username} guardada (Cuota: ${dailyLimit === 0 ? 'Ilimitada' : dailyLimit + '/día'}, Estado: ${isActive ? 'Activo' : 'Suspendido'}).`
    });
  }

  // BOTÓN DE EMERGENCIA: KILLSWITCH POR ADMIN / VENDEDOR
  if (pathname === '/api/owner/emergency-killswitch' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const targetUser = String(body.username || body.targetUser || '').trim();

    if (!targetUser) {
      return sendJson(res, 400, { success: false, message: 'Especifica el usuario para ejecutar el Killswitch.' });
    }

    let blockedCount = 0;
    let hwidsBanned = 0;

    if (SupabaseDb.isConfigured()) {
      const resK = await SupabaseDb.emergencyKillswitchByCreator(targetUser);
      blockedCount = resK.count || 0;
      hwidsBanned = resK.hwidsBanned || 0;
    }

    for (const lic of licenses) {
      if (lic.generated_by && lic.generated_by.toLowerCase() === targetUser.toLowerCase()) {
        lic.is_blocked = true;
        blockedCount++;
        if (lic.hwid && !bannedHwids.has(lic.hwid)) {
          bannedHwids.add(lic.hwid);
          hwidsBanned++;
        }
      }
    }
    saveDatabase();
    saveBannedHwids();

    return sendJson(res, 200, {
      success: true,
      message: `KILLSWITCH EJECUTADO: ${blockedCount} claves bloqueadas y ${hwidsBanned} HWIDs baneados vinculados a "${targetUser}".`,
      count: blockedCount,
      hwidsBanned
    });
  }

  // BOTÓN DE PÁNICO: KILLSWITCH GLOBAL MAESTRO
  if (pathname === '/api/owner/global-killswitch' && req.method === 'POST') {
    let count = 0;
    if (SupabaseDb.isConfigured()) {
      try {
        const allK = await SupabaseDb.getKeys();
        if (Array.isArray(allK)) {
          for (const k of allK) {
            if (!k.is_blocked) {
              await SupabaseDb.updateKey(k.key, { is_blocked: true });
              count++;
            }
          }
        }
      } catch (_) {}
    }
    for (const lic of licenses) {
      if (!lic.is_blocked) {
        lic.is_blocked = true;
        count++;
      }
    }
    saveDatabase();

    return sendJson(res, 200, {
      success: true,
      message: `KILLSWITCH MAESTRO ACTIVADO: ${count} licencias activas fueron suspendidas de emergencia.`,
      count
    });
  }

  // PURGAR LLAVES EXPIRADAS
  if (pathname === '/api/owner/purge-expired' && req.method === 'POST') {
    const now = new Date();
    const toDelete = [];
    licenses.forEach(lic => {
      const exp = lic.expires_at ? new Date(lic.expires_at) : null;
      if (lic.is_expired || (exp && exp < now)) {
        toDelete.push(lic.key);
      }
    });

    if (SupabaseDb.isConfigured()) {
      for (const k of toDelete) {
        try {
          await SupabaseDb.deleteKey(k);
        } catch (_) {}
      }
    }

    const setDel = new Set(toDelete);
    licenses = licenses.filter(l => !setDel.has(l.key));
    saveDatabase();

    return sendJson(res, 200, {
      success: true,
      message: `Se purgaron exitosamente ${toDelete.length} llaves vencidas de la base de datos.`,
      count: toDelete.length
    });
  }

  // DESCARGAR BACKUP COMPLETO (JSON)
  if (pathname === '/api/owner/backup' && req.method === 'GET') {
    const backupData = {
      exported_at: new Date().toISOString(),
      server: 'UiXtream Ring 0 License Hub',
      total_keys: licenses.length,
      keys: licenses,
      banned_hwids: bannedHwids,
      team_accounts: readManagedUsers()
    };
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="uix-backup-${Date.now()}.json"`,
      ...CORS_HEADERS
    });
    return res.end(JSON.stringify(backupData, null, 2));
  }

  if (pathname === '/api/owner/users' && req.method === 'DELETE') {
    const username = searchParams.get('username') || '';
    if (SupabaseDb.isConfigured()) {
      try {
        await SupabaseDb.deletePanelUser(username);
      } catch (_) {}
    }
    const users = readManagedUsers();
    const updated = users.filter(user => user.username.toLowerCase() !== username.toLowerCase());
    if (updated.length === users.length) return sendJson(res, 404, { success: false, message: 'Solo se pueden quitar las cuentas creadas desde el panel.' });
    saveManagedUsers(updated);
    return sendJson(res, 200, { success: true, message: `Cuenta ${username} eliminada.` });
  }

  // =========================================================================
  // API: ACTIVACION DE LICENCIA (Para la App C++)
  // Soporta tanto POST con JSON como GET con Query Params
  // =========================================================================
  if (pathname === '/api/license/activate') {
    let key = '';
    let hwid = '';
    let productValue = '';

    if (req.method === 'POST') {
      const body = await parseJsonBody(req);
      key = body.key || '';
      hwid = body.hwid || '';
      productValue = body.product || '';
    } else {
      key = searchParams.get('key') || '';
      hwid = searchParams.get('hwid') || '';
      productValue = searchParams.get('product') || '';
    }

    key = key.trim();
    hwid = hwid.trim();
    const product = resolveLicenseProduct(productValue);

    if (!key) {
      return sendJson(res, 400, { success: false, message: 'Se requiere una clave de licencia.' });
    }
    if (!product) {
      return sendJson(res, 400, { success: false, message: 'Se requiere un producto válido (only_aim, externalux, privateux, colorbot o skins).' });
    }
    if (!keyPrefixMatchesProduct(key, product)) {
      return sendJson(res, 403, { success: false, code: 'PRODUCT_MISMATCH', message: 'Esta key pertenece a otro producto.' });
    }

    // Comprobación de Baneo de HWID / Máquina
    let isBanned = false;
    if (hwid) {
      if (bannedHwids.includes(hwid) || bannedHwids.includes(hwid.toUpperCase())) isBanned = true;
      if (!isBanned && SupabaseDb.isConfigured()) {
        try {
          const supaBans = await SupabaseDb.getBannedHwids();
          if (supaBans && (supaBans.includes(hwid) || supaBans.includes(hwid.toUpperCase()))) isBanned = true;
        } catch (e) {}
      }
    }
    if (isBanned) {
      return sendJson(res, 403, { 
        success: false, 
        message: 'ACCESO DENEGADO / BANEADO: Esta computadora (HWID) ha sido BANEADA permanentemente por el administrador.' 
      });
    }

    // 1. Soporte Supabase Cloud en activacion
    if (SupabaseDb.isConfigured()) {
      try {
        const supaLic = await SupabaseDb.getKey(key);
        if (supaLic) {
          if (!licenseMatchesProduct(supaLic, key, product)) {
            return sendJson(res, 403, { success: false, code: 'PRODUCT_MISMATCH', message: 'Esta key pertenece a otro producto.' });
          }
          const isBlocked = (supaLic.status === 'blocked');
          if (isBlocked) {
            return sendJson(res, 403, {
              success: false,
              message: 'Clave DENEGADA / BANEADA: Esta licencia ha sido bloqueada/revocada por el administrador.'
            });
          }

          const nowSec = Math.floor(Date.now() / 1000);
          const isLifetime = (supaLic.duration === 'lifetime');

          if (!supaLic.hwid) {
            // Primera activación
            const durSec = supabaseDurationHours(supaLic) * 3600;

            const newExpires = isLifetime ? 0 : (nowSec + durSec);
            await SupabaseDb.updateKey(supaLic.key, {
              hwid: hwid || 'HWID-AUTO',
              status: 'active',
              activated_at: nowSec,
              expires_at: newExpires
            });
            supaLic.hwid = hwid || 'HWID-AUTO';
            supaLic.expires_at = newExpires;
          } else {
            // Ya activada: verificar HWID
            if (hwid && supaLic.hwid !== hwid) {
              return sendJson(res, 403, {
                success: false,
                message: 'Clave vinculada a otra PC. Pide al administrador resetear el HWID.'
              });
            }
            // Verificar expiración
            if (!isLifetime && supaLic.expires_at > 0 && nowSec >= supaLic.expires_at) {
              return sendJson(res, 403, {
                success: false,
                message: 'Tu suscripcion ha expirado. Contacta al administrador para renovar.'
              });
            }
          }

          let remainingSeconds = isLifetime ? 999999999 : Math.max(0, (supaLic.expires_at || (nowSec + 86400)) - nowSec);
          const typeName = supabaseDurationLabel(supaLic.duration, supaLic.custom_days);

          return sendJson(res, 200, {
            success: true,
            key: supaLic.key,
            product: product.id,
            duration_type: typeName,
            is_lifetime: isLifetime,
            expires_at: supaLic.expires_at ? supaLic.expires_at * 1000 : null,
            remaining_seconds: remainingSeconds,
            hwid: supaLic.hwid,
            note: supaLic.note,
            message: 'Licencia By UiXtream (Supabase Cloud) validada exitosamente.'
          });
        }
      } catch (err) {
        console.error('[Supabase] Error en activate:', err);
      }
    }

    const lic = licenses.find(l => l.key.toLowerCase() === key.toLowerCase());
    if (!lic) {
      return sendJson(res, 404, { success: false, message: 'Clave de licencia invalida o inexistente.' });
    }
    if (!licenseMatchesProduct(lic, key, product)) {
      return sendJson(res, 403, { success: false, code: 'PRODUCT_MISMATCH', message: 'Esta key pertenece a otro producto.' });
    }

    if (lic.is_blocked) {
      return sendJson(res, 403, { 
        success: false, 
        message: 'Clave DENEGADA / BANEADA: Esta licencia ha sido bloqueada/revocada por el administrador.' 
      });
    }

    const now = Date.now();

    // Si aún no ha sido activada, la vinculamos a esta PC
    if (!lic.hwid) {
      lic.hwid = hwid || 'HWID-AUTO';
      lic.activated_at = now;
      if (!lic.is_lifetime) {
        lic.expires_at = now + (lic.duration_hours * 3600 * 1000);
      }
      saveDatabase();
    } else {
      // Ya fue activada antes: verificar HWID
      if (hwid && lic.hwid !== hwid) {
        return sendJson(res, 403, { 
          success: false, 
          message: 'Clave vinculada a otra PC. Pide al administrador resetear el HWID.' 
        });
      }

      // Verificar expiración si no es lifetime
      if (!lic.is_lifetime && lic.expires_at && now > lic.expires_at) {
        return sendJson(res, 403, { 
          success: false, 
          message: 'Tu suscripcion ha expirado. Contacta al administrador para renovar.' 
        });
      }
    }

    let remainingSeconds = 0;
    if (lic.is_lifetime) {
      remainingSeconds = 999999999;
    } else if (lic.expires_at) {
      remainingSeconds = Math.max(0, Math.floor((lic.expires_at - now) / 1000));
    }

    return sendJson(res, 200, {
      success: true,
      key: lic.key,
      product: product.id,
      duration_type: lic.duration_type,
      is_lifetime: lic.is_lifetime,
      expires_at: lic.expires_at,
      remaining_seconds: remainingSeconds,
      hwid: lic.hwid,
      note: lic.note,
      message: 'Licencia By UiXtream validada exitosamente.'
    });
  }

  // =========================================================================
  // API: CHECK PERIODICO (Heartbeat silencioso desde la App C++)
  // =========================================================================
  if (pathname === '/api/license/check') {
    const key = (searchParams.get('key') || '').trim();
    const hwid = (searchParams.get('hwid') || '').trim();
    const product = resolveLicenseProduct(searchParams.get('product'));

    if (!key) {
      return sendJson(res, 400, { valid: false, message: 'Falta parametro key' });
    }
    if (!product) {
      return sendJson(res, 400, { valid: false, message: 'Falta parametro product (only_aim, externalux, privateux, colorbot o skins).' });
    }
    if (!keyPrefixMatchesProduct(key, product)) {
      return sendJson(res, 200, { valid: false, blocked: true, code: 'PRODUCT_MISMATCH', message: 'Esta key pertenece a otro producto.' });
    }

    // Comprobación de Baneo de HWID / Máquina
    let isBanned = false;
    if (hwid) {
      if (bannedHwids.includes(hwid) || bannedHwids.includes(hwid.toUpperCase())) isBanned = true;
      if (!isBanned && SupabaseDb.isConfigured()) {
        try {
          const supaBans = await SupabaseDb.getBannedHwids();
          if (supaBans && (supaBans.includes(hwid) || supaBans.includes(hwid.toUpperCase()))) isBanned = true;
        } catch (e) {}
      }
    }
    if (isBanned) {
      return sendJson(res, 200, { valid: false, blocked: true, message: 'HWID BANEADO permanentemente' });
    }

    // Comprobar con Supabase si está configurado
    if (SupabaseDb.isConfigured()) {
      try {
        const supaLic = await SupabaseDb.getKey(key);
        if (supaLic) {
          if (!licenseMatchesProduct(supaLic, key, product)) {
            return sendJson(res, 200, { valid: false, blocked: true, code: 'PRODUCT_MISMATCH', message: 'Esta key pertenece a otro producto.' });
          }
          const isBlocked = (supaLic.status === 'blocked');
          if (isBlocked) {
            return sendJson(res, 200, { valid: false, blocked: true, message: 'Clave revocada por administrador' });
          }
          if (hwid && supaLic.hwid && supaLic.hwid !== hwid) {
            return sendJson(res, 200, { valid: false, blocked: true, message: 'HWID no coincide' });
          }
          const nowSec = Math.floor(Date.now() / 1000);
          const isLifetime = (supaLic.duration === 'lifetime');
          if (!isLifetime && supaLic.expires_at > 0 && nowSec >= supaLic.expires_at) {
            return sendJson(res, 200, { valid: false, expired: true, message: 'Licencia expirada' });
          }
          let remainingSeconds = isLifetime ? 999999999 : Math.max(0, (supaLic.expires_at || nowSec) - nowSec);
          return sendJson(res, 200, {
            valid: true,
            product: product.id,
            blocked: false,
            expired: false,
            is_lifetime: isLifetime,
            remaining_seconds: remainingSeconds
          });
        }
      } catch (err) {
        console.error('[Supabase] Error en check:', err);
      }
    }

    const lic = licenses.find(l => l.key.toLowerCase() === key.toLowerCase());
    if (!lic) {
      return sendJson(res, 200, { valid: false, blocked: true, message: 'Clave inexistente' });
    }

    if (lic.is_blocked) {
      return sendJson(res, 200, { valid: false, blocked: true, message: 'Clave revocada por administrador' });
    }
    if (!licenseMatchesProduct(lic, key, product)) {
      return sendJson(res, 200, { valid: false, blocked: true, code: 'PRODUCT_MISMATCH', message: 'Esta key pertenece a otro producto.' });
    }

    if (hwid && lic.hwid && lic.hwid !== hwid) {
      return sendJson(res, 200, { valid: false, blocked: true, message: 'HWID no coincide' });
    }

    const now = Date.now();
    if (!lic.is_lifetime && lic.expires_at && now > lic.expires_at) {
      return sendJson(res, 200, { valid: false, expired: true, message: 'Licencia expirada' });
    }

    let remainingSeconds = lic.is_lifetime ? 999999999 : Math.max(0, Math.floor(((lic.expires_at || now) - now) / 1000));

    return sendJson(res, 200, {
      valid: true,
      product: product.id,
      blocked: false,
      expired: false,
      is_lifetime: lic.is_lifetime,
      remaining_seconds: remainingSeconds
    });
  }

  // =========================================================================
  // API ADMIN: OBTENER ESTADISTICAS Y TODAS LAS CLAVES
  // =========================================================================
  if (pathname === '/api/admin/keys' && req.method === 'GET') {
    if (SupabaseDb.isConfigured()) {
      try {
        const supaKeys = await SupabaseDb.getKeys();
        const supaBans = await SupabaseDb.getBannedHwids();
        const nowSec = Math.floor(Date.now() / 1000);

        const list = (supaKeys || []).map(l => {
          let status = 'disponible';
          const isBlocked = (l.status === 'blocked');
          const isLifetime = (l.duration === 'lifetime');
          const isExpired = (l.status === 'expired' || (!isLifetime && l.expires_at > 0 && nowSec >= l.expires_at));

          if (isBlocked) {
            status = 'bloqueada';
          } else if (!l.hwid) {
            status = 'disponible';
          } else if (isExpired) {
            status = 'expirada';
          } else {
            status = 'activa';
          }

          let remainingMs = 0;
          if (isLifetime) {
            remainingMs = -1;
          } else if (l.expires_at > 0) {
            remainingMs = Math.max(0, (l.expires_at - nowSec) * 1000);
          }

          const typeName = supabaseDurationLabel(l.duration, l.custom_days);

          return {
            id: l.id,
            key: l.key,
            duration_type: typeName,
            note: l.note || 'Cliente',
            product: l.product || 'Only Aim',
            generated_by: l.generated_by || 'No registrado',
            created_at: l.created_at ? new Date(l.created_at).getTime() : Date.now(),
            activated_at: l.activated_at ? l.activated_at * 1000 : null,
            expires_at: l.expires_at ? l.expires_at * 1000 : null,
            hwid: l.hwid || null,
            status: status,
            is_blocked: isBlocked,
            is_lifetime: isLifetime,
            remaining_ms: remainingMs
          };
        });

        return sendJson(res, 200, {
          success: true,
          cloud: true,
          total: list.length,
          keys: list,
          banned_hwids: supaBans || []
        });
      } catch (err) {
        console.error('[Supabase] Error en GET /api/admin/keys:', err);
      }
    }

    const now = Date.now();
    const list = licenses.map(l => {
      let status = 'disponible';
      if (l.is_blocked) {
        status = 'bloqueada';
      } else if (!l.hwid) {
        status = 'disponible';
      } else if (!l.is_lifetime && l.expires_at && now > l.expires_at) {
        status = 'expirada';
      } else {
        status = 'activa';
      }

      let remainingMs = 0;
      if (l.is_lifetime) {
        remainingMs = -1; // infinito
      } else if (l.expires_at) {
        remainingMs = Math.max(0, l.expires_at - now);
      }

      return {
        ...l,
        product: l.product || (LICENSE_PRODUCTS.find(product => product.prefix === String(l.key || '').trim().split('-', 1)[0].toUpperCase())?.name || 'Only Aim'),
        generated_by: l.generated_by || 'No registrado',
        status,
        remaining_ms: remainingMs
      };
    });

    return sendJson(res, 200, {
      success: true,
      total: list.length,
      keys: list,
      banned_hwids: bannedHwids
    });
  }

  // =========================================================================
  // API ADMIN: GENERAR NUEVA CLAVE
  // =========================================================================
  if (pathname === '/api/admin/keys/generate' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const duration = body.duration || '7d';
    const note = (body.note || 'Cliente').trim();
    const product = resolveLicenseProduct(body.product);
    if (!product) {
      return sendJson(res, 400, { success: false, message: 'Selecciona un producto válido.' });
    }
    const generatedBy = session.username;

    // Control estricto de Cuotas y Estado (Activo / Suspendido) para Admins y Vendedores
    if (session.role !== 'owner') {
      let targetUser = null;
      if (SupabaseDb.isConfigured()) {
        try {
          const su = await SupabaseDb.getPanelUsers();
          if (Array.isArray(su)) {
            targetUser = su.find(u => u.username.toLowerCase() === generatedBy.toLowerCase());
          }
        } catch (_) {}
      }
      if (!targetUser) {
        targetUser = readManagedUsers().find(u => u.username.toLowerCase() === generatedBy.toLowerCase());
      }
      if (targetUser) {
        if (targetUser.is_active === false) {
          return sendJson(res, 403, { success: false, message: 'Tu cuenta está suspendida. No puedes generar licencias.' });
        }
        if (targetUser.daily_limit && targetUser.daily_limit > 0) {
          const now = new Date();
          const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
          let todayCount = 0;
          if (SupabaseDb.isConfigured()) {
            const allK = await SupabaseDb.getKeys();
            if (Array.isArray(allK)) {
              todayCount = allK.filter(k => k.generated_by && k.generated_by.toLowerCase() === generatedBy.toLowerCase() && k.created_at >= startOfDay).length;
            }
          } else {
            todayCount = licenses.filter(k => k.generated_by && k.generated_by.toLowerCase() === generatedBy.toLowerCase() && k.created_at >= startOfDay).length;
          }
          if (todayCount + qty > targetUser.daily_limit) {
            return sendJson(res, 403, {
              success: false,
              message: `Límite diario alcanzado (${todayCount}/${targetUser.daily_limit} hoy). Contacta al Owner.`
            });
          }
        }
      }
    }

    let durationHours = 168; // default 7d
    let isLifetime = false;
    let typeName = duration;
    let supaDuration = '7_days';
    let customDays = 0;

    switch (duration) {
      case '1h':
        durationHours = 1;
        typeName = '1 Hora';
        supaDuration = '1_hour';
        break;
      case '1d':
        durationHours = 24;
        typeName = '1 Dia';
        supaDuration = '1_day';
        break;
      case '3d':
        durationHours = 72;
        typeName = '3 Dias';
        supaDuration = 'custom';
        customDays = 3;
        break;
      case '7d':
        durationHours = 168;
        typeName = '7 Dias';
        supaDuration = '7_days';
        break;
      case '15d':
        durationHours = 360;
        typeName = '15 Dias';
        supaDuration = 'custom';
        customDays = 15;
        break;
      case '30d':
        durationHours = 720;
        typeName = '30 Dias';
        supaDuration = '30_days';
        break;
      case '90d':
        durationHours = 2160;
        typeName = '90 Dias';
        supaDuration = 'custom';
        customDays = 90;
        break;
      case 'lifetime':
        durationHours = 0;
        isLifetime = true;
        typeName = 'Permanente (Lifetime)';
        supaDuration = 'lifetime';
        break;
      case 'custom':
        {
          const customUnit = body.custom_unit === 'days' ? 'days' : 'hours';
          const customAmount = Math.floor(Number(body.custom_amount ?? body.custom_hours ?? 24));
          const maxAmount = session.role === 'owner'
            ? (customUnit === 'hours' ? 8760000 : 365000)
            : (customUnit === 'hours' ? ADMIN_MAX_HOURS : ADMIN_MAX_HOURS / 24);
          if (!Number.isFinite(customAmount) || customAmount < 1 || customAmount > maxAmount) {
            return sendJson(res, 400, {
              success: false,
              message: `Duración inválida. Usa entre 1 y ${maxAmount} ${customUnit === 'hours' ? 'horas' : 'días'}.`
            });
          }

          durationHours = customUnit === 'hours' ? customAmount : customAmount * 24;
          typeName = `${customAmount} ${customUnit === 'hours' ? (customAmount === 1 ? 'Hora' : 'Horas') : (customAmount === 1 ? 'Día' : 'Días')}`;
          supaDuration = customUnit === 'hours' ? `custom_hours_${customAmount}` : 'custom';
          customDays = customUnit === 'days' ? customAmount : 0;
        }
        break;
      default:
        durationHours = 168;
        typeName = '7 Dias';
        supaDuration = '7_days';
    }

    if (session.role !== 'owner' && (isLifetime || durationHours > ADMIN_MAX_HOURS)) {
      return sendJson(res, 400, { success: false, message: 'Admin y Vendedor pueden crear claves de hasta 15 semanas (105 días).' });
    }

    let newKey = '';
    for (let attempt = 0; attempt < 5 && !newKey; attempt++) {
      const candidate = generateKey(product);
      const existing = SupabaseDb.isConfigured()
        ? await SupabaseDb.getKey(candidate)
        : licenses.some(license => license.key.toLowerCase() === candidate.toLowerCase());
      if (!existing) newKey = candidate;
    }
    if (!newKey) {
      return sendJson(res, 503, { success: false, message: 'No se pudo generar una key única. Intenta de nuevo.' });
    }

    if (SupabaseDb.isConfigured()) {
      try {
        const inserted = await SupabaseDb.insertKey({
          key: newKey,
          duration: supaDuration,
          custom_days: customDays,
          status: 'unused',
          hwid: null,
          note: note,
          product: product.name,
          generated_by: generatedBy
        });
        if (!inserted) {
          return sendJson(res, 502, { success: false, message: 'Supabase no guardó la key. Aplica la migración de producto y vendedor e intenta de nuevo.' });
        }
        return sendJson(res, 201, {
          success: true,
          message: 'Clave generada y guardada en Supabase Cloud (24/7)',
          key: {
            key: newKey,
            duration_type: typeName,
            note: note,
            product: product.name,
            product_id: product.id,
            generated_by: generatedBy,
            status: 'disponible',
            is_blocked: false,
            is_lifetime: isLifetime
          }
        });
      } catch (err) {
        console.error('[Supabase] Error al crear clave:', err);
        return sendJson(res, 502, { success: false, message: 'No se pudo guardar la key en Supabase.' });
      }
    }

    const newRecord = {
      key: newKey,
      duration_type: typeName,
      duration_hours: durationHours,
      note: note,
      product: product.name,
      product_id: product.id,
      generated_by: generatedBy,
      created_at: Date.now(),
      activated_at: null,
      expires_at: null,
      hwid: null,
      is_blocked: false,
      is_lifetime: isLifetime
    };

    licenses.unshift(newRecord);
    saveDatabase();

    return sendJson(res, 201, {
      success: true,
      message: 'Clave generada con exito',
      key: newRecord
    });
  }

  // =========================================================================
  // API ADMIN: BLOQUEAR / DESBLOQUEAR CLAVE
  // =========================================================================
  if (pathname === '/api/admin/keys/block' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const key = (body.key || '').trim();
    const shouldBlock = body.is_blocked !== undefined ? Boolean(body.is_blocked) : true;

    if (SupabaseDb.isConfigured()) {
      // Al desbloquear: si la clave nunca se vinculó vuelve a 'unused', si no a 'active'
      let newStatus = 'blocked';
      if (!shouldBlock) {
        const current = await SupabaseDb.getKey(key);
        newStatus = current && current.hwid ? 'active' : 'unused';
      }
      const ok = await SupabaseDb.updateKey(key, { status: newStatus });
      if (!ok) return sendJson(res, 502, { success: false, message: 'Supabase rechazó el cambio.' });
      return sendJson(res, 200, {
        success: true,
        message: shouldBlock ? 'Clave bloqueada y revocada en Supabase.' : 'Clave desbloqueada y restaurada en Supabase.',
        is_blocked: shouldBlock
      });
    }

    const lic = licenses.find(l => l.key.toLowerCase() === key.toLowerCase());
    if (!lic) {
      return sendJson(res, 404, { success: false, message: 'Clave no encontrada' });
    }

    lic.is_blocked = body.is_blocked !== undefined ? Boolean(body.is_blocked) : !lic.is_blocked;
    saveDatabase();

    return sendJson(res, 200, {
      success: true,
      message: lic.is_blocked ? 'Clave bloqueada y revocada.' : 'Clave desbloqueada y restaurada.',
      is_blocked: lic.is_blocked
    });
  }

  // =========================================================================
  // API ADMIN: RESETEAR HWID
  // =========================================================================
  if (pathname === '/api/admin/keys/reset-hwid' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const key = (body.key || '').trim();

    if (SupabaseDb.isConfigured()) {
      await SupabaseDb.updateKey(key, { hwid: null });
      return sendJson(res, 200, {
        success: true,
        message: 'HWID desvinculado con exito en Supabase. El usuario puede volver a activarla en su PC.'
      });
    }

    const lic = licenses.find(l => l.key.toLowerCase() === key.toLowerCase());
    if (!lic) {
      return sendJson(res, 404, { success: false, message: 'Clave no encontrada' });
    }

    lic.hwid = null;
    saveDatabase();

    return sendJson(res, 200, {
      success: true,
      message: 'HWID desvinculado con exito. El usuario puede volver a activarla en su PC.'
    });
  }

  // =========================================================================
  // API ADMIN: ELIMINAR CLAVE
  // =========================================================================
  if (pathname === '/api/admin/keys/delete' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const key = (body.key || '').trim();

    if (SupabaseDb.isConfigured()) {
      await SupabaseDb.deleteKey(key);
      return sendJson(res, 200, { success: true, message: 'Clave eliminada permanentemente de Supabase' });
    }

    const initialLen = licenses.length;
    licenses = licenses.filter(l => l.key.toLowerCase() !== key.toLowerCase());
    if (licenses.length === initialLen) {
      return sendJson(res, 404, { success: false, message: 'Clave no encontrada' });
    }

    saveDatabase();
    return sendJson(res, 200, { success: true, message: 'Clave eliminada permanentemente' });
  }

  // =========================================================================
  // API ADMIN: BANEAR COMPUTADORA (HWID)
  // =========================================================================
  if (pathname === '/api/admin/hwid/ban' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const hwid = (body.hwid || '').trim();

    if (!hwid) {
      return sendJson(res, 400, { success: false, message: 'Se requiere el HWID para banear.' });
    }

    if (SupabaseDb.isConfigured()) {
      await SupabaseDb.banHwid(hwid);
      return sendJson(res, 200, {
        success: true,
        message: `Computadora (HWID: ${hwid}) BANEADA en Supabase permanentemente.`,
        banned_hwids: await SupabaseDb.getBannedHwids()
      });
    }

    if (!bannedHwids.includes(hwid)) {
      bannedHwids.push(hwid);
      saveBannedHwids();
    }

    // Bloquear de inmediato todas las claves vinculadas a esa PC
    let blockedCount = 0;
    licenses.forEach(l => {
      if (l.hwid === hwid) {
        l.is_blocked = true;
        blockedCount++;
      }
    });
    saveDatabase();

    return sendJson(res, 200, {
      success: true,
      message: `Computadora (HWID: ${hwid}) BANEADA permanentemente. ${blockedCount} clave(s) revocada(s).`,
      banned_hwids: bannedHwids
    });
  }

  // =========================================================================
  // API ADMIN: DESBANEAR COMPUTADORA (HWID)
  // =========================================================================
  if (pathname === '/api/admin/hwid/unban' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const hwid = (body.hwid || '').trim();

    if (SupabaseDb.isConfigured()) {
      await SupabaseDb.unbanHwid(hwid);
      return sendJson(res, 200, {
        success: true,
        message: `Computadora (HWID: ${hwid}) desbaneada exitosamente de Supabase.`,
        banned_hwids: await SupabaseDb.getBannedHwids()
      });
    }

    bannedHwids = bannedHwids.filter(h => h.toLowerCase() !== hwid.toLowerCase());
    saveBannedHwids();

    return sendJson(res, 200, {
      success: true,
      message: `Computadora (HWID: ${hwid}) desbaneada exitosamente.`,
      banned_hwids: bannedHwids
    });
  }

  // =========================================================================
  // API ADMIN: DESACTIVAR CLAVE (vuelve a "disponible": sin HWID y sin tiempo corriendo)
  // =========================================================================
  if (pathname === '/api/admin/keys/deactivate' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const key = (body.key || '').trim();

    if (SupabaseDb.isConfigured()) {
      const ok = await SupabaseDb.updateKey(key, { status: 'unused', hwid: null, activated_at: 0, expires_at: 0 });
      if (!ok) return sendJson(res, 502, { success: false, message: 'Supabase rechazó el cambio.' });
      return sendJson(res, 200, { success: true, message: 'Clave desactivada: vuelve a estar disponible y el tiempo se reinicia al activarla.' });
    }

    const lic = licenses.find(l => l.key.toLowerCase() === key.toLowerCase());
    if (!lic) return sendJson(res, 404, { success: false, message: 'Clave no encontrada' });
    lic.hwid = null;
    lic.activated_at = null;
    lic.expires_at = null;
    lic.is_blocked = false;
    saveDatabase();
    return sendJson(res, 200, { success: true, message: 'Clave desactivada y disponible de nuevo.' });
  }

  // =========================================================================
  // API ADMIN: CAMBIAR HWID (mueve la licencia a otra PC conservando el tiempo)
  // =========================================================================
  if (pathname === '/api/admin/keys/set-hwid' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const key = (body.key || '').trim();
    const newHwid = (body.hwid || '').trim();

    if (!/^[A-Za-z0-9_-]{4,64}$/.test(newHwid)) {
      return sendJson(res, 400, { success: false, message: 'HWID inválido (usa el formato UIX-XXXX-XXXX que muestra la app).' });
    }

    if (SupabaseDb.isConfigured()) {
      const current = await SupabaseDb.getKey(key);
      if (!current) return sendJson(res, 404, { success: false, message: 'Clave no encontrada' });
      if (!current.hwid) {
        return sendJson(res, 409, { success: false, message: 'La clave aún no está activada; el cliente la vinculará solo al activarla.' });
      }
      const ok = await SupabaseDb.updateKey(key, { hwid: newHwid });
      if (!ok) return sendJson(res, 502, { success: false, message: 'Supabase rechazó el cambio.' });
      return sendJson(res, 200, { success: true, message: `HWID cambiado a ${newHwid}.` });
    }

    const lic = licenses.find(l => l.key.toLowerCase() === key.toLowerCase());
    if (!lic) return sendJson(res, 404, { success: false, message: 'Clave no encontrada' });
    lic.hwid = newHwid;
    saveDatabase();
    return sendJson(res, 200, { success: true, message: `HWID cambiado a ${newHwid}.` });
  }

  // =========================================================================
  // API ADMIN: EDITAR CLIENTE / NOTA DE UNA CLAVE
  // =========================================================================
  if (pathname === '/api/admin/keys/set-note' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const key = (body.key || '').trim();
    const note = String(body.note || '').trim();

    if (!key) {
      return sendJson(res, 400, { success: false, message: 'Falta especificar la clave.' });
    }

    if (SupabaseDb.isConfigured()) {
      const ok = await SupabaseDb.updateKeyNote(key, note);
      if (!ok) return sendJson(res, 502, { success: false, message: 'Supabase rechazó la actualización.' });
      return sendJson(res, 200, { success: true, message: 'Nota / Cliente actualizado.', key, note });
    }

    const lic = licenses.find(l => l.key.toLowerCase() === key.toLowerCase());
    if (!lic) return sendJson(res, 404, { success: false, message: 'Clave no encontrada.' });
    lic.note = note;
    saveDatabase();
    return sendJson(res, 200, { success: true, message: 'Nota / Cliente actualizado.', key, note });
  }

  // =========================================================================
  // API ADMIN: EXTENDER TIEMPO DE UNA CLAVE
  // =========================================================================
  if (pathname === '/api/admin/keys/extend' && req.method === 'POST') {
    const body = await parseJsonBody(req);
    const key = (body.key || '').trim();
    const unit = body.unit === 'hours' || body.hours !== undefined ? 'hours' : 'days';
    const amount = Math.floor(Number(body.amount ?? body.hours ?? body.days));
    const maxAmount = session.role === 'owner'
      ? (unit === 'hours' ? 8760000 : 365000)
      : (unit === 'hours' ? ADMIN_MAX_HOURS : ADMIN_MAX_HOURS / 24);

    if (!Number.isFinite(amount) || amount < 1 || amount > maxAmount) {
      return sendJson(res, 400, {
        success: false,
        message: `Cantidad inválida. Usa entre 1 y ${maxAmount} ${unit === 'hours' ? 'horas' : 'días'}.`
      });
    }

    const addedHours = unit === 'hours' ? amount : amount * 24;
    const confirmation = `Se añadieron ${amount} ${unit === 'hours' ? (amount === 1 ? 'hora' : 'horas') : (amount === 1 ? 'día' : 'días')} a la licencia.`;

    if (SupabaseDb.isConfigured()) {
      const cur = await SupabaseDb.getKey(key);
      if (!cur) return sendJson(res, 404, { success: false, message: 'Clave no encontrada' });
      if (cur.duration === 'lifetime') {
        return sendJson(res, 409, { success: false, message: 'La clave ya es permanente.' });
      }

      const nowSec = Math.floor(Date.now() / 1000);
      let patch;
      if (cur.expires_at > 0) {
        // Ya corriendo/expirada: suma desde el vencimiento (o desde ahora si ya venció)
        patch = { expires_at: Math.max(cur.expires_at, nowSec) + addedHours * 3600 };
        if (cur.status === 'expired') patch.status = cur.hwid ? 'active' : 'unused';
      } else {
        // Aún no activada: amplía la duración que tendrá al activarse
        patch = {
          duration: `custom_hours_${supabaseDurationHours(cur) + addedHours}`,
          custom_days: 0
        };
      }
      const ok = await SupabaseDb.updateKey(key, patch);
      if (!ok) return sendJson(res, 502, { success: false, message: 'Supabase rechazó el cambio.' });
      return sendJson(res, 200, { success: true, message: confirmation });
    }

    const lic = licenses.find(l => l.key.toLowerCase() === key.toLowerCase());
    if (!lic) return sendJson(res, 404, { success: false, message: 'Clave no encontrada' });
    if (lic.is_lifetime) return sendJson(res, 409, { success: false, message: 'La clave ya es permanente.' });
    if (lic.expires_at) lic.expires_at = Math.max(lic.expires_at, Date.now()) + addedHours * 3600000;
    else lic.duration_hours += addedHours;
    saveDatabase();
    return sendJson(res, 200, { success: true, message: confirmation });
  }

  // =========================================================================
  // RUTA PRINCIPAL: PANEL WEB ADMINISTRATIVO (HTML + CSS + JS)
  // =========================================================================
  if (pathname === '/' || pathname === '/index.html') {
    const htmlPath = path.join(RESOURCE_DIR, 'public', 'index.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0'
      });
      fs.createReadStream(htmlPath).pipe(res);
      return;
    }
  }

  // Archivos estáticos en /public
  const staticPath = path.join(RESOURCE_DIR, 'public', pathname);
  if (fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    let contentType = 'text/plain';
    if (pathname.endsWith('.html')) contentType = 'text/html';
    else if (pathname.endsWith('.css')) contentType = 'text/css';
    else if (pathname.endsWith('.js')) contentType = 'application/javascript';
    else if (pathname.endsWith('.svg')) contentType = 'image/svg+xml';
    else if (pathname.endsWith('.gif')) contentType = 'image/gif';
    else if (pathname.endsWith('.glb')) contentType = 'model/gltf-binary';

    res.writeHead(200, { 'Content-Type': `${contentType}; charset=utf-8` });
    fs.createReadStream(staticPath).pipe(res);
    return;
  }

  // 404 por defecto
  sendJson(res, 404, { error: 'Ruta no encontrada' });
});

// Por defecto escucha solo en localhost; las rutas administrativas exigen sesión.
process.on('unhandledRejection', (err) => console.error('[Server] Error no controlado:', err));

server.listen(PORT, process.env.HOST || '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`  By UiXtream - Servidor de Licencias & Panel Web`);
  console.log(`=======================================================`);
  console.log(`  -> Panel Web de Administracion: http://localhost:${PORT}`);
  console.log(`  -> Endpoint para App C++:       http://localhost:${PORT}/api/license/activate`);
  console.log(`  -> Estado: ONLINE y Listo para generar/bloquear keys`);
  console.log(`=======================================================`);
  if (process.pkg && process.env.OPEN_PANEL !== 'false') {
    const panelUrl = `http://localhost:${PORT}`;
    const browser = spawn('rundll32.exe', ['url.dll,FileProtocolHandler', panelUrl], { detached: true, stdio: 'ignore' });
    browser.unref();
  }
});

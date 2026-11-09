const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const APP_DIR = process.pkg ? path.dirname(process.execPath) : __dirname;
const CONFIG_PATH = path.join(APP_DIR, 'supabase_config.json');
const ENV_PATH = path.join(APP_DIR, '.env');

function parseEnvFile(filePath) {
    if (!fs.existsSync(filePath)) return {};
    const content = fs.readFileSync(filePath, 'utf8');
    const result = {};
    for (const line of content.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
            const key = trimmed.slice(0, eqIdx).trim();
            const val = trimmed.slice(eqIdx + 1).trim();
            result[key] = val.replace(/^["']|["']$/g, '');
        }
    }
    return result;
}

function loadConfig() {
    try {
        // 1. Prioridad: variables de entorno o process.env
        if (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_KEY) {
            return {
                supabase_url: process.env.SUPABASE_URL,
                supabase_anon_key: process.env.SUPABASE_ANON_KEY || '',
                supabase_service_key: process.env.SUPABASE_SERVICE_KEY
            };
        }

        // 2. Archivo .env local
        if (fs.existsSync(ENV_PATH)) {
            const envVars = parseEnvFile(ENV_PATH);
            if (envVars.SUPABASE_URL && envVars.SUPABASE_SERVICE_KEY) {
                return {
                    supabase_url: envVars.SUPABASE_URL,
                    supabase_anon_key: envVars.SUPABASE_ANON_KEY || '',
                    supabase_service_key: envVars.SUPABASE_SERVICE_KEY
                };
            }
        }

        // 3. Fallback retrocompatible: supabase_config.json
        if (fs.existsSync(CONFIG_PATH)) {
            const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
            const cfg = JSON.parse(raw);
            if (cfg.supabase_url && cfg.supabase_service_key && !cfg.supabase_url.includes('TU_PROYECTO')) {
                return cfg;
            }
        }

        // 4. Fallback maestro del proyecto (requiere .env o supabase_config.json local)
        return {
            supabase_url: process.env.SUPABASE_URL || 'https://yqomkgcbzvdhuxzpyqry.supabase.co',
            supabase_anon_key: process.env.SUPABASE_ANON_KEY || 'sb_publishable_uG6A5hE_V_sSVOBzDDTdRA_bDXWVGeR',
            supabase_service_key: process.env.SUPABASE_SERVICE_KEY || ''
        };
    } catch (e) {
        console.error('[Supabase] Error cargando configuracion:', e.message);
    }
    return null;
}


function makeRequest(config, method, endpoint, body = null, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
        const fullUrl = config.supabase_url.replace(/\/+$/, '') + endpoint;
        const parsed = new URL(fullUrl);
        const isHttps = parsed.protocol === 'https:';
        const client = isHttps ? https : http;

        const headers = {
            'apikey': config.supabase_service_key,
            'Authorization': `Bearer ${config.supabase_service_key}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            ...extraHeaders
        };

        const postData = body ? JSON.stringify(body) : null;
        if (postData) {
            headers['Content-Length'] = Buffer.byteLength(postData);
        }

        const options = {
            hostname: parsed.hostname,
            port: parsed.port || (isHttps ? 443 : 80),
            path: parsed.pathname + parsed.search,
            method: method,
            headers: headers,
            timeout: 8000
        };

        const req = client.request(options, (res) => {
            let resData = '';
            res.on('data', chunk => { resData += chunk; });
            res.on('end', () => {
                let parsedJson = null;
                try {
                    parsedJson = resData ? JSON.parse(resData) : null;
                } catch (e) {
                    parsedJson = resData;
                }
                resolve({
                    statusCode: res.statusCode,
                    data: parsedJson
                });
            });
        });

        req.on('timeout', () => {
            req.destroy();
            reject(new Error('Timeout de conexion con Supabase'));
        });

        req.on('error', (err) => {
            reject(err);
        });

        if (postData) {
            req.write(postData);
        }
        req.end();
    });
}

// --- Operaciones de Licencias en Supabase ---
const SupabaseDb = {
    isConfigured() {
        return loadConfig() !== null;
    },

    getConfig() {
        return loadConfig();
    },

    async getKeys() {
        const cfg = loadConfig();
        if (!cfg) return null;
        const res = await makeRequest(cfg, 'GET', '/rest/v1/licenses?select=*&order=id.desc');
        if (res.statusCode >= 200 && res.statusCode < 300 && Array.isArray(res.data)) {
            return res.data;
        }
        console.error('[Supabase] Error getKeys:', res.statusCode, res.data);
        return [];
    },

    async getKey(keyStr) {
        const cfg = loadConfig();
        if (!cfg) return null;
        const res = await makeRequest(cfg, 'GET', `/rest/v1/licenses?key=ilike.${encodeURIComponent(keyStr)}&select=*&limit=1`);
        if (res.statusCode >= 200 && res.statusCode < 300 && Array.isArray(res.data)) {
            return res.data[0] || null;
        }
        return null;
    },

    async getBannedHwids() {
        const cfg = loadConfig();
        if (!cfg) return null;
        const res = await makeRequest(cfg, 'GET', '/rest/v1/banned_hwids?select=*');
        if (res.statusCode >= 200 && res.statusCode < 300 && Array.isArray(res.data)) {
            return res.data.map(b => b.hwid);
        }
        return [];
    },

    async insertKey(keyObj) {
        const cfg = loadConfig();
        if (!cfg) return null;
        const res = await makeRequest(cfg, 'POST', '/rest/v1/licenses', keyObj, {
            'Prefer': 'return=representation'
        });
        if (res.statusCode >= 200 && res.statusCode < 300) {
            return Array.isArray(res.data) ? res.data[0] : keyObj;
        }
        console.error('[Supabase] Error insertKey:', res.statusCode, res.data);
        return null;
    },

    async updateKey(keyStr, updateObj) {
        const cfg = loadConfig();
        if (!cfg) return null;
        const encodedKey = encodeURIComponent(keyStr);
        const res = await makeRequest(cfg, 'PATCH', `/rest/v1/licenses?key=ilike.${encodedKey}`, updateObj, {
            'Prefer': 'return=representation'
        });
        return res.statusCode >= 200 && res.statusCode < 300;
    },

    async deleteKey(keyStr) {
        const cfg = loadConfig();
        if (!cfg) return null;
        const encodedKey = encodeURIComponent(keyStr);
        const res = await makeRequest(cfg, 'DELETE', `/rest/v1/licenses?key=ilike.${encodedKey}`);
        return res.statusCode >= 200 && res.statusCode < 300;
    },

    async banHwid(hwidStr, reason = 'Baneado por admin') {
        const cfg = loadConfig();
        if (!cfg) return null;
        const res = await makeRequest(cfg, 'POST', '/rest/v1/banned_hwids', {
            hwid: hwidStr,
            reason: reason
        });
        return res.statusCode >= 200 && res.statusCode < 300;
    },

    async unbanHwid(hwidStr) {
        const cfg = loadConfig();
        if (!cfg) return null;
        const encoded = encodeURIComponent(hwidStr);
        const res = await makeRequest(cfg, 'DELETE', `/rest/v1/banned_hwids?hwid=eq.${encoded}`);
        return res.statusCode >= 200 && res.statusCode < 300;
    },

    async getPanelUsers() {
        const cfg = loadConfig();
        if (!cfg) return null;
        const res = await makeRequest(cfg, 'GET', '/rest/v1/panel_users?select=*');
        return Array.isArray(res.data) ? res.data : null;
    },

    async createPanelUser(userObj) {
        const cfg = loadConfig();
        if (!cfg) return null;
        const payload = {
            username: String(userObj.username || '').trim().toLowerCase(),
            role: userObj.role || 'seller',
            salt: userObj.salt,
            password_hash: userObj.password_hash,
            is_bootstrap: Boolean(userObj.is_bootstrap)
        };
        const res = await makeRequest(cfg, 'POST', '/rest/v1/panel_users', payload, {
            'Prefer': 'return=representation'
        });
        return res.statusCode >= 200 && res.statusCode < 300;
    },

    async updatePanelUser(username, updateObj) {
        const cfg = loadConfig();
        if (!cfg) return null;
        const encoded = encodeURIComponent(String(username || '').trim().toLowerCase());
        const payload = {};
        if (updateObj.salt) payload.salt = updateObj.salt;
        if (updateObj.password_hash) payload.password_hash = updateObj.password_hash;
        if (updateObj.role) payload.role = updateObj.role;
        if (Object.keys(payload).length === 0) return true;
        const res = await makeRequest(cfg, 'PATCH', `/rest/v1/panel_users?username=eq.${encoded}`, payload, {
            'Prefer': 'return=representation'
        });
        return res.statusCode >= 200 && res.statusCode < 300;
    },

    async deletePanelUser(username) {
        const cfg = loadConfig();
        if (!cfg) return null;
        const encoded = encodeURIComponent(String(username || '').trim().toLowerCase());
        const res = await makeRequest(cfg, 'DELETE', `/rest/v1/panel_users?username=eq.${encoded}`);
        return res.statusCode >= 200 && res.statusCode < 300;
    },

    async updateKeyNote(keyStr, note) {
        return this.updateKey(keyStr, { note: String(note || '') });
    },

    async emergencyKillswitchByCreator(creatorUsername) {
        const cfg = loadConfig();
        if (!cfg) return { success: false, message: 'Supabase no configurado' };
        const encoded = encodeURIComponent(creatorUsername);
        const res = await makeRequest(cfg, 'GET', `/rest/v1/licenses?generated_by=eq.${encoded}&select=*`);
        if (!Array.isArray(res.data)) return { success: false, message: 'No se pudieron consultar las licencias' };
        
        const keys = res.data;
        if (!keys.length) return { success: true, count: 0, hwidsBanned: 0 };

        // 1. Bloquear todas las claves
        await makeRequest(cfg, 'PATCH', `/rest/v1/licenses?generated_by=eq.${encoded}`, { is_blocked: true });

        // 2. Banear HWIDs vinculados
        let hwidsBanned = 0;
        for (const k of keys) {
            if (k.hwid && String(k.hwid).trim()) {
                try {
                    await this.banHwid(String(k.hwid).trim(), `Killswitch de Emergencia (Creador: ${creatorUsername})`);
                    hwidsBanned++;
                } catch (_) {}
            }
        }
        return { success: true, count: keys.length, hwidsBanned };
    }
};

module.exports = SupabaseDb;

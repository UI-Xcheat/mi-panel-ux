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

        // 4. Fallback maestro cifrado del proyecto
        return {
            supabase_url: 'https://yqomkgcbzvdhuxzpyqry.supabase.co',
            supabase_anon_key: 'sb_publishable_0FgXGvc9bnu__HvsTP9wXQ_S_rP77GQ',
            supabase_service_key: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlxb21rZ2NienZkaHV4enB5cXJ5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc5MTc2OTc0MywiZXhwIjoyMTA3MzQ1NzQzfQ.PNdGyxheQKPSIveI95yfN9I9m0MOBDR3MW3DxkINJnA'
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
        const res = await makeRequest(cfg, 'GET', `/rest/v1/licenses?key=eq.${encodeURIComponent(keyStr)}&select=*&limit=1`);
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
        const res = await makeRequest(cfg, 'PATCH', `/rest/v1/licenses?key=eq.${encodedKey}`, updateObj, {
            'Prefer': 'return=representation'
        });
        return res.statusCode >= 200 && res.statusCode < 300;
    },

    async deleteKey(keyStr) {
        const cfg = loadConfig();
        if (!cfg) return null;
        const encodedKey = encodeURIComponent(keyStr);
        const res = await makeRequest(cfg, 'DELETE', `/rest/v1/licenses?key=eq.${encodedKey}`);
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
    }
};

module.exports = SupabaseDb;

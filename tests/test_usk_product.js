const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const serverContent = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const fnSandbox = new Function('crypto', `
  ${serverContent.slice(serverContent.indexOf('const LICENSE_PRODUCTS'), serverContent.indexOf('function readPublicSupabaseConfig'))}
  ${serverContent.slice(serverContent.indexOf('function generateKey(product) {'), serverContent.indexOf('function supabaseDurationHours'))}
  return { LICENSE_PRODUCTS, resolveLicenseProduct, keyPrefixMatchesProduct, licenseMatchesProduct, generateKey };
`);

const api = fnSandbox(require('node:crypto'));
const skins = api.LICENSE_PRODUCTS.find((product) => product.id === 'skins');

assert.ok(skins, 'the skins license product must exist');
assert.deepEqual(skins, { id: 'skins', name: 'UiXtream Skins', prefix: 'USK' });
assert.equal(api.resolveLicenseProduct('skins')?.prefix, 'USK');
assert.equal(api.resolveLicenseProduct('UiXtream Skins')?.prefix, 'USK');
assert.equal(api.resolveLicenseProduct('usk')?.prefix, 'USK');

const key = api.generateKey(skins);
assert.match(key, /^USK-[A-Za-z0-9]{4}(?:-[A-Za-z0-9]{4}){3}$/);
assert.equal(api.keyPrefixMatchesProduct(key, skins), true);
assert.equal(api.keyPrefixMatchesProduct('CB-a1B2-c3D4-e5F6-g7H8', skins), false);
assert.equal(api.keyPrefixMatchesProduct('US-a1B2-c3D4-e5F6-g7H8', skins), false);
assert.equal(api.licenseMatchesProduct({ product: 'UiXtream Skins' }, key, skins), true);
assert.equal(api.licenseMatchesProduct({ product: 'ColorBot' }, key, skins), false);

const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
assert.match(html, /<option\s+value="skins">UiXtream Skins \(USK-\)<\/option>/);

const edge = fs.readFileSync(path.join(root, 'supabase', 'functions', 'panel-api', 'index.ts'), 'utf8');
assert.match(edge, /id:\s*'skins',[^\n]+prefix:\s*'USK'/);
assert.match(edge, /function keyCode\(product:/);
assert.match(edge, /return `\$\{product\.prefix\}-/);
assert.match(edge, /const product = resolveLicenseProduct\(body\.product\);[\s\S]{0,500}const key = keyCode\(product\);/);
assert.match(edge, /insert\(\{[^}]*product:\s*product\.name/);

console.log('USK LICENSE PRODUCT TESTS PASSED');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const serverFile = path.resolve(__dirname, '..', 'server.js');
const content = fs.readFileSync(serverFile, 'utf8');

// Extract LICENSE_PRODUCTS, resolveLicenseProduct, keyPrefixMatchesProduct, licenseMatchesProduct, generateKey
const fnSandbox = new Function('crypto', `
  ${content.slice(content.indexOf('const LICENSE_PRODUCTS'), content.indexOf('function readPublicSupabaseConfig'))}
  ${content.slice(content.indexOf('function generateKey(product) {'), content.indexOf('function supabaseDurationHours'))}
  return { LICENSE_PRODUCTS, resolveLicenseProduct, keyPrefixMatchesProduct, licenseMatchesProduct, generateKey };
`);

const { LICENSE_PRODUCTS, resolveLicenseProduct, keyPrefixMatchesProduct, licenseMatchesProduct, generateKey } = fnSandbox(require('node:crypto'));

// 1. Verify LICENSE_PRODUCTS contains ColorBot with prefix CB
const cbProduct = LICENSE_PRODUCTS.find(p => p.prefix === 'CB');
assert.ok(cbProduct, 'CB product should exist');
assert.equal(cbProduct.id, 'colorbot');
assert.equal(cbProduct.name, 'ColorBot');
assert.equal(cbProduct.prefix, 'CB');

// 2. Verify resolveLicenseProduct
assert.equal(resolveLicenseProduct('colorbot')?.prefix, 'CB');
assert.equal(resolveLicenseProduct('ColorBot')?.prefix, 'CB');
assert.equal(resolveLicenseProduct('cb')?.prefix, 'CB');
assert.equal(resolveLicenseProduct('CB')?.prefix, 'CB');
assert.equal(resolveLicenseProduct('uxcolor')?.prefix, 'CB');

// 3. Verify keyPrefixMatchesProduct
assert.equal(keyPrefixMatchesProduct('CB-a1B2-c3D4-e5F6-g7H8', cbProduct), true);
assert.equal(keyPrefixMatchesProduct('AX-a1B2-c3D4-e5F6-g7H8', cbProduct), false);
assert.equal(keyPrefixMatchesProduct('EX-a1B2-c3D4-e5F6-g7H8', cbProduct), false);
assert.equal(keyPrefixMatchesProduct('PX-a1B2-c3D4-e5F6-g7H8', cbProduct), false);
assert.equal(keyPrefixMatchesProduct('legacy-key-no-prefix', cbProduct), false);

// 4. Verify generateKey for CB
const key = generateKey(cbProduct);
assert.match(key, /^CB-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}-[A-Za-z0-9]{4}$/);

// 5. Verify licenseMatchesProduct
assert.equal(licenseMatchesProduct({ product: 'ColorBot' }, key, cbProduct), true);
assert.equal(licenseMatchesProduct({ product: 'Only Aim' }, key, cbProduct), false);
assert.equal(licenseMatchesProduct({ product: 'ExternalUX' }, key, cbProduct), false);

// 6. Verify index.html contains ColorBot option
const htmlContent = fs.readFileSync(path.resolve(__dirname, '..', 'public', 'index.html'), 'utf8');
assert.match(htmlContent, /<option\s+value="colorbot">ColorBot.*<\/option>/);

console.log('ALL CB LICENSE TESTS PASSED!');

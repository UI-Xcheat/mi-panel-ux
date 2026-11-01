const fs = require('fs');
const buf = fs.readFileSync('D:/Zero-Levi.glb');
const jsonLen = buf.readUInt32LE(12);
const jsonStr = buf.toString('utf8', 20, 20 + jsonLen);

function find_json_int(str, start, key) {
    let pos = str.indexOf('"' + key + '"', start);
    if (pos === -1) return -1;
    let colon = str.indexOf(':', pos);
    if (colon === -1) return -1;
    colon++;
    while (colon < str.length && (str[colon] === ' ' || str[colon] === '\t' || str[colon] === '\n' || str[colon] === '\r')) colon++;
    let num = parseInt(str.substring(colon), 10);
    return isNaN(num) ? -1 : num;
}

let curr = jsonStr.indexOf('"meshes"');
let primitives = [];
while (true) {
    let primPos = jsonStr.indexOf('"POSITION"', curr);
    if (primPos === -1) break;

    let posAcc = find_json_int(jsonStr, primPos, "POSITION");
    let idxAcc = find_json_int(jsonStr, primPos, "indices");

    console.log('primPos:', primPos, 'posAcc:', posAcc, 'idxAcc:', idxAcc);
    curr = primPos + 10;
}

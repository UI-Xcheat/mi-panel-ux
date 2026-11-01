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

// 4. Parsear BufferViews
let bufferViews = [];
let bvPos = jsonStr.indexOf('"bufferViews"');
if (bvPos !== -1) {
    let bOpen = jsonStr.indexOf('[', bvPos);
    let bClose = jsonStr.indexOf(']', bOpen);
    let curr = bOpen;
    while (curr < bClose) {
        let objOpen = jsonStr.indexOf('{', curr);
        if (objOpen === -1 || objOpen > bClose) break;
        let objClose = jsonStr.indexOf('}', objOpen);
        if (objClose === -1 || objClose > bClose) break;

        let objStr = jsonStr.substring(objOpen, objClose + 1);
        let bo = find_json_int(objStr, 0, "byteOffset");
        let bl = find_json_int(objStr, 0, "byteLength");
        bufferViews.push({
            byteOffset: bo >= 0 ? bo : 0,
            byteLength: bl >= 0 ? bl : 0
        });
        curr = objClose + 1;
    }
}
console.log('BufferViews found:', bufferViews.length);
console.log('First 5 bufferViews:', bufferViews.slice(0, 5));

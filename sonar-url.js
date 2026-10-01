// sonar-url.js
// 실행: node sonar-url.js   (같은 폴더의 payload.json 을 읽어 URL만 출력, API 호출 없음)
// 다른 파일: node sonar-url.js 경로\payload.json

const fs = require('fs');
const path = require('path');

const file = process.argv[2] || path.join(__dirname, 'payload.json');
const p = JSON.parse(fs.readFileSync(file, 'utf8'));

const base = p.serverUrl.replace(/\/$/, '');
const key = encodeURIComponent(p.project.key);
const pr = encodeURIComponent(String(p.branch.name).replace(/^PR-/i, ''));

console.log('project.key :', p.project.key);
console.log('PR 번호      :', p.branch.name);
console.log('');

console.log('[1] components + inNewCodePeriod');
console.log(`${base}/api/issues/search?components=${key}&pullRequest=${pr}&resolved=false&inNewCodePeriod=true`);
console.log('');

console.log('[2] componentKeys + inNewCodePeriod');
console.log(`${base}/api/issues/search?componentKeys=${key}&pullRequest=${pr}&resolved=false&inNewCodePeriod=true`);
console.log('');

console.log('[3] componentKeys (새 코드 필터 없음)');
console.log(`${base}/api/issues/search?componentKeys=${key}&pullRequest=${pr}&resolved=false`);
console.log('');

console.log('[UI 화면]');
console.log(`${base}/project/issues?id=${key}&pullRequest=${pr}&resolved=false&inNewCodePeriod=true`);
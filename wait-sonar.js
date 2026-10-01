// wait-sonar.js
// PR 번호를 받아 SonarQube 분석이 끝날 때까지 폴링 -> QG 판정 -> 실패 시 새 코드 이슈 수집
//
// 사용법:
//   set SONAR_URL=http://사내SonarIP:포트
//   set SONAR_TOKEN=발급받은토큰
//   set SONAR_PROJECT_KEY=dev_main_com.skhynix.oneoip:oneoip-ois
//   node wait-sonar.js <PR번호> [커밋sha]
//
//   - 커밋sha 를 주면: 그 커밋으로 분석된 결과가 올라올 때까지 대기 (방금 push 한 경우 필수)
//   - 커밋sha 가 없으면: 현재 올라와 있는 최신 분석 결과를 바로 사용 (이미 올린 PR 테스트용)
//
// 선택 환경변수:
//   POLL_INTERVAL_SEC (기본 15)   POLL_TIMEOUT_MIN (기본 15)   RESULT_DIR (기본 이 파일 폴더)
//
// 종료 코드: 0 = QG 통과, 1 = QG 실패, 2 = 타임아웃/오류
// 결과 파일: result-PR<번호>.json  (백그라운드 실행 시 여기서 확인)
//
// Node 18 이상 (내장 fetch). 외부 패키지 없음.

const fs = require('fs');
const path = require('path');

// ---------- 설정 ----------
const BASE = (process.env.SONAR_URL || '').replace(/\/$/, '');
const TOKEN = process.env.SONAR_TOKEN || '';
const PROJECT_KEY = process.env.SONAR_PROJECT_KEY || '';
const INTERVAL_MS = Number(process.env.POLL_INTERVAL_SEC || 15) * 1000;
const TIMEOUT_MS = Number(process.env.POLL_TIMEOUT_MIN || 15) * 60 * 1000;
const RESULT_DIR = process.env.RESULT_DIR || __dirname;

const PR = process.argv[2];
const SHA = (process.argv[3] || '').trim().toLowerCase();

if (!BASE || !TOKEN || !PROJECT_KEY || !PR) {
  console.error('필수: SONAR_URL, SONAR_TOKEN, SONAR_PROJECT_KEY 환경변수 + PR 번호 인자');
  console.error('예) node wait-sonar.js 8071 [커밋sha]');
  process.exit(2);
}

const AUTH = 'Basic ' + Buffer.from(`${TOKEN}:`).toString('base64');
const enc = encodeURIComponent;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toLocaleTimeString('ko-KR', { hour12: false });
const log = (...a) => console.log(`[${ts()}]`, ...a);

// ---------- Sonar 호출 ----------
async function sonarGet(pathAndQuery) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`${BASE}${pathAndQuery}`, {
      headers: { Authorization: AUTH },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) { /* JSON 아님 */ }
    if (!res.ok) {
      const msg = json?.errors?.map(e => e.msg).join(' / ') || text.slice(0, 200);
      throw new Error(`HTTP ${res.status} ${pathAndQuery.split('?')[0]} : ${msg}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

// 이 PR 에 대한 분석 작업이 대기/진행 중인지 (실패해도 무시)
async function isAnalysisPending() {
  try {
    const data = await sonarGet(`/api/ce/component?component=${enc(PROJECT_KEY)}`);
    const tasks = [...(data.queue || []), ...(data.current ? [data.current] : [])];
    return tasks.some(t =>
      String(t.pullRequest || '') === String(PR) &&
      ['PENDING', 'IN_PROGRESS'].includes(t.status));
  } catch (_) {
    return false;
  }
}

// PR 목록에서 내 PR 찾기
async function findPullRequest() {
  const data = await sonarGet(`/api/project_pull_requests/list?project=${enc(PROJECT_KEY)}`);
  return (data.pullRequests || []).find(p => String(p.key) === String(PR)) || null;
}

// ---------- 완료 대기 ----------
async function waitForAnalysis() {
  const started = Date.now();
  let lastNote = '';

  while (Date.now() - started < TIMEOUT_MS) {
    let note = '';
    try {
      const pr = await findPullRequest();

      if (!pr) {
        note = `PR ${PR} 아직 Sonar에 없음 (Jenkins 분석 대기 중)`;
      } else {
        const sonarSha = (pr.commit?.sha || '').toLowerCase();
        const shaMatched = !SHA || (sonarSha && (sonarSha.startsWith(SHA) || SHA.startsWith(sonarSha)));

        if (!shaMatched) {
          note = `이전 분석 결과만 있음 (Sonar sha=${sonarSha.slice(0, 8)}, 기다리는 sha=${SHA.slice(0, 8)})`;
        } else if (await isAnalysisPending()) {
          note = '분석 진행 중 (CE 큐)';
        } else {
          return pr; // 완료
        }
      }
    } catch (e) {
      note = `조회 오류, 재시도: ${e.message}`;
    }

    if (note !== lastNote) { log(note); lastNote = note; }
    await sleep(INTERVAL_MS);
  }
  throw new Error(`타임아웃 (${TIMEOUT_MS / 60000}분) - 분석 결과가 올라오지 않음`);
}

// ---------- QG 판정 ----------
async function getQualityGate() {
  const data = await sonarGet(
    `/api/qualitygates/project_status?projectKey=${enc(PROJECT_KEY)}&pullRequest=${enc(PR)}`);
  const ps = data.projectStatus;
  return {
    status: ps.status, // OK / ERROR
    failedConditions: (ps.conditions || [])
      .filter(c => c.status === 'ERROR')
      .map(c => ({
        metric: c.metricKey,
        actual: c.actualValue,
        operator: c.comparator,
        threshold: c.errorThreshold,
      })),
  };
}

// ---------- 새 코드 이슈 수집 ([2] 방식) ----------
async function getNewCodeIssues() {
  const issues = [];
  let page = 1;
  while (true) {
    const q = `/api/issues/search?componentKeys=${enc(PROJECT_KEY)}`
      + `&pullRequest=${enc(PR)}&resolved=false&inNewCodePeriod=true&ps=100&p=${page}`;
    const data = await sonarGet(q);
    issues.push(...(data.issues || []));
    const { total, pageSize } = data.paging;
    if (page * pageSize >= total) break;
    page++;
  }
  return issues.map(i => ({
    file: i.component.replace(`${PROJECT_KEY}:`, ''),
    line: i.line ?? null,
    endLine: i.textRange?.endLine ?? i.line ?? null,
    severity: i.severity,
    type: i.type,
    rule: i.rule,
    message: i.message,
  }));
}

// ---------- 메인 ----------
(async () => {
  log(`대기 시작: project=${PROJECT_KEY}, PR=${PR}, sha=${SHA ? SHA.slice(0, 8) : '(지정 안 함)'}`);
  let result;

  try {
    const pr = await waitForAnalysis();
    log(`분석 완료 확인 (analysisDate=${pr.analysisDate}, sha=${(pr.commit?.sha || '').slice(0, 8)})`);

    const qg = await getQualityGate();
    log(`Quality Gate: ${qg.status}`);

    let issues = [];
    if (qg.status !== 'OK') {
      issues = await getNewCodeIssues();
      log(`새 코드 이슈 ${issues.length}건`);
    }

    result = {
      ok: qg.status === 'OK',
      pr: PR,
      sha: pr.commit?.sha || null,
      analysisDate: pr.analysisDate || null,
      qualityGate: qg.status,
      failedConditions: qg.failedConditions,
      issues,
      finishedAt: new Date().toISOString(),
    };
  } catch (e) {
    result = { ok: false, error: e.message, pr: PR, finishedAt: new Date().toISOString() };
  }

  // ----- 결과 파일 저장 -----
  const outFile = path.join(RESULT_DIR, `result-PR${PR}.json`);
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2), 'utf8');

  // ----- 콘솔 출력 -----
  console.log('\n================ 결과 ================');
  if (result.error) {
    console.log('오류:', result.error);
  } else if (result.ok) {
    console.log(`PR ${PR}: PASS (Quality Gate OK)`);
  } else {
    console.log(`PR ${PR}: FAIL (Quality Gate ERROR)`);
    console.log('\n[실패 조건]');
    result.failedConditions.forEach(c =>
      console.log(` - ${c.metric}: 실제 ${c.actual} (기준 ${c.operator} ${c.threshold})`));
    console.log('\n[이슈]');
    result.issues.forEach((i, n) => {
      console.log(` ${n + 1}. ${i.file}:${i.line ?? '-'}  [${i.severity}/${i.type}] ${i.rule}`);
      console.log(`    ${i.message}`);
    });
  }
  console.log(`\n결과 파일: ${outFile}`);

  process.exit(result.error ? 2 : (result.ok ? 0 : 1));
})();

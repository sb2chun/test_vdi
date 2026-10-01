// server.js
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 4000;
const SECRET = process.env.SONAR_WEBHOOK_SECRET || ''; // 비어 있으면 서명 검증 skip
const TARGET_PROJECT_KEY = process.env.TARGET_PROJECT_KEY || ''; // 예: dev_main_ui (비우면 전체 수신)

const LOG_DIR = path.join(__dirname, 'payloads');
fs.mkdirSync(LOG_DIR, { recursive: true });

const app = express();

// 헬스체크 (다른 PC에서 도달성 테스트용)
app.get('/health', (req, res) => res.send('ok'));

// 핵심: HMAC은 "원본 바디 바이트" 기준이라 JSON 파싱 전에 raw로 받아야 함
app.post(
  '/sonar-webhook',
  express.raw({ type: '*/*', limit: '1mb' }),
  (req, res) => {
    const rawBody = req.body; // Buffer

    // 1) 서명 검증
    if (SECRET) {
      const received = req.header('X-Sonar-Webhook-HMAC-SHA256') || '';
      const expected = crypto
        .createHmac('sha256', SECRET)
        .update(rawBody)
        .digest('hex');

      const a = Buffer.from(received, 'utf8');
      const b = Buffer.from(expected, 'utf8');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        console.warn('[WARN] HMAC 검증 실패');
        return res.status(401).send('invalid signature');
      }
    }

    // 2) 파싱
    let body;
    try {
      body = JSON.parse(rawBody.toString('utf8'));
    } catch (e) {
      return res.status(400).send('invalid json');
    }

    // 3) 원본 payload 저장 (실제 구조 확인용)
    const file = path.join(LOG_DIR, `${Date.now()}_${body.project?.key || 'unknown'}.json`);
    fs.writeFileSync(file, JSON.stringify(body, null, 2));

    // 4) 요약 로그
    const summary = {
      project: body.project?.key,
      branchType: body.branch?.type,
      branchName: body.branch?.name,
      taskStatus: body.status,
      qualityGate: body.qualityGate?.status,
      revision: body.revision,
      customProps: body.properties,
    };
    console.log('[RECV]', JSON.stringify(summary));

    // 5) 필터링 (처리 대상이 아니면 200만 주고 종료)
    if (TARGET_PROJECT_KEY && body.project?.key !== TARGET_PROJECT_KEY) {
      console.log('[SKIP] 대상 프로젝트 아님');
      return res.status(200).send('skipped');
    }
    if (body.branch?.type !== 'PULL_REQUEST') {
      console.log('[SKIP] PR 분석 아님');
      return res.status(200).send('skipped');
    }

    // TODO: 여기서 Sonar API로 이슈 조회 -> AI 리뷰 -> Bitbucket 코멘트
    console.log(`[PR] PR=${body.branch.name}, QG=${body.qualityGate?.status}`);

    // Sonar는 응답을 오래 기다리지 않으므로 즉시 200 반환 (무거운 작업은 비동기로)
    res.status(200).send('ok');
  }
);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`listening on http://0.0.0.0:${PORT}`);
  console.log(`HMAC 검증: ${SECRET ? 'ON' : 'OFF'}`);
});
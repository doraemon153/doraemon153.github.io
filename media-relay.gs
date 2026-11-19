/**
 * 도라에몽 AI 서재 · 통합 AI/미디어 중계 (Google Apps Script)
 *
 * Script Properties
 *   GEMINI_API_KEY : 필수
 *   OWNER_EMAIL    : 필수
 *   AI_MODEL       : 선택, 기본 gemini-3.6-flash
 *   AI_FAST_MODEL  : 선택, 기본 gemini-3.1-flash-lite
 *   MEDIA_MODEL    : 선택, 기본 gemini-3.6-flash
 *
 * 배포: 웹 앱 / 실행 사용자 나 / 액세스 권한 모든 사용자
 * 실제 호출 권한은 앱이 보내는 Google OAuth access token의 이메일을
 * OWNER_EMAIL과 비교해 한 번 더 제한합니다.
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
const CHUNK_BYTES = 8 * 1024 * 1024;

function doGet() {
  try {
    const p = PropertiesService.getScriptProperties();
    const configured = !!String(p.getProperty('GEMINI_API_KEY') || '').trim() &&
                       !!String(p.getProperty('OWNER_EMAIL') || '').trim();
    return json_({
      ok: true,
      service: 'doraemon-unified-relay',
      backgroundQueue: true,
      configured: configured,
      aiModel: String(p.getProperty('AI_MODEL') || 'gemini-3.6-flash'),
      fastModel: String(p.getProperty('AI_FAST_MODEL') || 'gemini-3.1-flash-lite'),
      mediaModel: String(p.getProperty('MEDIA_MODEL') || 'gemini-3.6-flash')
    });
  } catch (e) {
    return json_({ ok: false, error: 'server', message: String(e && e.message || e) });
  }
}

function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const token = String(req.token || '');
    if (!token) return json_({ error: 'missing_token', message: 'Google 로그인 토큰이 없습니다.' });

    const me = verifyUser_(token);
    if (!me.ok) return json_({ error: me.error || 'unauthorized', message: me.message || '사용자 확인에 실패했습니다.' });

    // 일반 AI 요청: index.html의 ai()가 보내는 형식
    if (req.body && typeof req.body === 'object' && !req.action) {
      return json_(textRelay_(req.body));
    }

    // 미디어 요청
    switch (String(req.action || '')) {
      case 'ping':       return json_(ping_());
      case 'start':      return json_(startUpload_(req));
      case 'push':       return json_(pushUpload_(req, token));
      case 'wait':       return json_(getGeminiFile_(req.name));
      case 'drop':       return json_(dropGeminiFile_(req.name));
      case 'transcribe': return json_(transcribe_(req));
      case 'describe':       return json_(describeImage_(req, token));
      case 'enqueueSummary': return json_(enqueueSummary_(req));
      case 'enqueueReport':  return json_(enqueueReport_(req));
      case 'jobs':           return json_(jobs_(req));
      case 'cancelJob':      return json_(cancelJob_(req));
      default:               return json_({ error: 'unknown_action', message: '지원하지 않는 중계 요청입니다.' });
    }
  } catch (err) {
    return json_({
      error: 'server',
      message: String(err && (err.message || err.stack) || err).slice(0, 1600)
    });
  }
}

function props_() {
  const p = PropertiesService.getScriptProperties();
  const key = String(p.getProperty('GEMINI_API_KEY') || '').trim();
  const owner = String(p.getProperty('OWNER_EMAIL') || '').trim().toLowerCase();
  if (!key) throw new Error('GEMINI_API_KEY가 Script Properties에 없습니다.');
  if (!owner) throw new Error('OWNER_EMAIL이 Script Properties에 없습니다.');
  return {
    key: key,
    owner: owner,
    aiModel: String(p.getProperty('AI_MODEL') || 'gemini-3.6-flash').trim(),
    fastModel: String(p.getProperty('AI_FAST_MODEL') || 'gemini-3.1-flash-lite').trim(),
    mediaModel: String(p.getProperty('MEDIA_MODEL') || 'gemini-3.6-flash').trim()
  };
}

function verifyUser_(accessToken) {
  try {
    const p = props_();
    const r = UrlFetchApp.fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      method: 'get',
      headers: { Authorization: 'Bearer ' + accessToken },
      muteHttpExceptions: true
    });
    if (r.getResponseCode() !== 200) {
      return { ok: false, error: 'login', message: 'Google 로그인 토큰을 확인하지 못했습니다.' };
    }
    const j = JSON.parse(r.getContentText() || '{}');
    if (String(j.email || '').toLowerCase() !== p.owner) {
      return { ok: false, error: 'login', message: 'OWNER_EMAIL과 로그인 계정이 다릅니다.' };
    }
    return { ok: true, email: j.email };
  } catch (e) {
    return { ok: false, error: 'login', message: String(e && e.message || e) };
  }
}

/* ================= 일반 AI ================= */

function textRelay_(body) {
  const p = props_();
  const tier = String(body.tier || 'default');
  const model = tier === 'fast' ? p.fastModel : p.aiModel;
  const max = Math.max(1, Math.min(32768, Number(body.max_tokens || 4000)));
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return { error: 'bad_request', message: 'AI 메시지가 없습니다.' };

  // JSON 요청: 동기 generateContent의 공식 구조화 출력 설정을 사용한다.
  // responseMimeType만으로도 JSON 출력을 강제하고, 실제 속성 정의가 있는 스키마만 responseJsonSchema로 전달한다.
  if (body.json) {
    const contents = messagesToContents_(messages);
    if (!contents.length) return { error: 'bad_request', message: '보낼 텍스트가 없습니다.' };
    const generationConfig = { maxOutputTokens: max, responseMimeType: 'application/json' };
    if (usableSchema_(body.schema)) generationConfig.responseJsonSchema = body.schema;
    const payload = { contents: contents, generationConfig: generationConfig };
    const system = String(body.system || '').trim();
    if (system) payload.systemInstruction = { parts: [{ text: system }] };
    try {
      const j = generateContent_(model, payload, 'JSON AI');
      const text = candidateText_(j);
      if (!text) return { error: 'ai_upstream', why: 'Gemini JSON 응답이 비어 있습니다.' };
      return { content: [{ type: 'text', text: text }], model: model, structured: true };
    } catch (e) {
      return { error: 'ai_upstream', why: String(e && e.message || e).slice(0, 1400) };
    }
  }

  const contents = messagesToContents_(messages);
  if (!contents.length) return { error: 'bad_request', message: '보낼 텍스트가 없습니다.' };

  const payload = { contents: contents, generationConfig: { maxOutputTokens: max } };
  const system = String(body.system || '').trim();
  if (system) payload.systemInstruction = { parts: [{ text: system }] };

  try {
    const j = generateContent_(model, payload, '일반 AI');
    const text = candidateText_(j);
    if (!text) return { error: 'ai_upstream', why: 'Gemini가 빈 응답을 반환했습니다.' };
    return { content: [{ type: 'text', text: text }], model: model };
  } catch (e) {
    return { error: 'ai_upstream', why: String(e && e.message || e).slice(0, 1200) };
  }
}

function messagesToContents_(messages) {
  const contents = [];
  (messages || []).forEach(function(m) {
    if (!m) return;
    const role0 = String(m.role || 'user').toLowerCase();
    if (role0 === 'system') return;
    const role = (role0 === 'assistant' || role0 === 'model') ? 'model' : 'user';
    let txt = '';
    if (typeof m.content === 'string') txt = m.content;
    else if (Array.isArray(m.content)) txt = m.content.map(function(x) {
      if (typeof x === 'string') return x;
      return x && (x.text || x.content) ? String(x.text || x.content) : '';
    }).filter(Boolean).join('\n');
    else if (m.content != null) txt = String(m.content);
    if (txt) contents.push({ role: role, parts: [{ text: txt }] });
  });
  return contents;
}

function usableSchema_(s) {
  return !!(s && typeof s === 'object' && (s.properties || s.items || s.anyOf || s.oneOf || s.$defs));
}

function interactionPrompt_(messages, system) {
  const a = [];
  const sys = String(system || '').trim();
  if (sys) a.push('[SYSTEM]\n' + sys);
  (messages || []).forEach(function(m) {
    if (!m) return;
    let txt = '';
    if (typeof m.content === 'string') txt = m.content;
    else if (Array.isArray(m.content)) txt = m.content.map(function(x) {
      if (typeof x === 'string') return x;
      return x && (x.text || x.content) ? String(x.text || x.content) : '';
    }).filter(Boolean).join('\n');
    else if (m.content != null) txt = String(m.content);
    if (!txt) return;
    a.push('[' + String(m.role || 'user').toUpperCase() + ']\n' + txt);
  });
  return a.join('\n\n');
}

function interactionGenerate_(model, input, max, schema) {
  const p = props_();
  const payload = {
    model: model,
    input: input,
    store: false,
    stream: false,
    generation_config: { max_output_tokens: max },
    response_format: {
      type: 'text',
      mime_type: 'application/json',
      schema: schema
    }
  };
  const r = UrlFetchApp.fetch(GEMINI_BASE + '/v1beta/interactions', {
    method: 'post',
    headers: { 'x-goog-api-key': p.key },
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  });
  ensure2xx_(r, 'Gemini 구조화 출력');
  const j = JSON.parse(r.getContentText() || '{}');
  if (String(j.status || '').toLowerCase() === 'incomplete') {
    throw new Error('Gemini JSON 응답이 출력 한도에서 잘렸습니다. 더 큰 출력 한도로 다시 시도합니다.');
  }
  return j;
}

function interactionText_(j) {
  if (!j) return '';
  if (typeof j.output_text === 'string' && j.output_text.trim()) return j.output_text.trim();
  const a = [];
  const scan = function(x) {
    if (!x) return;
    if (typeof x === 'string') return;
    if (x.text && typeof x.text === 'string') a.push(x.text);
    if (Array.isArray(x.content)) x.content.forEach(scan);
  };
  if (Array.isArray(j.outputs)) j.outputs.forEach(scan);
  if (Array.isArray(j.output)) j.output.forEach(scan);
  if (Array.isArray(j.steps)) j.steps.forEach(scan);
  return a.join('\n').trim();
}

function ping_() {
  const p = props_();
  const j = generateContent_(p.fastModel, {
    contents: [{ role: 'user', parts: [{ text: 'OK라고만 답해.' }] }],
    generationConfig: { maxOutputTokens: 8 }
  }, '연결 확인');
  return { ok: true, model: p.fastModel, response: candidateText_(j).slice(0, 20) };
}

/* ================= Gemini Files API ================= */

function startUpload_(req) {
  const p = props_();
  const size = Number(req.size || 0);
  const mime = String(req.mime || 'application/octet-stream');
  const name = String(req.name || 'media');
  if (!(size > 0)) throw new Error('파일 크기가 없습니다.');
  if (size > 2 * 1024 * 1024 * 1024) throw new Error('2GB를 넘는 파일은 처리하지 않습니다.');

  const r = UrlFetchApp.fetch(GEMINI_BASE + '/upload/v1beta/files', {
    method: 'post',
    headers: {
      'x-goog-api-key': p.key,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(size),
      'X-Goog-Upload-Header-Content-Type': mime
    },
    contentType: 'application/json',
    payload: JSON.stringify({ file: { display_name: name } }),
    muteHttpExceptions: true
  });
  ensure2xx_(r, 'Gemini 업로드 시작');
  const upload = header_(r.getAllHeaders(), 'x-goog-upload-url');
  if (!upload) throw new Error('Gemini 업로드 URL을 받지 못했습니다.');
  return { upload: String(upload) };
}

function pushUpload_(req, accessToken) {
  const upload = String(req.upload || '');
  const fileId = String(req.fileId || '');
  const size = Number(req.size || 0);
  const offset = Number(req.offset || 0);
  if (!upload || !fileId || !(size > 0)) throw new Error('업로드 정보가 부족합니다.');
  if (offset >= size) return { offset: size };

  const end = Math.min(size - 1, offset + CHUNK_BYTES - 1);
  const dr = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media', {
    method: 'get',
    headers: { Authorization: 'Bearer ' + accessToken, Range: 'bytes=' + offset + '-' + end },
    muteHttpExceptions: true
  });
  const dc = dr.getResponseCode();
  if (dc !== 206 && dc !== 200) throw new Error('Drive 파일 조각을 읽지 못했습니다. HTTP ' + dc);

  const isLast = end + 1 >= size;
  const ur = UrlFetchApp.fetch(upload, {
    method: 'post',
    headers: {
      'X-Goog-Upload-Offset': String(offset),
      'X-Goog-Upload-Command': isLast ? 'upload, finalize' : 'upload'
    },
    payload: dr.getBlob(),
    muteHttpExceptions: true
  });
  ensure2xx_(ur, 'Gemini 파일 전송');

  const out = { offset: end + 1 };
  if (isLast) {
    const j = JSON.parse(ur.getContentText() || '{}');
    if (!j.file) throw new Error('Gemini 파일 정보가 없습니다.');
    out.file = j.file;
  }
  return out;
}

function getGeminiFile_(name) {
  const p = props_();
  name = normalizeFileName_(name);
  const r = UrlFetchApp.fetch(GEMINI_BASE + '/v1beta/' + name, {
    method: 'get',
    headers: { 'x-goog-api-key': p.key },
    muteHttpExceptions: true
  });
  ensure2xx_(r, 'Gemini 파일 상태 확인');
  const j = JSON.parse(r.getContentText() || '{}');
  return { name: j.name, uri: j.uri, mimeType: j.mimeType, state: j.state };
}

function dropGeminiFile_(name) {
  if (!name) return { ok: true };
  const p = props_();
  name = normalizeFileName_(name);
  const r = UrlFetchApp.fetch(GEMINI_BASE + '/v1beta/' + name, {
    method: 'delete',
    headers: { 'x-goog-api-key': p.key },
    muteHttpExceptions: true
  });
  const c = r.getResponseCode();
  if (c !== 200 && c !== 204 && c !== 404) ensure2xx_(r, 'Gemini 파일 삭제');
  return { ok: true };
}

/* ================= 영상/음성/사진 ================= */

function transcribe_(req) {
  const p = props_();
  const uri = String(req.uri || '');
  const mime = String(req.mime || (req.kind === 'video' ? 'video/mp4' : 'audio/mpeg'));
  const kind = String(req.kind || 'audio');
  if (!uri) throw new Error('Gemini 파일 URI가 없습니다.');

  const prompt = [
    '이 미디어의 실제 발화를 가능한 한 정확히 전사한다.',
    '말하지 않은 내용을 추측해서 추가하지 않는다.',
    '각 줄은 반드시 [MM:SS] 발화 내용 형식으로 쓴다.',
    '한국어 발화는 한국어 그대로 적고 다른 언어는 원문을 최대한 보존한다.',
    '긴 침묵이나 음악만 있는 구간은 생략한다.',
    '화자 이름을 확실히 알 수 없으면 이름을 지어내지 않는다.',
    '설명이나 머리말 없이 전사 내용만 출력한다.'
  ].join('\n');

  const mediaPart = { fileData: { mimeType: mime, fileUri: uri } };
  if (kind === 'video' && (req.start != null || req.end != null)) {
    const vm = {};
    if (req.start != null) vm.startOffset = Math.max(0, Number(req.start)) + 's';
    if (req.end != null) vm.endOffset = Math.max(0, Number(req.end)) + 's';
    mediaPart.videoMetadata = vm;
  }

  const j = generateContent_(p.mediaModel, {
    contents: [{ role: 'user', parts: [mediaPart, { text: prompt }] }],
    generationConfig: { maxOutputTokens: 12000 }
  }, '미디어 받아쓰기');
  return { text: candidateText_(j), model: p.mediaModel };
}

function describeImage_(req, accessToken) {
  const p = props_();
  const fileId = String(req.fileId || '');
  const mime = String(req.mime || 'image/jpeg');
  if (!fileId) throw new Error('사진 파일 ID가 없습니다.');

  const dr = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId) + '?alt=media', {
    method: 'get',
    headers: { Authorization: 'Bearer ' + accessToken },
    muteHttpExceptions: true
  });
  if (dr.getResponseCode() !== 200) throw new Error('Drive 사진을 읽지 못했습니다. HTTP ' + dr.getResponseCode());
  const bytes = dr.getBlob().getBytes();
  if (bytes.length > 15 * 1024 * 1024) throw new Error('사진이 15MB를 넘어 설명하지 않습니다.');

  const prompt = [
    '이 이미지를 서재 검색용으로 정확하게 정리한다.',
    '보이는 글자가 있으면 먼저 읽어 적고, 이어서 이미지의 핵심 내용을 간결하게 설명한다.',
    '사람의 신원이나 민감한 특성을 추측하지 않는다.',
    '보이지 않는 사실을 만들어내지 않는다.',
    '검색에 도움이 되는 사물, 장소 유형, 문서 종류, 화면 요소를 포함한다.'
  ].join('\n');

  const j = generateContent_(p.mediaModel, {
    contents: [{ role: 'user', parts: [
      { inlineData: { mimeType: mime, data: Utilities.base64Encode(bytes) } },
      { text: prompt }
    ] }],
    generationConfig: { maxOutputTokens: 3000 }
  }, '사진 설명');
  return { text: candidateText_(j), model: p.mediaModel };
}


/* ================= 백그라운드 AI 작업 큐 ================= */

function jobFolder_(rootId) {
  if (!rootId) throw new Error('서재 루트 폴더 ID가 없습니다.');
  const root = DriveApp.getFolderById(String(rootId));
  const it = root.getFoldersByName('AI 작업');
  return it.hasNext() ? it.next() : root.createFolder('AI 작업');
}

function readJsonFile_(file) {
  try { return JSON.parse(file.getBlob().getDataAsString('UTF-8') || '{}'); }
  catch (e) { return null; }
}

function saveJob_(job, folder) {
  job.updated = new Date().toISOString();
  let f = null;
  if (job.fileId) { try { f = DriveApp.getFileById(job.fileId); } catch (e) {} }
  if (!f) {
    const it = folder.getFilesByName(job.id + '.json');
    if (it.hasNext()) f = it.next();
  }
  if (!f) {
    f = folder.createFile(job.id + '.json', JSON.stringify(job), MimeType.PLAIN_TEXT);
    job.fileId = f.getId();
  }
  f.setContent(JSON.stringify(job));
  return job;
}

function newJobId_(type) {
  return type.charAt(0) + Utilities.getUuid().replace(/-/g, '').slice(0, 18);
}

function ensureWorkerTrigger_() {
  const exists = ScriptApp.getProjectTriggers().some(function(t) { return t.getHandlerFunction() === 'backgroundWorker'; });
  if (!exists) ScriptApp.newTrigger('backgroundWorker').timeBased().everyMinutes(1).create();
  return true;
}

function installBackgroundWorker() {
  ensureWorkerTrigger_();
  return '백그라운드 AI 작업 트리거 준비 완료';
}

function enqueueSummary_(req) {
  const x = req.job || {};
  if (!x.sourceId || !Array.isArray(x.parts) || !x.parts.length) throw new Error('요약 작업 정보가 부족합니다.');
  const folder = jobFolder_(req.rootId);
  const job = {
    id: newJobId_('summary'), type: 'summary', status: 'queued', pc: 1,
    msg: '요약 작업 대기 중', created: new Date().toISOString(), updated: new Date().toISOString(),
    rootId: String(req.rootId || ''), sumFolderId: String(req.sumFolderId || ''),
    title: String(x.title || ''), sourceId: String(x.sourceId || ''),
    input: x, state: { part: 0, digests: [] }, attempts: 0
  };
  saveJob_(job, folder); ensureWorkerTrigger_();
  return { ok: true, job: publicJob_(job) };
}

function enqueueReport_(req) {
  const x = req.job || {};
  if (!x.title || !Array.isArray(x.sections) || !x.sections.length || !Array.isArray(x.sources)) throw new Error('보고서 작업 정보가 부족합니다.');
  const folder = jobFolder_(req.rootId);
  const job = {
    id: newJobId_('report'), type: 'report', status: 'queued', pc: 1,
    msg: '보고서 작업 대기 중', created: new Date().toISOString(), updated: new Date().toISOString(),
    rootId: String(req.rootId || ''), outFolderId: String(req.outFolderId || ''),
    archiveFolderId: String(req.archiveFolderId || ''), idxFolderId: String(req.idxFolderId || ''),
    title: String(x.title || ''), guideName: String(x.guideName || 'AI 보고서'),
    input: x, state: { section: 0, sections: [] }, attempts: 0
  };
  saveJob_(job, folder); ensureWorkerTrigger_();
  return { ok: true, job: publicJob_(job) };
}

function publicJob_(j) {
  return { id:j.id,type:j.type,status:j.status,pc:Number(j.pc||0),msg:j.msg||'',title:j.title||'',guideName:j.guideName||'',sourceId:j.sourceId||'',created:j.created||'',updated:j.updated||'',resultFileId:j.resultFileId||'',resultDocId:j.resultDocId||'',error:j.error||'' };
}

function jobs_(req) {
  const folder = jobFolder_(req.rootId), files = folder.getFiles(), a = [];
  while (files.hasNext()) {
    const f = files.next(); if (!/\.json$/i.test(f.getName())) continue;
    const j = readJsonFile_(f); if (j && j.id) { j.fileId = f.getId(); a.push(publicJob_(j)); }
  }
  a.sort(function(x,y){ return String(y.created||'').localeCompare(String(x.created||'')); });
  return { ok:true, jobs:a.slice(0,40) };
}

function cancelJob_(req) {
  const folder = jobFolder_(req.rootId), it = folder.getFilesByName(String(req.id || '') + '.json');
  if (!it.hasNext()) return { ok:true };
  const f=it.next(), j=readJsonFile_(f)||{}; j.fileId=f.getId();
  if (j.status !== 'done') { j.status='cancelled'; j.msg='사용자가 취소했습니다'; j.pc=j.pc||0; saveJob_(j,folder); }
  return { ok:true };
}

function backgroundWorker() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1500)) return;
  const started = Date.now();
  try {
    const roots = findJobRoots_();
    for (let round=0; round<8 && Date.now()-started<245000; round++) {
      let progressed = false;
      for (let r=0; r<roots.length && Date.now()-started<245000; r++) {
        const folder = roots[r], jobs = readRunnableJobs_(folder);
        for (let i=0; i<jobs.length && Date.now()-started<245000; i++) {
          const j=jobs[i];
          try {
            if (j.status==='queued') j.status='working';
            if (j.type==='summary') processSummaryStep_(j);
            else if (j.type==='report') processReportStep_(j);
            else { j.status='failed'; j.error='알 수 없는 작업 종류'; }
            j.attempts=0;
          } catch(e) {
            j.attempts=(j.attempts||0)+1; j.error=String(e&&e.message||e).slice(0,1400);
            if (j.attempts>=3) { j.status='failed'; j.msg='작업 오류'; }
            else { j.status='queued'; j.msg='일시 오류 · 다시 시도합니다 ('+j.attempts+'/3)'; }
          }
          saveJob_(j,folder); progressed=true;
        }
      }
      if (!progressed) break;
    }
  } finally {
    try { if (!hasPendingJobs_()) removeWorkerTriggers_(); } catch(e) {}
    lock.releaseLock();
  }
}

function hasPendingJobs_(){const roots=findJobRoots_();for(let r=0;r<roots.length;r++){const files=roots[r].getFiles();while(files.hasNext()){const f=files.next();if(!/\.json$/i.test(f.getName()))continue;const j=readJsonFile_(f);if(j&&['queued','working'].indexOf(j.status)>=0)return true;}}return false;}
function removeWorkerTriggers_(){ScriptApp.getProjectTriggers().forEach(function(t){if(t.getHandlerFunction()==='backgroundWorker')ScriptApp.deleteTrigger(t);});}

function findJobRoots_() {
  const out=[];
  const it=DriveApp.getFoldersByName('AI 작업');
  while(it.hasNext()) out.push(it.next());
  return out;
}

function readRunnableJobs_(folder) {
  const files=folder.getFiles(), a=[], now=Date.now();
  while(files.hasNext()){
    const f=files.next(); if(!/\.json$/i.test(f.getName()))continue;
    const j=readJsonFile_(f); if(!j||!j.id)continue; j.fileId=f.getId();
    if(j.status==='queued'||j.status==='working'){
      if(j.status==='working' && now-Date.parse(j.updated||0)>10*60*1000)j.status='queued';
      a.push(j);
    }
  }
  a.sort(function(x,y){return String(x.updated||x.created||'').localeCompare(String(y.updated||y.created||''));});
  return a.slice(0,12);
}

function bgAI_(prompt, fast, max) {
  const p=props_(), models=[]; if(fast)models.push(p.fastModel);models.push(p.aiModel);models.push(p.fastModel);
  const uniq=models.filter(function(x,i,a){return x&&a.indexOf(x)===i;}); let last=null;
  for(let i=0;i<uniq.length;i++){
    try{
      const j=generateContent_(uniq[i],{contents:[{role:'user',parts:[{text:String(prompt)}]}],generationConfig:{maxOutputTokens:Math.min(32768,Math.max(128,Number(max||4000))) }},'백그라운드 AI');
      const t=candidateText_(j); if(t)return t; last=new Error('AI가 빈 응답을 보냈습니다.');
    }catch(e){last=e; Utilities.sleep(600*(i+1));}
  }
  throw last||new Error('AI 응답 실패');
}

function processSummaryStep_(job) {
  const x=job.input||{}, parts=x.parts||[], st=job.state||{part:0,digests:[]}; job.state=st;
  if(st.part<parts.length){
    const p=parts[st.part]; job.msg='전체 '+parts.length+'구간 중 '+(st.part+1)+'구간 정리 · '+(p.label||'');
    st.digests.push(bgAI_('한 권의 책을 전체 요약하기 위한 중간 정리다. 아래 발췌는 책의 '+(st.part+1)+'/'+parts.length+' 구간이다. 오직 제공된 원문만 사용하고 외부 지식이나 추측을 넣지 않는다. JSON을 쓰지 말고 읽기 쉬운 일반 텍스트로 작성한다.\n- 구간의 논리 흐름 5~8문장\n- 핵심 주장 3~6개(가능하면 페이지 포함)\n- 중요한 예시·개념\n- 확인되는 장/절 제목\n\n책: '+(x.author?x.author+', ': '')+'『'+x.title+'』\n\n[원문 발췌]\n'+String(p.text||'').slice(0,38000),true,5000));
    st.part++; job.pc=Math.round(5+(st.part/Math.max(1,parts.length))*73); return;
  }
  if(!st.final){
    job.msg='구간 요약을 책 전체 요약으로 통합하는 중'; job.pc=84;
    const raw=bgAI_('다음은 『'+x.title+'』의 전체 색인을 여러 구간으로 나눈 중간 정리다. 이것들만 근거로 책 전체 요약을 만든다. JSON은 절대 사용하지 않는다. 아래 제목 표식을 정확히 사용한다.\n\n원칙:\n- 책에 없는 내용, 외부 평가, 일반지식을 추가하지 않는다.\n- 저자의 주장과 논리 흐름을 객관적으로 설명한다.\n- OVERVIEW는 책을 읽기 전 전체 구조를 이해할 만큼 충실하게 쓴다.\n- 중요한 주장에는 가능한 경우 페이지 범위를 남긴다.\n\n[목차 후보]\n'+((x.toc||[]).join('\n')||'(없음)')+'\n\n[구간 정리]\n'+st.digests.map(function(d,i){return '--- 구간 '+(i+1)+' ---\n'+d;}).join('\n\n')+'\n\n반드시 아래 형식으로만 출력한다. 목록 한 줄은 || 로 칸을 구분한다.\n## ONE_LINE\n책 전체를 한 문장으로\n## OVERVIEW\n책 전체 핵심을 여러 문단으로\n## TOC\n- 확인되는 목차/주요 장 제목\n## KEY_IDEAS\n- 핵심 아이디어 제목 || p.범위 || 설명과 논리/예시\n## CHAPTERS\n- 부분/장 제목 || p.범위 || 내용 요약\n## CONCEPTS\n- 핵심 개념 || 책에서의 의미\n## TAKEAWAYS\n- 기억할 핵심\n## TOPICS\n- 짧은 주제 태그',false,15000);
    st.final=parseSummaryTextServer_(raw,x); return;
  }
  job.msg='Drive에 책 요약을 저장하는 중'; job.pc=96;
  const f=st.final, d={version:3,sourceId:x.sourceId,sourceModified:x.sourceModified,at:new Date().toISOString(),title:x.title||'',author:x.author||'',year:x.year||'',cat:x.cat||'',topics:(f.topics&&f.topics.length?f.topics:x.topics||[]).slice(0,6),kind:x.kind||'',path:x.path||'',name:x.name||x.title||'',cover:x.cover||'',oneLine:f.oneLine||'',overview:f.overview||'',toc:(f.toc||x.toc||[]).slice(0,30),keyIdeas:(f.keyIdeas||[]).slice(0,10),chapters:(f.chapters||[]).slice(0,12),concepts:(f.concepts||[]).slice(0,12),takeaways:(f.takeaways||[]).slice(0,10)};
  job.resultFileId=saveSummaryDrive_(job.sumFolderId,d); job.status='done'; job.pc=100; job.msg='책 요약 저장 완료';
}

function secServer_(t,name,next){const s=String(t||''),a=s.indexOf('## '+name);if(a<0)return '';const from=a+('## '+name).length;let to=s.length;(next||[]).forEach(function(n){const i=s.indexOf('## '+n,from);if(i>=0&&i<to)to=i;});return s.slice(from,to).trim();}
function cleanServerLines_(s){return String(s||'').split('\n').map(function(x){return x.trim().replace(/^[-•*]\s*/,'');}).filter(Boolean);}
function pipeServer_(s,names){return cleanServerLines_(s).map(function(line){const p=line.split('||').map(function(x){return x.trim();}),o={};names.forEach(function(k,i){o[k]=p[i]||'';});return o;}).filter(function(o){return Object.keys(o).some(function(k){return o[k];});});}
function parseSummaryTextServer_(raw,x){const names=['ONE_LINE','OVERVIEW','TOC','KEY_IDEAS','CHAPTERS','CONCEPTS','TAKEAWAYS','TOPICS'];const one=secServer_(raw,'ONE_LINE',names.slice(1)),overview=secServer_(raw,'OVERVIEW',names.slice(2)),toc=cleanServerLines_(secServer_(raw,'TOC',names.slice(3))),topics=cleanServerLines_(secServer_(raw,'TOPICS',[])).join(',').split(/[,|·]/).map(function(z){return z.trim().replace(/^#/,'');}).filter(Boolean);const rc=String(raw||'').replace(/```[a-z]*|```/gi,'').trim();return {oneLine:one.split('\n').filter(Boolean)[0]||rc.split('\n')[0]||x.title,overview:overview||rc,toc:toc.length?toc:(x.toc||[]),keyIdeas:pipeServer_(secServer_(raw,'KEY_IDEAS',names.slice(4)),['title','pages','body']),chapters:pipeServer_(secServer_(raw,'CHAPTERS',names.slice(5)),['title','pages','summary']),concepts:pipeServer_(secServer_(raw,'CONCEPTS',names.slice(6)),['term','meaning']),takeaways:cleanServerLines_(secServer_(raw,'TAKEAWAYS',names.slice(7))),topics:topics.slice(0,6)};}

function saveSummaryDrive_(folderId,d){
  const folder=DriveApp.getFolderById(folderId), name=d.sourceId+'.json'; let f=null,it=folder.getFilesByName(name);if(it.hasNext())f=it.next();else f=folder.createFile(name,JSON.stringify(d),MimeType.PLAIN_TEXT);f.setContent(JSON.stringify(d));
  d.file=f.getId(); const idxName='index.json';it=folder.getFilesByName(idxName);let idxFile=it.hasNext()?it.next():null,arr=idxFile?(readJsonFile_(idxFile)||[]):[];if(!Array.isArray(arr))arr=[];const m={sourceId:d.sourceId,file:f.getId(),title:d.title,author:d.author||'',cat:d.cat||'',topics:d.topics||[],at:d.at,sourceModified:d.sourceModified,oneLine:d.oneLine||'',keyIdeas:(d.keyIdeas||[]).length,cover:d.cover||''};const k=arr.findIndex(function(z){return z.sourceId===d.sourceId;});if(k>=0)arr[k]=m;else arr.unshift(m);if(!idxFile)idxFile=folder.createFile(idxName,JSON.stringify(arr),MimeType.PLAIN_TEXT);else idxFile.setContent(JSON.stringify(arr));return f.getId();
}

function processReportStep_(job){
  const x=job.input||{}, st=job.state||{section:0,sections:[]};job.state=st;const defs=x.sections||[];
  if(st.section<defs.length){const part=defs.slice(st.section,st.section+2),nums=[];part.forEach(function(s){(s.src||[]).forEach(function(n){if(nums.indexOf(n)<0)nums.push(n);});});const src=(x.sources||[]).filter(function(s){return nums.indexOf(s.s)>=0;});job.msg='작성 중 · '+part.map(function(s){return s.h;}).join(', ');job.pc=Math.round(10+(st.section/Math.max(1,defs.length))*70);
    const prompt='너는 신학 연구 조교다. 사용자의 구글 드라이브 서재 색인에서 미리 선택된 [근거 자료]를 가장 우선하는 주해·연구 노트를 쓴다.\n\n[연구 철학]\n'+(x.philo||'')+'\n\n규칙:\n- 내 서재 근거로 확인되는 사실 문장 끝에는 [S번호]를 단다.\n- 근거가 부족하면 (내 서재에 자료 부족)이라고 쓴다.\n- 사용자의 생각은 내 생각: 으로 구분하고 근거와 대화시킨다.\n- 해석이 갈리면 주요 입장을 공정하게 나란히 보여준다.\n- 직접 인용은 근거에 실제 있는 문구만 짧게 쓴다.\n- 원어는 근거에 나온 경우만 쓴다.\n- 설교 자료와 예화 목차에서는 먼저 내 서재에서 실제 사례·예화·인용을 찾는다. 자료에 없는 예화를 만들어내지 않는다.\n- 마크다운으로 작성하고 각 목차는 ## 목차 이름으로 시작한다.\n\n[지침] '+(x.guideName||'AI 노트')+'\n말투: '+((x.guide||{}).tone||'')+'\n꼭 넣을 것: '+(((x.guide||{}).must||[]).join(' / ')||'없음')+'\n피할 것: '+(((x.guide||{}).avoid||[]).join(' / ')||'없음')+'\n\n[입력]\n'+(x.inputText||'')+'\n\n[이번 목차]\n'+part.map(function(s){return '## '+s.h+' — '+(s.ask||'');}).join('\n')+'\n\n[내 서재 근거]\n'+src.map(function(s){return '[S'+s.s+'] '+(s.author?s.author+', ':'')+'『'+s.title+'』 '+locServer_(s)+'\n'+String(s.text||'').slice(0,5600);}).join('\n\n');
    const md=bgAI_(prompt,false,12000), split=splitReportSectionsServer_(md,part);split.forEach(function(text,k){st.sections.push({h:part[k].h,md:text,src:part[k].src||[]});});st.section+=part.length;return;
  }
  if(!st.webDone){job.msg='신뢰 가능한 외부 자료를 확인하는 중';job.pc=86;st.webDone=true;st.web={text:'',sources:[]};if(x.webResearch!==false){try{st.web=groundedResearch_(x,st.sections)||st.web;}catch(e){st.webError=String(e&&e.message||e).slice(0,500);}}return;}
  job.msg='Google Docs 저장 및 자동 색인 중';job.pc=95;
  const sections=(st.sections||[]).slice();if(st.web&&st.web.text){sections.push({h:'외부 검증 자료',md:st.web.text,src:[]});}
  const d={id:'d'+Date.now(),at:new Date().toISOString(),guide:{id:(x.guide||{}).id||'',name:x.guideName||'AI 노트'},title:x.title,inputs:x.inputs||{},sources:x.sources||[],externalSources:(st.web&&st.web.sources)||[],sections:sections,archive:x.archive||{},verify:{quotes:0,bad:0,nocite:0}};
  const saved=saveReportDrive_(job.outFolderId,job.archiveFolderId,job.idxFolderId,d,x);job.resultFileId=saved.jsonId;job.resultDocId=saved.docId;job.resultPdfId='';job.resultDocxId='';job.status='done';job.pc=100;job.msg=(x.guide&&x.guide.id==='exegesis'?'주해 노트':'AI 노트')+' Google Docs 저장 · 자동 색인 완료';
}

function locServer_(x){if(x.u==='sec'){const s=Math.max(0,(x.p0||1)-1),m=Math.floor(s/60),z=s%60;return m+':'+('0'+z).slice(-2);}if(x.u==='slide')return '슬라이드 '+(x.p0||'');return x.p0?'p.'+x.p0+(x.p1&&x.p1!==x.p0?'-'+x.p1:''):'';}
function splitReportSectionsServer_(md,part){const out=part.map(function(){return '';});const blocks=String(md||'').split(/^##\s+/m).map(function(x){return x.trim();}).filter(Boolean);if(blocks.length<=1&&part.length===1)return [String(md||'').replace(/^##\s+.*\n?/,'').trim()];blocks.forEach(function(b){const h=b.split('\n')[0].replace(/\s*—.*$/,'').trim();let k=part.findIndex(function(o){return h.indexOf(o.h)>=0||o.h.indexOf(h)>=0;});if(k<0)k=out.findIndex(function(x){return !x;});if(k<0)k=part.length-1;out[k]+=(out[k]?'\n\n':'')+b.split('\n').slice(1).join('\n').trim();});return out;}

function trustedDomains_(){const p=PropertiesService.getScriptProperties(),extra=String(p.getProperty('TRUSTED_WEB_DOMAINS')||'').split(',').map(function(x){return x.trim().toLowerCase();}).filter(Boolean);return ['ai.google.dev','developers.google.com','kci.go.kr','riss.kr','kiss.kstudy.com','dbpia.co.kr','jstor.org','cambridge.org','oxfordacademic.com','brill.com','eerdmans.com','crossway.org','thegospelcoalition.org','themelios.thegospelcoalition.org','ligonier.org','desiringgod.org','9marks.org','sbts.edu','wts.edu','gordonconwell.edu','covenantseminary.edu','opc.org','pcanet.org','bibleodyssey.org'].concat(extra);}
function trustedUrl_(u){const m=String(u||'').match(/^https?:\/\/([^\/?#]+)/i);if(!m)return false;const h=String(m[1]||'').toLowerCase().replace(/:\d+$/,'');return trustedDomains_().some(function(d){return h===d||h.endsWith('.'+d);});}
function groundedResearch_(x,sections){const p=props_(),pass=(x.archive&&x.archive.passage)||((x.inputs||{}).ref)||'',topic=(x.inputs||{}).topic||'',guide=(x.guide||{}).id||'';if(!pass&&!topic)return {text:'',sources:[]};
  const ask='다음 주해/신학 연구 노트를 보조할 외부 자료를 Google Search로 확인한다. 내부 서재가 주 근거이며 외부 자료는 보조 검증용이다.\n주제/본문: '+(pass||topic)+'\n자료 성격: '+(guide==='exegesis'?'성경 주해와 설교 준비':'디지털 신학 및 신학 연구')+'\n반드시 학술기관, 대학/신학교, 동료평가 논문, 공식 교단/출판사, 검증된 복음주의·개혁주의 연구기관처럼 출처가 명확한 자료만 사용한다. 익명 블로그, 포럼, 위키 복제, AI 생성 글, 출처가 불명확한 설교 예화 사이트는 제외한다.\n찾을 것: 1) 본문/주제의 검증 가능한 배경·학술 논점 2) 내 서재에 부족한 보완 자료 3) 설교에 쓸 수 있는 실제 역사적 사례나 검증 가능한 예화가 있으면 출처와 함께 제안. 예화를 만들어내지 않는다.\n결과는 한국어로 짧은 불릿 4~8개로 쓰고, 각 불릿은 무엇을 확인할 수 있는지 설명한다.';
  const r=UrlFetchApp.fetch(GEMINI_BASE+'/v1beta/interactions',{method:'post',headers:{'x-goog-api-key':p.key},contentType:'application/json',payload:JSON.stringify({model:p.aiModel,input:ask,tools:[{type:'google_search'}],store:false}),muteHttpExceptions:true});ensure2xx_(r,'외부 자료 검색');const j=JSON.parse(r.getContentText()||'{}'),texts=[],src=[],seen={};(j.steps||[]).forEach(function(st){if(st.type!=='model_output')return;(st.content||[]).forEach(function(c){if(c&&c.type==='text'&&c.text)texts.push(c.text);(c.annotations||[]).forEach(function(a){if(a&&a.type==='url_citation'&&a.url&&trustedUrl_(a.url)&&!seen[a.url]){seen[a.url]=1;src.push({title:a.title||a.url,url:a.url});}});});});if(!src.length)return {text:'',sources:[]};const refs=src.slice(0,10).map(function(a,i){return '['+(i+1)+'] '+a.title+' — '+a.url;}).join('\n');return {text:(texts.join('\n').trim()+'\n\n### 확인된 외부 출처\n'+refs).trim(),sources:src.slice(0,10)};}

function safeFileName_(s){return String(s||'AI 노트').replace(/[\\/:*?"<>|]+/g,' ').replace(/\s+/g,' ').trim().slice(0,160);}
function reportText_(d){let t=(d.title||'')+'\n'+String(d.at||'').slice(0,10)+'\n\n';(d.sections||[]).forEach(function(s){t+='## '+s.h+'\n'+String(s.md||'')+'\n\n';});if((d.externalSources||[]).length){t+='## 외부 출처\n';d.externalSources.forEach(function(x){t+='- '+(x.title||'출처')+' — '+x.url+'\n';});}return t.trim();}
function collectionFolder_(baseId,name){const base=DriveApp.getFolderById(baseId),safe=safeFileName_(name||'AI 노트'),it=base.getFoldersByName(safe);return it.hasNext()?it.next():base.createFolder(safe);}
function exportGoogleDoc_(docId,mime,name){const u='https://www.googleapis.com/drive/v3/files/'+encodeURIComponent(docId)+'/export?mimeType='+encodeURIComponent(mime);const r=UrlFetchApp.fetch(u,{headers:{Authorization:'Bearer '+ScriptApp.getOAuthToken()},muteHttpExceptions:true});ensure2xx_(r,'문서 내보내기');return r.getBlob().setName(name);}
function createReportFiles_(archiveFolderId,d,x){const collection=(x.archive&&x.archive.collection)||(x.guideName||'AI 노트'),folder=collectionFolder_(archiveFolderId,collection),base=String(d.at||'').slice(0,10)+' '+safeFileName_(d.title),doc=DocumentApp.create(base),body=doc.getBody();body.clear();body.appendParagraph(d.title||'AI 노트').setHeading(DocumentApp.ParagraphHeading.TITLE);const meta=[String(d.at||'').slice(0,10),(x.archive&&x.archive.passage)||'',collection].filter(Boolean).join(' · ');if(meta)body.appendParagraph(meta);(d.sections||[]).forEach(function(s){body.appendParagraph(s.h||'').setHeading(DocumentApp.ParagraphHeading.HEADING1);String(s.md||'').split(/\n{2,}/).forEach(function(p){if(p.trim())body.appendParagraph(p.replace(/^#+\s*/,'').trim());});});if((d.externalSources||[]).length){body.appendParagraph('외부 출처').setHeading(DocumentApp.ParagraphHeading.HEADING1);d.externalSources.forEach(function(z){body.appendListItem((z.title||'출처')+' — '+z.url);});}doc.saveAndClose();const docFile=DriveApp.getFileById(doc.getId());docFile.moveTo(folder);return {docId:doc.getId(),folderId:folder.getId(),base:base};}
function chunkGenerated_(text,refs){const out=[],s=String(text||''),size=1800,ov=180;let i=0,n=0;while(i<s.length){let e=Math.min(s.length,i+size);if(e<s.length){const cut=s.lastIndexOf('\n',e);if(cut>i+900)e=cut;}const tx=s.slice(i,e).trim();if(tx)out.push({n:n++,p0:0,p1:0,text:tx,refs:(refs||[]).slice()});if(e>=s.length)break;i=Math.max(i+1,e-ov);}return out;}
function saveGeneratedIndex_(idxFolderId,files,d,x){if(!idxFolderId||!files.docId)return;const idx=DriveApp.getFolderById(idxFolderId),text=reportText_(d),chunks=chunkGenerated_(text,(x.archive&&x.archive.refTags)||[]),mod=new Date().toISOString(),ixName=files.docId+'.json';let it=idx.getFilesByName(ixName),ixf=it.hasNext()?it.next():idx.createFile(ixName,'{}',MimeType.PLAIN_TEXT);ixf.setContent(JSON.stringify({fileId:files.docId,name:files.base,unit:'none',card:{title:d.title,author:'AI포켓',first:text.slice(0,1500)},chunks:chunks,indexedAt:mod,sourceModified:mod}));const libName='library.json';it=idx.getFilesByName(libName);let lf=it.hasNext()?it.next():null,arr=lf?(readJsonFile_(lf)||[]):[];if(!Array.isArray(arr))arr=[];const ar=x.archive||{},entry={id:files.docId,name:files.base,mime:'application/vnd.google-apps.document',size:0,modified:mod,root:'generated',parent:files.folderId,path:'내 드라이브 › Dora에몽 서재 › 연구 노트 › '+(ar.collection||x.guideName||'AI 노트'),title:d.title,author:'AI포켓',kw:(ar.topics||[]).slice(),status:'ok',ix:ixf.getId(),unit:'none',bk:(ar.bibleKeys||[]).slice(),refTags:(ar.refTags||[]).slice(),chunks:chunks.length,pages:0,summary:String((d.sections&&d.sections[0]&&d.sections[0].md)||'').replace(/[#*\[\]]/g,'').slice(0,220),cat:ar.cat||'AI 노트',topics:(ar.topics||[]).slice(0,8),docType:ar.collection||x.guideName||'AI 노트',collection:ar.collection||x.guideName||'AI 노트',passage:ar.passage||'',generated:true,resultJsonId:d.id||''};const k=arr.findIndex(function(z){return z.id===entry.id;});if(k>=0)arr[k]=entry;else arr.unshift(entry);if(!lf)lf=idx.createFile(libName,JSON.stringify(arr),MimeType.PLAIN_TEXT);else lf.setContent(JSON.stringify(arr));}
function saveReportDrive_(folderId,archiveFolderId,idxFolderId,d,x){const folder=DriveApp.getFolderById(folderId),safe=safeFileName_(d.title||'AI 노트'),name=String(d.at||'').slice(0,10)+' '+safe+'.json';const f=folder.createFile(name,JSON.stringify(d),'application/json');const files=createReportFiles_(archiveFolderId||folderId,d,x||{});saveGeneratedIndex_(idxFolderId,files,d,x||{});return {jsonId:f.getId(),docId:files.docId};}

/* ================= Gemini 공통 ================= */

function generateContent_(model, payload, label) {
  const p = props_();
  const r = UrlFetchApp.fetch(
    GEMINI_BASE + '/v1beta/models/' + encodeURIComponent(model) + ':generateContent',
    {
      method: 'post',
      headers: { 'x-goog-api-key': p.key },
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    }
  );
  ensure2xx_(r, label || 'Gemini');
  return JSON.parse(r.getContentText() || '{}');
}

function candidateText_(j) {
  const a = [];
  const cs = j && Array.isArray(j.candidates) ? j.candidates : [];
  cs.forEach(function(c) {
    const ps = c && c.content && Array.isArray(c.content.parts) ? c.content.parts : [];
    ps.forEach(function(x) { if (x && x.text) a.push(String(x.text)); });
  });
  return a.join('\n').trim();
}

function normalizeFileName_(name) {
  name = String(name || '').replace(/^\/+/, '');
  if (!/^files\//.test(name)) throw new Error('잘못된 Gemini 파일 이름입니다.');
  return name;
}

function ensure2xx_(r, label) {
  const c = r.getResponseCode();
  if (c >= 200 && c < 300) return;
  let t = String(r.getContentText() || '').slice(0, 1400);
  try {
    const j = JSON.parse(t);
    if (j && j.error && j.error.message) t = j.error.message;
  } catch (e) {}
  throw new Error((label || '요청') + ' 실패 · HTTP ' + c + (t ? ' · ' + t : ''));
}

function header_(headers, wanted) {
  wanted = String(wanted).toLowerCase();
  const keys = Object.keys(headers || {});
  for (let i = 0; i < keys.length; i++) {
    if (String(keys[i]).toLowerCase() === wanted) {
      const v = headers[keys[i]];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return '';
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

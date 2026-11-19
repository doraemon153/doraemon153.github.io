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
      case 'describe':   return json_(describeImage_(req, token));
      default:           return json_({ error: 'unknown_action', message: '지원하지 않는 중계 요청입니다.' });
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

/**
 * 미디어 중계 (선택) — 영상 · 음성 받아쓰기, 글자가 없는 사진 읽기
 * 구글 Gemini API를 씁니다. 키는 이 스크립트 속성에만 둡니다(웹 화면 · 깃허브에는 없음).
 *
 * 스크립트 속성 (프로젝트 설정 → 스크립트 속성)
 *   GEMINI_API_KEY  필수  https://aistudio.google.com 에서 만든 키
 *   OWNER_EMAIL     필수  config.js의 ownerEmail과 같은 주소
 *   GEMINI_MODEL    선택  기본 gemini-2.5-flash
 *
 * 배포: 배포 → 새 배포 → 유형 "웹 앱" → 실행: 나 · 액세스: 모든 사용자 → 웹 앱 URL을 config.js의 mediaUrl에 넣기
 *
 * 흐름: 브라우저가 보낸 구글 로그인 토큰으로 ① 주인 계정인지 확인하고 ② 그 토큰으로 드라이브 영상을
 * 16MB씩 읽어 Gemini 파일 저장소로 옮긴 뒤 ③ 시각이 붙은 받아쓰기를 돌려주고 ④ 다 쓰면 지웁니다.
 */
var P = PropertiesService.getScriptProperties();
var GB = 'https://generativelanguage.googleapis.com';
var CHUNK = 16 * 1024 * 1024; // 8MB의 배수

function out(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function doGet() { return out({ ok: true, service: 'media-relay' }); }
function hdr(h, name) { name = name.toLowerCase(); for (var k in h) if (k.toLowerCase() === name) return h[k]; return ''; }
function mmss(s) { s = Math.max(0, Math.round(s)); var h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return (h ? h + ':' + ('0' + m).slice(-2) : m) + ':' + ('0' + x).slice(-2); }
function gen(model, key, body) {
  var r = UrlFetchApp.fetch(GB + '/v1beta/models/' + model + ':generateContent?key=' + key, { method: 'post', contentType: 'application/json', payload: JSON.stringify(body), muteHttpExceptions: true });
  var t = r.getContentText(), j = {}; try { j = JSON.parse(t); } catch (e) {}
  return { code: r.getResponseCode(), text: t, json: j };
}
function textOf(j) { var c = (j.candidates || [])[0]; var ps = c && c.content && c.content.parts || []; return ps.map(function (p) { return p.text || ''; }).join(''); }
function ask(model, key, parts, max) {
  var body = { contents: [{ role: 'user', parts: parts }], generationConfig: { temperature: 0, maxOutputTokens: max || 32000, mediaResolution: 'MEDIA_RESOLUTION_LOW', thinkingConfig: { thinkingBudget: 0 } } };
  var r = gen(model, key, body);
  if (r.code === 400) { delete body.generationConfig.thinkingConfig; delete body.generationConfig.mediaResolution; r = gen(model, key, body); }
  if (r.code >= 300) throw new Error('AI 응답 ' + r.code + ' ' + r.text.slice(0, 200));
  return textOf(r.json);
}
function driveBytes(token, id, from, to) {
  var o = { headers: { Authorization: 'Bearer ' + token }, muteHttpExceptions: true };
  if (from != null) o.headers.Range = 'bytes=' + from + '-' + to;
  var d = UrlFetchApp.fetch('https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(id) + '?alt=media&supportsAllDrives=true', o);
  if (d.getResponseCode() >= 300) throw new Error('드라이브 읽기 실패 ' + d.getResponseCode());
  return d.getContent();
}

function doPost(e) {
  try {
    var b = JSON.parse(e.postData.contents || '{}');
    var key = P.getProperty('GEMINI_API_KEY'), owner = String(P.getProperty('OWNER_EMAIL') || '').toLowerCase();
    if (!key || !owner) return out({ error: '스크립트 속성 GEMINI_API_KEY · OWNER_EMAIL을 넣어 주세요' });
    var ti = UrlFetchApp.fetch('https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + encodeURIComponent(b.token || ''), { muteHttpExceptions: true });
    if (ti.getResponseCode() !== 200) return out({ error: '로그인 확인 실패' });
    if (String(JSON.parse(ti.getContentText()).email || '').toLowerCase() !== owner) return out({ error: '허용되지 않은 계정' });
    var model = P.getProperty('GEMINI_MODEL') || 'gemini-2.5-flash';

    if (b.action === 'ping') return out({ ok: true, model: model });

    if (b.action === 'start') {
      var r = UrlFetchApp.fetch(GB + '/upload/v1beta/files?key=' + key, { method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        headers: { 'X-Goog-Upload-Protocol': 'resumable', 'X-Goog-Upload-Command': 'start', 'X-Goog-Upload-Header-Content-Length': String(b.size), 'X-Goog-Upload-Header-Content-Type': b.mime },
        payload: JSON.stringify({ file: { display_name: String(b.name || 'media').slice(0, 120) } }) });
      var url = hdr(r.getAllHeaders(), 'x-goog-upload-url');
      if (!url) return out({ error: '업로드 시작 실패 ' + r.getResponseCode() + ' ' + r.getContentText().slice(0, 200) });
      return out({ upload: url });
    }

    if (b.action === 'push') {
      var size = +b.size, off = +b.offset, end = Math.min(size, off + CHUNK) - 1;
      var bytes = driveBytes(b.token, b.fileId, off, end), last = off + bytes.length >= size;
      var u = UrlFetchApp.fetch(b.upload, { method: 'post', contentType: 'application/octet-stream', payload: bytes, muteHttpExceptions: true,
        headers: { 'X-Goog-Upload-Offset': String(off), 'X-Goog-Upload-Command': last ? 'upload, finalize' : 'upload' } });
      if (u.getResponseCode() >= 300) return out({ error: '업로드 실패 ' + u.getResponseCode() + ' ' + u.getContentText().slice(0, 200) });
      var res = { offset: off + bytes.length };
      if (last) { var f = JSON.parse(u.getContentText()).file; res.file = { name: f.name, uri: f.uri, state: f.state }; }
      return out(res);
    }

    if (b.action === 'wait') {
      var w = UrlFetchApp.fetch(GB + '/v1beta/' + b.name + '?key=' + key, { muteHttpExceptions: true });
      var j = {}; try { j = JSON.parse(w.getContentText()); } catch (x) {}
      return out({ state: j.state || 'PROCESSING' });
    }

    if (b.action === 'transcribe') {
      var part = { fileData: { mimeType: b.mime, fileUri: b.uri } };
      var seg = '';
      if (b.start != null) { part.videoMetadata = { startOffset: b.start + 's', endOffset: b.end + 's' }; seg = '이 파일의 ' + mmss(b.start) + '부터 ' + mmss(b.end) + '까지 구간만 받아쓴다. 시각은 파일 맨 처음부터 잰 시각으로 적는다.\n'; }
      var prompt = (b.kind === 'video' ? '영상' : '음성') + '의 말을 빠짐없이 받아쓴다. 한국어는 한국어로, 다른 말은 그 말 그대로.\n' + seg +
        '- 한 줄에 한 덩어리로, 줄 맨 앞에 [분:초] 또는 [시:분:초] 시각을 붙인다.\n- 말이 없고 화면 글자(자막 · 슬라이드)만 있으면 "[시각] (화면) 글자"로 적는다.\n- 요약하거나 설명을 보태지 않는다. 받아쓴 글만 출력한다.';
      return out({ text: ask(model, key, [part, { text: prompt }]) });
    }

    if (b.action === 'describe') {
      var img = driveBytes(b.token, b.fileId);
      if (img.length > 15 * 1024 * 1024) return out({ error: '사진이 너무 큽니다' });
      var t = ask(model, key, [{ inlineData: { mimeType: b.mime || 'image/jpeg', data: Utilities.base64Encode(img) } },
        { text: '이 사진 속 글자를 모두 그대로 옮겨 적고(없으면 생략), 이어서 사진에 무엇이 있는지 3~5문장으로 설명한다. 한국어로. 지어내지 않는다.' }], 4000);
      return out({ text: t });
    }

    if (b.action === 'drop') { UrlFetchApp.fetch(GB + '/v1beta/' + b.name + '?key=' + key, { method: 'delete', muteHttpExceptions: true }); return out({ ok: true }); }

    return out({ error: '알 수 없는 요청' });
  } catch (err) { return out({ error: String(err && err.message || err).slice(0, 300) }); }
}

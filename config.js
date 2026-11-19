/* AI포켓 v16 · 최소 AI 사용 / 최대 활용 */
/* Dora에몽 · 연결 설정 — API 키/비밀번호/Google access token은 이 파일에 넣지 않습니다. */
window.LX_CONFIG = {
  permissionMode: "least-privilege", // Drive 전체 읽기 + AI포켓이 만든/업로드한 파일만 쓰기
  clientId: "383723869928-k5lsrn10up6rgne0j3pmmd3t6dov82ch.apps.googleusercontent.com",
  ownerEmail: "leehyesung516@gmail.com",

  // 일반 텍스트 AI는 기존 중계를 우선 사용합니다. 실패하면 index.html이 mediaUrl로 자동 재시도합니다.
  relayUrl: "https://script.google.com/macros/s/AKfycbylw2CDwknsHfS8z9MQAbH26Fm8xupTs-lPfQ0moHggaUR1ObBg9EKVjZa9wGaWHu57/exec",

  // 영상 · 음성 · 사진 + JSON 구조화 출력용 통합 중계
  mediaUrl: "https://script.google.com/macros/s/AKfycbzgomZ53DrojzwSgA-FxzImW2L8T4XhokG6gC0L1TPhkbP5ST_Px28P75cns71OX9NsXA/exec",

  rootName: "도라에몽 서재",
  storeKey: "doraemon",
  appName: "Dora에몽",
  subName: "AI포켓",
  tagline: "내 자료에서 꺼내쓰는 AI포켓"
};

# {{PROJECT_NAME}} 팀 메모리

이 저장소는 {{PROJECT_NAME}} 프로젝트의 팀 공유 메모리다. 루트의 `.md` 파일은 핵심 메모리이고, 아래 디렉터리는 필요할 때 직접 읽는다.

- [project.md](project.md): 프로젝트 정체, 현재 목표, 핵심 규칙 (짧게 유지)
- [decisions/](decisions/MEMORY.md): 결정 기록. 결정, 이유, 대안, 근거 세션, 상태
- [changes/](changes/MEMORY.md): 주요 변경 요약 (무엇이 언제 왜 바뀌었나)
- [context/](context/MEMORY.md): 도메인 지식, 외부 시스템, 연동 맥락
- [people/](people/MEMORY.md): 담당 영역과 팀원별 작업 관례

## Rules for reflection

- 결정은 `decisions/YYYY-MM-DD-<slug>.md`에 하나씩 쓴다. 본문 섹션은 `## 결정`, `## 이유`, `## 대안`, `## 근거 세션`, `## 상태`. 근거 세션에는 주입 헤더의 member/tool/session 값을 적는다.
- 결정이 바뀌면 옛 파일을 지우지 않는다. 옛 파일의 상태를 `상태: superseded by <새 파일>`로 바꾸고 새 파일을 만든다.
- 루트는 가볍게 유지한다. 루트에는 `project.md`, `persona.md`, `human.md`만 둔다. 새 내용은 위 디렉터리 중 가장 가까운 곳에 넣는다.
- `MEMORY.md`를 제외한 모든 파일은 `name`, `description` frontmatter가 있어야 한다 (다른 키는 쓰지 않는다).
- 새 파일을 만들면 가장 가까운 `MEMORY.md` 목록에 한 줄 설명과 함께 링크한다.
- 비밀값(토큰, 비밀번호, API 키, 개인 접속 정보)은 절대 저장하지 않는다. 필요하면 "어디에 있는지"만 적는다.

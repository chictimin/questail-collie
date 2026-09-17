# questail-collie

QuestTail 게임 라이브러리 라우팅 에이전트.

질문을 카테고리로 분류해 근거 문서를 조립하고, 근거로만 답한다. 근거가 없으면 답을 지어내지 않고 이관한다. LangGraph.js 그래프(`classify → assemble_context → answer → verify` + `escalate`, 검증 실패 시 1회 재생성)와 Hono 단일 화면 데모로 구성된다.

## 실행 요건

실행에 LLM 엔드포인트가 필요하다. 분류·답변을 LLM이 만들기 때문이다. 아래 두 갈래 중 하나를 고른다.

### (a) 로컬 — Ollama

```sh
ollama serve         # 로컬 서버
ollama pull qwen3:8b # 모델 받기 (약 5GB)
```

기본값은 base URL `http://localhost:11434/v1`, 모델 `qwen3:8b`이다. 그대로 두면 설정이 필요 없다.

### (b) 원격 — OpenAI 호환 엔드포인트

OpenAI 호환이면 어디든 된다. 환경변수 세 개만 설정하면 코드 변경 없이 동작한다.

```sh
QUESTAIL_LLM_BASE_URL=...
QUESTAIL_LLM_API_KEY=...
QUESTAIL_LLM_MODEL=...
```

전역 설정 파일 `~/.config/questail/.env` 또는 저장소 루트 `.env` 둘 다 읽는다(루트가 덮어쓴다).

### 결과만 보고 싶은 경우

> TODO(측정 후 — `data/results/` JSON과 REPORT.md (4)항이 채워지면 이 절을 갱신한다)

## 실행법

```sh
pnpm install   # 의존성 설치
pnpm dev       # 데모 서버 (http://localhost:3000)
pnpm eval      # 평가셋 2지표 측정
pnpm typecheck # 타입 검사
```

데모 화면에서 질문을 입력하면 답변과 함께 호출한 도구·근거 문서 부분·검증 결과를 각각 볼 수 있다.

## 디렉토리 구조

```text
src/
  graph.ts      # LangGraph 파이프라인 (runCollie)
  nodes/        # classify · assemble · answer · verify · escalate
  context.ts    # CollieDeps 조립 (docs 청킹 + data 로드 + LLM 주입)
  llm.ts        # LLM 엔드포인트 해석 (OpenAI 호환)
  server.ts     # Hono 데모 서버
  prompts.ts    # 프롬프트
  evaluate.ts   # 평가 스크립트
  types.ts      # 타입 계약 (오케스트레이터 전속)
docs/           # 근거 산문 3종 + 청크 매핑표
data/mock/      # 합성 목데이터 (아래 고지 참고)
public/         # 데모 단일 HTML
vendor/         # @questail/core tarball
REPORT.md       # 과제 보고서
```

## 데이터 고지

`data/mock`의 모든 값은 합성 데이터이며 실제 사용자 게임 이력이 아니다. 게임명·appid·장르만 실제 Steam 공개 정보를 차용했고, 플레이타임·별점·상태·기피 사유 등 나머지 값은 seed 고정 난수로 생성했다. 실데이터는 이 저장소에 포함되지 않는다. 상세는 `data/mock/META.md` 참고.

## 의존 관계

`@questail/core`를 npm 레지스트리가 아닌 `vendor/questail-core-0.2.0.tgz` tarball로 소비한다(`file:` 의존). 형제 프로젝트 questail의 코어 패키지를 tarball로 고정 소비한다. 아직 npm에 배포 전이라 이 방식을 쓰며, core 의존은 tarball이라 레지스트리 조회 없이 해결된다. 읽기 경로(라이브러리·프로필 로드)로만 쓴다. 수집·저장 경로는 건드리지 않는다.

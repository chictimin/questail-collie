# questail-collie

QuestTail 게임 라이브러리 라우팅 에이전트.

질문을 카테고리로 분류해 근거 문서를 조립하고, 근거로만 답한다. 근거가 없으면 답을 지어내지 않고 이관한다. LangGraph.js 그래프(`classify → assemble_context → answer → verify` + `escalate`, 검증 실패 시 1회 재생성)와 Hono 단일 화면 데모로 구성된다.

과제 보고서: [REPORT.md](REPORT.md)

![데모 화면. 질문 말풍선과 재생성 루프를 탄 진행 경로, 검증 통과 메타가 보인다.](docs/web-ui.png)

데모 화면. 첫 질문은 재생성 루프를 거쳐 검증 통과했고, 두 번째 질문이 답변 생성 중이다.

## 실행 요건

실행에 LLM 엔드포인트가 필요하다. 분류·답변을 LLM이 만들기 때문이다. 기본 경로는 원격이라 키가 필요하고, 키 없이 돌려보려면 로컬 대체 경로를 쓴다.

### (a) 기본 — 원격 (키 필요)

기본값은 base URL `https://opencode.ai/zen/go/v1`, 모델 `mimo-v2.5`다(OpenCode Go 플랜 전용 경로). 키만 설정하면 된다.

```sh
QUESTAIL_LLM_API_KEY=...
```

저장소 루트 `.env` 또는 전역 설정 파일 `~/.config/questail/.env`에 둔다(루트가 덮어쓴다). base URL·모델을 바꾸려면 `QUESTAIL_LLM_BASE_URL`·`QUESTAIL_LLM_MODEL`도 같은 파일에 둔다. OpenAI 호환이면 어디든 된다.

### (b) 대체 — 로컬 Ollama (키 불필요)

```sh
ollama serve         # 로컬 서버
ollama pull qwen3:8b # 모델 받기 (약 5GB)
```

그 뒤 환경변수 세 개를 로컬 값으로 둔다. 로컬호스트는 키 없이도 통과한다.

```sh
QUESTAIL_LLM_BASE_URL=http://localhost:11434/v1
QUESTAIL_LLM_MODEL=qwen3:8b
```

### 결과만 보고 싶은 경우

LLM 키 없이도 읽을 수 있다. 측정 결과 JSON이 커밋되어 있어 clone만 하면 된다.

| 시점 | 도구 호출 적절성 | 답변 적절성 |
|---|---|---|
| 초기 (1차) | 12/27 | 8/27 |
| 도구 재설계 전 (T1 3회, 공통 26문항) | 11/26 | 10/26 |
| **최종 (본측정 3회 범위)** | **24~26/27** | **19~20/27** |

답변 지표는 정답지(`data/answer_gold.json`)가 초기부터 바뀌지 않아 직접 비교된다. 도구 지표는 도구를 4종에서 9종으로 재설계하며 기대 도구를 바꿨으므로 직접 비교가 되지 않는다 — 상세와 한계는 `REPORT.md` 최상단 요약에 있다.

개선 페이즈별 기록, 실패 원인 분석, 측정 3회가 겹쳐 실행된 한계는 `REPORT.md` (4)절에 있다.

## 실행법

검증된 순서대로 따라한다.

```sh
git clone https://github.com/chictimin/questail-collie.git && cd questail-collie
pnpm install          # 의존성 설치
# 키 설정: 저장소 루트 .env에 QUESTAIL_LLM_API_KEY=... (위 실행 요건 참고)
pnpm dev              # 데모 서버 (http://localhost:3000)
```

키 설정이 없으면 화면은 뜨지만 질의가 안내 메시지로 실패한다. 크래시가 아니다.

그 외 명령어:

```sh
pnpm eval                                 # 본측정 — 2지표 (LLM 키 필요, 동시성 4에서 약 15분)
npx tsx src/dryrun.ts                     # 도구 라우팅만 오프라인 채점 (LLM 0회, 초 단위)
npx tsx src/dryrun.ts --refresh-classify  # 분류 캐시 재생성 (분류 프롬프트를 고쳤을 때만)
pnpm typecheck                            # 타입 검사
```

도구 선택이 결정적 코드라 **LLM 없이 도구 점수를 잴 수 있다.** `dryrun.ts`는 분류 결과를 `data/classify_cache.json`에 고정해두고 라우터만 반복 채점한다. 본측정을 대체하지 않는다 — 답변 지표는 여기서 나오지 않는다. 채점 규칙은 `evaluate.ts`의 `toolScoreFor`를 그대로 import해 본측정과 어긋나지 않는다.

`pnpm eval`에는 **실행 락**이 걸려 있다. 측정이 이미 돌고 있으면 두 번째 실행이 LLM 호출 전에 거부된다. 두 측정이 겹치면 실제 동시성이 배가 되어 회차 간 비교가 오염되기 때문이다.

`pnpm install` 직후 `Ignored build scripts: esbuild@0.28.2` 경고가 뜨지만 실행에 지장이 없다. 별도 조치가 필요 없다.

## 데모 화면

챗봇 레이아웃의 단일 화면이다. 질문·답변 말풍선이 위에 누적되고, 아래 입력창에서 계속 물을 수 있다.

- 답변 생성 중에는 단계별 진행 표시가 나온다(카테고리 판정 → 도구 라우팅과 근거 조립 → 근거로 답변 생성 → 근거 이탈 검사). 각 단계 소요 시간이 함께 찍히고, 끝나면 경로 한 줄로 접힌다.
- 답변 말풍선 아래 작은 글씨 메타 2줄에 분류 결과·confidence·호출한 도구·소요 시간·검증 결과·이관 여부가 붙는다. 위반이 있으면 규칙과 내용이 함께 나온다.
- 근거는 접기/펼치기 형태다. 접힌 상태에서도 건수가 표시되고, 펼치면 문서 id와 텍스트를 대조할 수 있다.
- 헤더에 현재 연결된 엔드포인트와 모델이 표시된다.
- 응답에 20~40초 걸린다(LLM 3회 왕복). 멈춘 것이 아니니 진행 표시를 보고 기다린다.

## REPORT 안내

- [(1) 주제와 근거 문서](REPORT.md#-1-주제와-근거-문서) — 왜 게임 라이브러리인지, 근거 6종의 성격과 출처.
- [(2) 카테고리 설계](REPORT.md#-2-카테고리-설계) — 5개 카테고리와 청크 매핑표.
- [(3) 평가셋 설계](REPORT.md#-3-평가셋-설계) — 30문항 구성, 저자 분리, 채점 기준, 함정 설계.
- [(4) 측정 결과](REPORT.md#-4-측정-결과) — 2회 측정 비교, 개선 사이클, 실패 문항 인용.
- [(5) 파이프라인 구조도](REPORT.md#-5-파이프라인-구조도) — 그래프 노드와 분기.
- [(6) 데모 설계](REPORT.md#-6-데모-설계) — 화면 구성과 캡처 2장.
- [(7) 프로젝트 회고](REPORT.md#-7-프로젝트-회고) — 오염·비결정 등 측정에서 배운 점.

## 디렉토리 구조

```text
src/
  graph.ts      # LangGraph 파이프라인 (runCollie)
  nodes/
    classify.ts # 카테고리 판정 + 게임명 후보 추출 (LLM)
    router.ts   # 결정적 도구 라우터 (LLM 없음)
    tools.ts    # 도구 9종 실행 + 근거 렌더링
    assemble.ts # 라우터 결과로 근거 조립
    answer.ts   # 근거로 답변 생성 (LLM)
    verify.ts   # 근거 이탈 기계 검사
    escalate.ts # 범위 밖 이관
  context.ts    # CollieDeps 조립 (docs 청킹 + data 로드 + LLM 주입)
  llm.ts        # LLM 엔드포인트 해석 (OpenAI 호환)
  server.ts     # Hono 데모 서버
  prompts.ts    # 프롬프트
  evaluate.ts   # 평가 스크립트 (본측정 · 실행 락 포함)
  dryrun.ts     # 오프라인 도구 채점 (LLM 0회)
  types.ts      # 타입 계약 (오케스트레이터 전속)
docs/           # 근거 산문 3종 + 청크 매핑표
data/mock/      # 합성 목데이터 (아래 고지 참고)
data/classify_cache.json  # 드라이런용 분류 결과 고정 (본측정에는 쓰지 않는다)
public/         # 데모 단일 HTML
vendor/         # @questail/core tarball
REPORT.md       # 과제 보고서
```

## 데이터 고지

`data/mock`의 모든 값은 합성 데이터이며 실제 사용자 게임 이력이 아니다. 게임명·appid·장르만 실제 Steam 공개 정보를 차용했고, 플레이타임·별점·상태·기피 사유 등 나머지 값은 seed 고정 난수로 생성했다. 실데이터는 이 저장소에 포함되지 않는다. 상세는 `data/mock/META.md` 참고.

## 의존 관계

`@questail/core`를 npm 레지스트리가 아닌 `vendor/questail-core-0.2.0.tgz` tarball로 소비한다(`file:` 의존). 형제 프로젝트 [questail](https://github.com/chictimin/questail)의 코어 패키지를 tarball로 고정 소비한다. 아직 npm에 배포 전이라 이 방식을 쓰며, core 의존은 tarball이라 레지스트리 조회 없이 해결된다. 읽기 경로(라이브러리·프로필 로드)로만 쓴다. 수집·저장 경로는 건드리지 않는다.

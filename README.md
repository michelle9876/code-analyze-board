# Code Analysis View Board

GitHub 저장소를 clone하고, `repo -> folder -> file -> history` 단위로 구조, 흐름, 기술 포인트를 분석해 보드에서 관리하는 로컬 MVP입니다.

이 프로젝트는 “아무 public GitHub repo를 가져와도 개발자가 빠르게 구조를 읽고, 중요 파일과 변화 흐름을 파악할 수 있는 웹 보드”를 목표로 합니다.

## What this app does

- GitHub URL import
- canonical URL 중복 방지
- quick scan 후 board 카드 즉시 업데이트
- repo overview / folder analysis / file analysis / recent history summary
- repo category 관리 + AI tags 표시
- background worker 기반 hybrid analysis
- folder / file missing path 클릭 시 on-demand analysis enqueue
- diagram graph + Mermaid text + Shiki source preview 제공
- fallback reason 표시
  - 예: `quota_exceeded`, `invalid_api_key`, `missing_api_key`

## Product shape

- `Local MVP`
- `Hybrid analysis UX`
  - import 직후 quick scan 결과를 먼저 보여줌
  - deep analysis는 worker가 백그라운드에서 채움
- `Structured Outputs`
  - OpenAI 응답은 Zod schema 기반 typed artifact로 저장
- `Fallback-safe`
  - OpenAI 호출 실패 시에도 heuristic 분석으로 board가 계속 동작

## Screens

### 1. Board

- GitHub URL 입력
- category filter
- repo 검색
- quick summary
- detected stack / AI tags
- `Live AI` 또는 `Fallback` 상태
- fallback reason 배너

### 2. Repo detail

- 좌측: repository tree
- 중앙: overview / folder / file / history analysis panel
- 우측: repo meta / current focus / recent history glance
- missing folder/file 선택 시 자동 재분석 요청

## Analysis pipeline

1. `POST /api/repos/import`
2. repo clone
3. quick scan
4. repo analysis
5. history analysis
6. budgeted folder/file precompute
7. 사용자가 특정 path를 열면 on-demand folder/file analysis

### Stored artifact scopes

- `repo`
- `folder`
- `file`
- `history`

### Artifact metadata

- `provider`
- `promptVersion`
- `reasoningEffort`
- `coverageMode`
- `fallbackReason`
- `fallbackMessage`
- `sourceLanguage`
- `sourcePreviewHtml`

## Tech stack

- Next.js App Router + TypeScript
- Tailwind CSS + custom shadcn-style UI primitives
- Prisma + SQLite
- OpenAI Responses API + Structured Outputs(Zod)
- React Flow + Mermaid export text
- Shiki code preview
- simple-git background worker

## Project structure

```text
src/app                 Next.js routes and pages
src/components          board/detail UI
src/lib                 analysis, git, DB, OpenAI, query logic
scripts/worker.ts       background analysis worker
scripts/db-push.mjs     SQLite bootstrap helper
prisma/schema.prisma    Prisma schema
data/repos              cloned repositories
```

## Setup

### 1. Install

```bash
npm install
cp .env.example .env
```

### 2. Configure environment

```env
DATABASE_URL="file:./dev.db"
OPENAI_API_KEY="your_key_here"
```

### 3. Prepare local database

```bash
npm run db:generate
npm run db:push
npm run db:seed
```

### 4. Start the app

```bash
npm run dev
```

별도 터미널에서 worker를 실행합니다.

```bash
npm run worker
```

## Environment variables

- `DATABASE_URL`: Prisma SQLite 경로
- `OPENAI_API_KEY`: OpenAI API key
- `OPENAI_MODEL_REPO`: 기본 `gpt-5.4`
- `OPENAI_MODEL_DEEP`: 기본 `gpt-5.4-mini`
- `OPENAI_MODEL_FAST`: 기본 `gpt-5.4-nano`
- `REPO_STORAGE_ROOT`: clone 저장 루트
- `WORKER_POLL_MS`: worker polling interval

## API surface

- `POST /api/repos/import`
- `GET /api/repos`
- `GET /api/repos/:id`
- `PATCH /api/repos/:id/category`
- `POST /api/repos/:id/reanalyze`
- `GET /api/repos/:id/tree`
- `GET /api/repos/:id/analysis?scope=repo|folder|file|history&path=...`

## Current behavior with OpenAI

- OpenAI Responses API를 사용합니다.
- Structured Outputs는 `text.format` 기반 Zod schema parsing을 사용합니다.
- 모델 응답 저장은 기본적으로 `store: false`입니다.
- worker와 app 모두 `.env`를 읽도록 보강되어 있습니다.
- OpenAI 호출이 실패하면 fallback artifact로 저장되며, UI에 fallback reason이 표시됩니다.

## Known limitations

- 현재 범위는 public GitHub repo 중심입니다.
- private repo auth는 아직 포함하지 않습니다.
- full diff timeline은 아직 없고, recent history summary 중심입니다.
- OpenAI quota 또는 billing 문제가 있으면 `Live AI` 대신 `Fallback` 분석이 표시됩니다.
- Prisma schema engine 이슈를 피하기 위해 `db:push`는 프로젝트 전용 SQLite bootstrap 경로를 사용합니다.

## Recommended next steps

- OpenAI quota/billing이 준비되면 `provider: openai` artifact를 다시 확인
- private repo auth 추가
- richer history diff timeline
- batch refresh / scheduled refresh
- README screenshots or demo GIF 추가

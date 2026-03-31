# Code Analysis View Board

GitHub 저장소를 clone하고, repo -> folder -> file 단위로 구조/흐름/기술 포인트를 분석해 한눈에 관리하는 로컬 MVP입니다.

## Stack

- Next.js App Router + TypeScript
- Tailwind CSS + shadcn-style UI components
- Prisma + SQLite
- OpenAI Responses API + Structured Outputs(Zod)
- React Flow + Mermaid export text
- Shiki code preview
- simple-git background worker

## What this app does

- GitHub URL import
- canonical URL 중복 방지
- quick scan 후 보드 카드 즉시 업데이트
- repo overview / folder analysis / file analysis / recent history summary
- background worker 기반 hybrid analysis
- category 관리 + AI tags 표시

## Setup

```bash
npm install
cp .env.example .env
npm run db:generate
npm run db:push
npm run db:seed
npm run dev
```

별도 터미널에서 worker를 실행합니다.

```bash
npm run worker
```

## Environment

- `DATABASE_URL`: Prisma SQLite 경로
- `OPENAI_API_KEY`: OpenAI API key
- `OPENAI_MODEL_REPO`: 기본 `gpt-5.4`
- `OPENAI_MODEL_DEEP`: 기본 `gpt-5.4-mini`
- `OPENAI_MODEL_FAST`: 기본 `gpt-5.4-nano`
- `REPO_STORAGE_ROOT`: clone 저장 루트
- `WORKER_POLL_MS`: worker polling interval

## Notes

- OpenAI Responses API를 사용합니다.
- Structured Outputs는 `text.format` 기반 Zod schema parsing을 사용합니다.
- 모델 응답 저장은 기본적으로 `store: false`입니다.
- API key가 없거나 OpenAI 호출이 실패하면 heuristic fallback 분석으로 최소 기능을 유지합니다.
- v1은 public GitHub repo 중심이며 private repo auth는 포함하지 않습니다.

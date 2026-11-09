# CLAUDE.md

> **Git policy — never auto-commit or auto-push.** Leave work in the working tree. Run `git commit`,
> `git push`, `gh pr create`, or `scripts/push_all.sh` **only when the user explicitly asks in that
> turn** — earlier approval doesn't carry forward, and finishing a task is not permission to commit.

## Project Overview

`sudojo_bot` (v1.0.70, `private`, BUSL-1.1) is a Microsoft Bot Framework chatbot. A user sends a
photo of a Sudoku; the bot sends it to **sudojo_api** for OCR (`POST /api/v1/ocr/extract`), validates
it through the same API's solver proxy, then walks through step-by-step hints rendered as PNG boards
inside Adaptive Cards. There is no local OCR engine. It ships as a Docker image only (no npm publish).

**Stack:** Bun · TypeScript 5 strict (ESM) · `botbuilder`/`botbuilder-dialogs` 4.23 · restify 11 ·
`@napi-rs/canvas` · `@sudobility/sudojo_client` · i18next 26 · Adaptive Cards 1.5 · ESLint 9 + typescript-eslint 8 · Prettier 3.

## Commands

**Bun only** (Bun 1.3.x locally, `oven/bun:1` in Docker). Do not use npm, yarn, or pnpm.

| Command | What it does | Verified |
|---------|--------------|----------|
| `bun install` | Install deps | not run |
| `bun run dev` | `bun run --watch src/index.ts` on port 3978 | not run (long-running) |
| `bun run start` | `bun run src/index.ts` (same as Docker `CMD`) | not run |
| `bun run typecheck` | `tsc --noEmit` | passes |
| `bun run lint` | `eslint src` | passes |
| `bun run format` | `prettier --write src` | `prettier --check src` clean |
| `bun run build` | `tsc` → `dist/` (gitignored; runtime uses `src/`, so this is an emit check) | passes |
| `bun run clean` | `rm -rf dist` | |
| `bun run test:unit` | `bun test` — all tests are fast unit tests (81 tests, ~1s, offline) | 81 pass |
| `bun run test:watch` | `bun test --watch` | |
| `bun run sync:hint-headings` | Copies the `headings` tree from `../sudojo_app/public/locales/en/hints.json` into `src/i18n/locales/en.headings.json` (optional arg: another hints.json path) | passes |

There is **no `test` script** (`bun run test` fails — use `bun run test:unit` or `bun test`) and no
`verify` script. Bun auto-loads `.env` (there is no dotenv dependency). Deps install from **GitHub
Packages** (`.npmrc` scopes `@sudobility` to `npm.pkg.github.com`); `bun install` needs a token with
`read:packages` in `~/.npmrc` (`//npm.pkg.github.com/:_authToken=…`).

## Architecture

```
POST /api/messages ─► restify (src/index.ts) ─► CloudAdapter (ConfigurationBotFrameworkAuthentication)
                                                   │
                                     SudokuHintBot.run()  (src/bot.ts, ActivityHandler)
                                     ├─ onMembersAdded ─► createWelcomeCard()
                                     └─ onMessage ─► MainDialog.onMessageActivity(ctx, data) ─► new data
                                                        │ (plain method call, NOT the dialog stack)
          ┌─────────────────────────────────────────────┼──────────────────────────────┐
  attachment: ImageService.downloadAttachment   text / card action:              BoardRenderer.render()
            → OCRService.extractPuzzle            SolverService.solve()          (@napi-rs/canvas, 450px PNG,
              POST {SOLVER_API_URL}/api/v1/ocr/extract  GET {SOLVER_API_URL}/api/v1/solver/solve   inlined as a
            → OCRService.validatePuzzle            GET {SOLVER_API_URL}/api/v1/solver/validate  data: URL)
            → SolverService.validate()
GET /health ─► 200 { status, name } (strings from i18n)
State: MemoryStorage → ConversationState property "SudokuConversationData" (lost on restart)
```

- **Only `MainDialog.onMessageActivity()` is live.** `MainDialog.run()` is never called, so these are
  dormant: `HintDialog`, `PuzzleUploadDialog` (both `addDialog`-registered), the intro waterfall, and
  their card builders (`createHintStepCard`, `createHintAppliedCard`, `createNoHintCard`). The live
  cards are built inline in `mainDialog.ts`; `createProgressCard` is unused.
- `UserState` is created and saved each turn but never written (`SudokuUserData` is unused).
- All user-facing strings go through i18next `t()` (`src/i18n/index.ts`; English only, `src/i18n/locales/en.json`).
- **Per-step hint headings** live in a second i18next namespace, `headings` (`src/i18n/locales/en.headings.json`),
  a copy of sudojo_app's en `hints.json` `headings` tree. Don't hand-edit it; run `bun run sync:hint-headings`.
  `getStepHeading(step)` (`src/cards/hintHeading.ts`) maps the step's `hints.<path>` key to `<path>` in that
  namespace, fills `{{valueN}}` from `values[N-1]`, and returns `''` when there's no leaf heading. The live card
  (`sendHintStepWithImage`) adds it as a bold line above `step.text` when non-empty.

### Message routing (`src/dialogs/mainDialog.ts`)

| Input (text is lowercased and trimmed) | Handler |
|-------|---------|
| any attachment | `handleImageUpload`: OCR → validate → puzzle card with confirm/reject |
| `help`, `?` | help card |
| `new`, `new puzzle`, `start` / action `new_puzzle`, `reject_puzzle` | reset state |
| `hint`, `get hint` / action `get_hint` | `solve()` → step 1 card (re-sends puzzle card if not yet confirmed) |
| `next`, `next step` / action `next_step` | next step |
| action `previous_step` (no text equivalent) | previous step |
| `apply`, `apply hint` / action `apply_hint` | re-`solve()`, take `board.user` + pencilmarks |
| `status`, `progress` / action `show_progress` | progress card |
| action `confirm_puzzle` / `upload` | set `puzzleConfirmed` / ask for a photo |
| anything else | welcome card (no puzzle) or default prompt |

Card buttons are `Action.Submit` with `data: { action }`, read from `context.activity.value.action`.

### State (`src/state/conversationState.ts`)

- `SudokuConversationData { currentPuzzle: PuzzleState | null; currentHint: HintState | null; puzzleConfirmed }`
- `PuzzleState { original, user, solution?, confidence, pencilmarks?, autopencil? }`: 81-char strings
  with `'0'` = empty. `pencilmarks` is 81 comma-separated entries.
- `HintState { steps: SolverHintStep[], currentStepIndex, technique (name), level }`

Handlers return the conversation data (a new object when it changed); `bot.ts` stores it and `run()` saves state.

## Directory Map

```
src/
├── index.ts               # restify server, adapter, storage, DI wiring, /health
├── bot.ts                 # SudokuHintBot (ActivityHandler)
├── dialogs/               # mainDialog.ts (live); hintDialog.ts, puzzleUploadDialog.ts (dormant)
├── services/              # ocrService, solverService, imageService, boardRenderer, networkClient (+ *.test.ts)
├── cards/                 # welcomeCard, puzzleCard, hintCard (+ *.test.ts); hintHeading.ts (getStepHeading)
├── state/                 # conversationState.ts (+ test)
└── i18n/                  # i18next init + locales/en.json; locales/en.headings.json (SYNCED, `headings` ns)
Dockerfile                 # 3-stage oven/bun build; runs `bun run src/index.ts`
.github/workflows/ci-cd.yml# calls johnqh/workflows unified-cicd.yml
scripts/sync-hint-headings.cjs # copies the en `headings` tree from ../sudojo_app
docs/DEPLOYMENT.md         # Azure Bot + channel setup, Docker, sudobility_dockerized/Traefik
plans/IMPROVEMENTS.md      # improvement backlog
```

## Environment Variables

See `.env.example`.

| Name | Code default | Notes |
|------|--------------|-------|
| `MICROSOFT_APP_ID` | none | Azure Bot app ID; leave blank for local Emulator |
| `MICROSOFT_APP_PASSWORD` | none | client secret; never log it |
| `MICROSOFT_APP_TYPE` | `SingleTenant` | |
| `MICROSOFT_APP_TENANT_ID` | none | required for `SingleTenant` |
| `SOLVER_API_URL` | `http://localhost:3000` | base URL of **sudojo_api**, not the C# solver |
| `PORT` | `3978` | |

The Docker image sets `NODE_ENV=production`, but the code never reads it.

## Sibling Repos & Contracts

| Sibling | Contract |
|---------|----------|
| `@sudobility/sudojo_client` `^0.0.178` | `SudojoClient.extractOcr(token, base64Image)` → `POST /api/v1/ocr/extract`, imported from the React-free **`/network` subpath** (the package root pulls in React Query hooks). Its constructor takes a `NetworkClient`; the bot's is `src/services/networkClient.ts` (`FetchNetworkClient`) |
| `@sudobility/sudojo_types` `^1.2.80` | `SolveData`, `ValidateData`, `SolverBoard`, `SolverHints`, `SolverHintStep`, `SolverColor`, `getTechniqueNameById` |
| `@sudobility/types` `^1.9.78` | `BaseResponse<T>` envelope `{ success, data, error }` |
| **sudojo_api** (runtime) | `GET /api/v1/solver/solve?original&user&autopencilmarks[&pencilmarks]`, `GET /api/v1/solver/validate?original`, and `POST /api/v1/ocr/extract` `{ image }` (base64, no `data:` prefix) → `{ board, confidence, digitCount }`. sudojo_api proxies the solver calls to **sudojo_solver** `/api/solve` and `/api/validate`, and runs OCR through sudojo_ocr_ml with its own Tesseract fallback. It listens on port 3000 by default. The bot sends no `Authorization` or `X-API-Key` header (the OCR token is `''`), so sudojo_api treats it as an anonymous client |
| sudojo_app `scripts/push_all.sh` | releases `sudojo_bot` last in the sudojo family and bumps the `@sudobility/*` deps and the version. That produces the `chore: update @sudobility dependencies…` commits |

Nothing depends on this repo.

## CI/CD & Release

`.github/workflows/ci-cd.yml` calls `johnqh/workflows/.github/workflows/unified-cicd.yml@main` with
`docker-image-name: sudojo_bot`, `skip-npm-publish: true`, and `publish-target: github`. The
workflow runs typecheck, lint, `bun test`, and build.

- **`develop`:** tests only.
- **`main`:** if the `package.json` version has no tag yet, it creates a GitHub release and pushes
  `$DOCKERHUB_USERNAME/sudojo_bot:<version>` and `:latest`.

Hosting goes through `sudobility_dockerized` (see docs/DEPLOYMENT.md).

## Conventions

- ESM (`"type": "module"`). Relative imports use a `.js` suffix (`'./bot.js'`).
- `verbatimModuleSyntax` + `erasableSyntaxOnly`: use `import type`/inline `type`; no enums, namespaces,
  or constructor parameter properties. Prefix unused params/vars with `_` (tsc + ESLint enforce it).
- Prettier: single quotes, 100 columns, 2 spaces, `arrowParens: avoid`, LF.
- Tests use `bun:test`, sit next to source as `*.test.ts`; solver/OCR tests stub `globalThis.fetch`.
- User-facing text goes in `en.json`. Read it with `t('section.key', { vars })`.

## Gotchas

- **OCR is server-side.** `OCRService` (`src/services/ocrService.ts`) is a stateless wrapper over
  `SudojoClient.extractOcr()`; its constructor takes `(baseUrl, token = '')` and `src/index.ts` passes
  `SOLVER_API_URL` and `''`. sudojo_api serves both the solver proxy and the unauthenticated OCR route.
- **Import sudojo_client from `@sudobility/sudojo_client/network`** — the package root pulls in React Query hooks.
- **`SOLVER_API_URL` must point at sudojo_api,** not sudojo_solver (which serves `/api/solve`, has no
  `/api/v1/solver/*` and no OCR route → 404s).
- **"Apply" doesn't replay the stored hint.** It re-runs `solve()` and uses the solver's `board.user`;
  `SolverService.applyHint()` ignores its `_user` argument.
- `validate()` maps any non-success response to `{ valid: false }` (shown as "no unique solution");
  `solve()` throws instead. Network errors throw from both.
- An upload uses the first attachment whose `contentType` is `image/*` or `application/octet-stream`,
  or a Teams file upload (`application/vnd.microsoft.teams.file.download.info`) with an image
  `fileType`, fetched from its pre-authenticated `content.downloadUrl`.
- **Attachment auth (`imageService.ts`):** on `msteams` only, a `contentUrl` whose hostname is the
  activity's `serviceUrl` origin, `smba.trafficmanager.net`, `*.teams.microsoft.com`, or
  `*.asm.skype.com` gets the bot's connector token (`connectorClient.credentials.signRequest()`;
  `connectorClient` comes from `turnState[adapter.ConnectorClientKey]`). Every other URL is unauthed.
- Board text uses `system-ui`/`sans-serif`; `oven/bun:1-slim` installs no font packages, so digits may
  not render in the container (unverified). `BoardRenderer` supports `darkMode` but no caller sets it.
- **"Solved" is judged from the grid, not the solution.** `SolverService.isPuzzleSolved(original, user)`
  returns true when the merged grid is full and every row/col/box holds 1-9 once. Don't compare against
  `PuzzleState.solution`: sudojo_api encrypts it (`enc:` + base64 AES-256-GCM) when `SOLUTION_ENCRYPTION_KEY` is set.

## Known Issues (reported, not fixed)

- `HintDialog` (dormant) calls `solve()` without pencilmarks, unlike `MainDialog`. The backlog
  (persistent storage, rate limiting, extracting the inline `mainDialog.ts` cards) is in `plans/IMPROVEMENTS.md`.

## Git Workflow

- Do not use feature branches for code changes. Always stay on the current branch.
- New command/card: add a branch in `onMessageActivity()` / `case` in `handleCardAction()` returning
  updated `SudokuConversationData`; card builders live in `src/cards/` (Adaptive Card `version: '1.5'`);
  all user-facing strings go in `en.json`. Keep `solverService.ts` params in sync with sudojo_api.
- Local debug: start sudojo_api on `:3000`, `bun run dev`, then point the Bot Framework Emulator at
  `http://localhost:3978/api/messages` with App ID/password and `MICROSOFT_APP_*` left blank.

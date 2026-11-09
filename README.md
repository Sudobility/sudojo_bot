# sudojo_bot

Microsoft Bot Framework chatbot that helps users solve Sudoku puzzles through image recognition and step-by-step hints.

## Setup

The `@sudobility/*` dependencies live on GitHub Packages (see `.npmrc`), so `bun install`
needs a GitHub token with `read:packages`. Add it to `~/.npmrc` before installing:
`//npm.pkg.github.com/:_authToken=<token>`.

```bash
bun install
cp .env.example .env
# Configure MICROSOFT_APP_ID, MICROSOFT_APP_PASSWORD, MICROSOFT_APP_TENANT_ID,
# and SOLVER_API_URL (base URL of sudojo_api, default http://localhost:3000)
bun run dev          # Start with hot reload (port 3978)
```

## Features

- Upload a photo of any Sudoku puzzle
- Automatic OCR extraction server-side via sudojo_api (digits and pencilmarks)
- Puzzle validation (unique solution check)
- Step-by-step hints teaching solving techniques
- Visual board rendering with highlighted cells
- Multi-platform: Teams, Web Chat, Slack, Telegram, and more

## Usage

1. Download [Bot Framework Emulator](https://github.com/Microsoft/BotFramework-Emulator/releases)
2. Start sudojo_api (the bot calls its `/api/v1/solver/*` and `/api/v1/ocr/extract` endpoints), then
   the bot: `bun run dev`
3. Connect to `http://localhost:3978/api/messages` (leave App ID/password blank)

## Routes

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/messages` | POST | Bot Framework messaging |
| `/health` | GET | Health check |

## Development

```bash
bun run dev          # Start with hot reload
bun run build        # TypeScript compilation
bun run typecheck    # Type checking
bun run lint         # ESLint
bun run format       # Prettier (writes src/)
bun run test:unit    # All tests (fast, offline) — same as `bun test`
```

## Docker

```bash
docker build -t sudojo_bot .
docker run -p 3978:3978 --env-file .env sudojo_bot
```

## Related Packages

- `@sudobility/sudojo_client` -- API client used for OCR extraction (`/api/v1/ocr/extract`)
- `@sudobility/sudojo_types` -- Solver types for hint data
- `sudojo_api` -- Backend whose `/api/v1/solver/*` endpoints (proxied to `sudojo_solver`) provide hints and validation, and whose `/api/v1/ocr/extract` endpoint reads boards from photos

## License

BUSL-1.1

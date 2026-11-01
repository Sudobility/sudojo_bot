# Deployment Guide

This document provides detailed instructions for deploying Sudojo Bot to various chat platforms.

## Table of Contents

- [Prerequisites](#prerequisites)
- [Docker Deployment](#docker-deployment)
- [Platform-Specific Setup](#platform-specific-setup)
  - [How Bot Framework channels work](#how-bot-framework-channels-work)
  - [SingleTenant vs MultiTenant](#singletenant-vs-multitenant)
  - [Channel capability matrix](#channel-capability-matrix)
  - [Microsoft Teams](#microsoft-teams)
  - [Azure Web Chat](#azure-web-chat)
  - [Slack](#slack)
  - [Facebook Messenger](#facebook-messenger)
  - [Telegram](#telegram)
  - [Email (Microsoft 365)](#email-microsoft-365)
  - [Twilio (SMS / MMS)](#twilio-sms--mms)
  - [LINE](#line)
  - [GroupMe](#groupme)
  - [Direct Line (Custom Apps)](#direct-line-custom-apps)
- [Production Deployment with Traefik](#production-deployment-with-traefik)
- [Environment Variables Reference](#environment-variables-reference)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

Before deploying, ensure you have:

1. **Azure Account** - For Bot Framework registration
2. **Docker** - For containerized deployment
3. **Domain with SSL** - Required for most chat platforms
4. **Solver API** - Running instance of sudojo_api (its `/api/v1/solver/*` endpoints proxy to sudojo_solver)

### Required Tools

```bash
# Check Docker
docker --version  # v20.10+

# Check Docker Compose
docker compose version  # v2.0+

# For local development
bun --version  # v1.0+
```

---

## Docker Deployment

### Build the Image

```bash
# From the project root
docker build -t sudojo_bot:latest .

# Or with a specific tag
docker build -t sudojo_bot:v1.0.0 .
```

### Run Locally

```bash
# Create .env file from example
cp .env.example .env
# Edit .env with your credentials

# Run the container
docker run -d \
  --name sudojo_bot \
  -p 3978:3978 \
  --env-file .env \
  sudojo_bot:latest

# Check logs
docker logs -f sudojo_bot

# Test health endpoint
curl http://localhost:3978/health
```

### Push to Registry

CI does this automatically: a push to `main` with a new `package.json` version publishes
`$DOCKERHUB_USERNAME/sudojo_bot:<version>` and `:latest` (see `.github/workflows/ci-cd.yml`).
Manual push:

```bash
# Tag for your registry
docker tag sudojo_bot:latest docker.io/yourusername/sudojo_bot:latest

# Push
docker push docker.io/yourusername/sudojo_bot:latest
```

---

## Platform-Specific Setup

### How Bot Framework channels work

You deploy **one** bot, with **one** messaging endpoint:

```
https://bot.sudojo.com/api/messages
```

You do **not** deploy a separate copy per platform. Azure Bot Service sits in the middle and
fans out to every platform you enable:

```
                              ┌───────────────────────────── Microsoft Teams
   Facebook / Telegram /      │
   Slack / LINE / SMS user    │   each platform talks to Azure's
            │                 │   channel connector, e.g.
            ▼                 │     facebook.botframework.com
   platform's own servers ────┤     telegram.botframework.com
            │                 │     slack.botframework.com
            ▼                 │
   Azure Bot Service  ────────┤   Azure then calls YOUR single endpoint:
   (Channels blade)           └──► https://bot.sudojo.com/api/messages ──► container
```

What this means in practice:

1. **Your server only ever exposes `https://bot.sudojo.com/api/messages`.** Traefik routes it to
   the container (see [Production Deployment with Traefik](#production-deployment-with-traefik)).
   You never open a port or webhook per platform.
2. **Each platform's webhook points at a Microsoft URL** (e.g. `https://facebook.botframework.com/...`),
   **not** at `bot.sudojo.com`. Azure hands you that URL in the channel's config blade.
3. **To add a platform you do two things:** (a) register an app/bot on that platform and copy its
   credentials, (b) paste those credentials into **Azure Portal → your Bot → Channels → [platform]**.
4. **`MICROSOFT_APP_TYPE` matters for reach.** A `SingleTenant` app only authenticates against your
   own Azure AD tenant — fine for Teams inside your org, but public channels (Facebook, Telegram,
   Slack, web) generally need a **`MultiTenant`** app registration. If you intend to serve the public
   internet, create the Azure Bot with a MultiTenant app ID (and leave `MICROSOFT_APP_TENANT_ID`
   unset / `common`) rather than SingleTenant.

So the prerequisite for every section below is the same: the **[Azure Bot registration](#step-1-create-azure-bot-registration)**
and a **running deployment at `https://bot.sudojo.com/api/messages`**. Do that once, then enable
channels.

### SingleTenant vs MultiTenant

`MICROSOFT_APP_TYPE` controls **which Azure AD directories Microsoft will issue auth tokens for**
when Azure Bot Service talks to your container (and when your bot calls back out, e.g. to download a
Teams image). It must match the **Supported account types** on the app registration itself — the env
var alone is not enough.

| | `SingleTenant` | `MultiTenant` |
|---|---|---|
| Valid in | **one** tenant (yours) | **any** Azure AD tenant |
| Token authority | `login.microsoftonline.com/<tenant-id>` | `login.microsoftonline.com/botframework.com` |
| `MICROSOFT_APP_TENANT_ID` | **required** | **not used** (omit it) |
| Use for | an in-org Teams bot | **public channels** (Facebook, Telegram, Slack, public Web Chat) |

Public channels route through Microsoft's shared `botframework.com` tenant, so a public bot needs
**MultiTenant**. **Neither type costs anything** — tenancy has no effect on
[Azure Bot Service pricing](https://azure.microsoft.com/pricing/details/bot-services/) (billed by
channel + message volume; Standard channels like Teams/Facebook/Telegram/Slack are free, only
Direct Line / Web Chat have a paid quota). App registrations are always free.

> **Mismatch = silent auth failure.** If the app registration is SingleTenant but the env says
> MultiTenant (or vice-versa), the token request fails and the bot returns 401s / "not responding."

#### Switching an existing bot to MultiTenant

1. In `.env` (and Doppler) set `MICROSOFT_APP_TYPE=MultiTenant` and **remove** `MICROSOFT_APP_TENANT_ID`.
2. **Entra ID → App registrations →** open your app (the `MICROSOFT_APP_ID`).
3. **Authentication → Supported account types →** select **"Accounts in any organizational directory
   (Any Microsoft Entra ID tenant — Multitenant)"** → **Save**.
4. Confirm **Azure Bot → Configuration** still points its messaging endpoint at
   `https://bot.sudojo.com/api/messages`, then redeploy / restart the container so it picks up the
   new env.

**Fallback if step 3 is greyed out or errors** (can happen depending on how the app was created):
create a **new** MultiTenant app registration → add a new **client secret** → point the Azure Bot at
the new App ID → update `MICROSOFT_APP_ID` and `MICROSOFT_APP_PASSWORD` in Doppler. (Keeping the same
app registration is the only way to keep the same secret.)

### Channel capability matrix

This bot is **image-first and button-driven**: the user uploads a photo, and the bot replies with
Adaptive Cards that embed a rendered PNG board plus `Action.Submit` buttons (`Get Hint`, `Next`,
`Apply`, `New Puzzle`, …). Channels render Adaptive Cards with very different fidelity — Microsoft's
[Channels reference](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-channels-reference)
spells out that cards may be **down-rendered to a static image or to plain text**, and that a channel
"might not display the card if the card contains inputs or buttons."

| Channel | User can send a photo? | Adaptive Cards + buttons? | Experience |
|---------|------------------------|---------------------------|------------|
| **Microsoft Teams** | ✅ (file upload) | ✅ Full | **Best** — the primary target |
| **Web Chat / Direct Line** | ✅ | ✅ Full | **Best** — full card + button fidelity |
| **Slack** | ✅ | ⚠️ Card rendered **as an image**; buttons degrade | Usable; prefer text commands |
| **Facebook Messenger** | ✅ | ⚠️ Partial / down-rendered | Usable; prefer text commands |
| **Telegram** | ✅ | ⚠️ "Image, partial" — buttons may not render | Usable; prefer text commands |
| **LINE** | ✅ | ⚠️ Partial | Usable; prefer text commands |
| **Email (M365)** | ✅ (attachment) | ⚠️ Down-rendered | Degraded, high latency |
| **Twilio (SMS/MMS)** | ✅ MMS only | ❌ No cards | Text + image only |

**The good news:** the bot accepts **text commands for every action except "previous step"**, so it
still works on channels where buttons don't render. On a degraded channel, tell users they can type:

| Type this | Does |
|-----------|------|
| *(send a photo)* | upload a puzzle |
| `hint` | get / show the current hint step |
| `next` | next step |
| `apply` | apply the current hint |
| `status` | show progress |
| `new` | start over |
| `help` | show help |

> Always **test every card your bot sends on each channel before launch** — Microsoft's own advice.
> Buttons that work in Teams/Web Chat may silently drop on Telegram or Facebook.

---

### Microsoft Teams

Microsoft Teams is the primary deployment target and offers the richest experience.

#### Step 1: Create Azure Bot Registration

1. Go to [Azure Portal](https://portal.azure.com)
2. Create a new resource → Search "Azure Bot"
3. Fill in details:
   - **Bot handle**: `sudojo-bot` (globally unique)
   - **Subscription**: Your Azure subscription
   - **Resource group**: Create new or use existing
   - **Pricing tier**: F0 (Free) for testing, S1 for production
   - **Microsoft App ID**: Create new
4. Click **Create**

#### Step 2: Configure Bot Settings

1. Go to your Bot resource → **Configuration**
2. Note the **Microsoft App ID**
3. Click **Manage** next to Microsoft App ID
4. Go to **Certificates & secrets** → **New client secret**
5. Copy the secret value immediately (shown only once)
6. Back in Bot Configuration, set **Messaging endpoint**:
   ```
   https://bot.sudojo.com/api/messages
   ```

#### Step 3: Enable Teams Channel

1. In your Bot resource → **Channels**
2. Click **Microsoft Teams**
3. Accept terms of service
4. Click **Apply**

#### Step 4: Deploy the Bot

Update your `.env`:

```bash
MICROSOFT_APP_ID=your-app-id-from-azure
MICROSOFT_APP_PASSWORD=your-client-secret
MICROSOFT_APP_TYPE=SingleTenant
MICROSOFT_APP_TENANT_ID=your-azure-ad-tenant-id
SOLVER_API_URL=https://api.sudojo.com   # sudojo_api base URL
PORT=3978
```

Deploy using the production deployment method below.

#### Step 5: Install in Teams

**For Development/Testing:**
1. In Azure Bot → Channels → Teams → Click "Open in Teams"
2. Add the bot to your personal chat or a team

**For Organization-Wide Deployment:**
1. Create a Teams App Package (manifest.json + icons)
2. Upload to Teams Admin Center
3. Approve for your organization

#### Teams App Manifest Example

Create `manifest.json`:

```json
{
  "$schema": "https://developer.microsoft.com/json-schemas/teams/v1.16/MicrosoftTeams.schema.json",
  "manifestVersion": "1.16",
  "version": "1.0.0",
  "id": "YOUR-APP-ID-GUID",
  "packageName": "com.sudojo.bot",
  "developer": {
    "name": "Your Company",
    "websiteUrl": "https://sudojo.com",
    "privacyUrl": "https://sudojo.com/privacy",
    "termsOfUseUrl": "https://sudojo.com/terms"
  },
  "name": {
    "short": "Sudojo Bot",
    "full": "Sudojo Sudoku Hint Bot"
  },
  "description": {
    "short": "Get hints for your Sudoku puzzles",
    "full": "Upload a photo of your Sudoku puzzle and get step-by-step hints to help you solve it."
  },
  "icons": {
    "color": "color.png",
    "outline": "outline.png"
  },
  "accentColor": "#5C6BC0",
  "bots": [
    {
      "botId": "YOUR-MICROSOFT-APP-ID",
      "scopes": ["personal", "team", "groupchat"],
      "supportsFiles": true,
      "isNotificationOnly": false
    }
  ],
  "permissions": ["identity", "messageTeamMembers"],
  "validDomains": ["bot.sudojo.com"]
}
```

---

### Azure Web Chat

Web Chat allows embedding the bot in any website.

#### Step 1: Get Direct Line Secret

1. In Azure Bot → **Channels**
2. Click **Direct Line**
3. Click **Show** to reveal the secret key
4. Copy one of the secret keys

#### Step 2: Embed in Website

```html
<!DOCTYPE html>
<html>
<head>
  <title>Sudojo Bot</title>
  <script src="https://cdn.botframework.com/botframework-webchat/latest/webchat.js"></script>
  <style>
    #webchat {
      height: 600px;
      width: 400px;
    }
  </style>
</head>
<body>
  <div id="webchat" role="main"></div>
  <script>
    window.WebChat.renderWebChat({
      directLine: window.WebChat.createDirectLine({
        secret: 'YOUR_DIRECT_LINE_SECRET'
      }),
      userID: 'user-' + Math.random().toString(36).substr(2, 9),
      username: 'Web User',
      locale: 'en-US'
    }, document.getElementById('webchat'));
  </script>
</body>
</html>
```

#### Security Note

For production, use token exchange instead of embedding the secret:

```javascript
// Backend endpoint to exchange secret for token
const response = await fetch('https://directline.botframework.com/v3/directline/tokens/generate', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${DIRECT_LINE_SECRET}`
  }
});
const { token } = await response.json();
// Use token instead of secret in frontend
```

---

### Slack

#### Step 1: Create Slack App

1. Go to [Slack API](https://api.slack.com/apps)
2. Click **Create New App** → **From scratch**
3. Name: `Sudojo Bot`, Workspace: Your workspace

#### Step 2: Configure Bot

1. **OAuth & Permissions** → Add scopes:
   - `chat:write`
   - `files:read`
   - `im:history`
   - `im:read`
   - `im:write`
2. **Install to Workspace** → Copy **Bot User OAuth Token**

#### Step 3: Enable in Azure Bot

1. Azure Bot → **Channels** → **Slack**
2. Enter:
   - Client ID (from Slack Basic Information)
   - Client Secret
   - Verification Token
3. Copy the **Redirect URL** to Slack OAuth settings
4. Click **Save**

#### Step 4: Event Subscriptions

1. In Slack App → **Event Subscriptions** → Enable
2. Request URL: `https://slack.botframework.com/api/Events/{BOT-HANDLE}`
3. Subscribe to bot events:
   - `message.im`
   - `file_shared`

---

### Facebook Messenger

#### Step 1: Create Facebook App

1. Go to [Facebook Developers](https://developers.facebook.com)
2. Create App → Select **Business** type
3. Add **Messenger** product

#### Step 2: Create Facebook Page

1. Create a Facebook Page for your bot (if not existing)
2. In Messenger Settings → Generate **Page Access Token**

#### Step 3: Configure Azure Bot

1. Azure Bot → **Channels** → **Facebook Messenger**
2. Enter:
   - Facebook App ID
   - Facebook App Secret
   - Page Access Token
3. Copy the **Callback URL** and **Verify Token**

#### Step 4: Webhook Setup

1. In Facebook App → Messenger → Webhooks
2. Edit Callback URL subscription
3. Paste Callback URL and Verify Token from Azure
4. Subscribe to: `messages`, `messaging_postbacks`

#### Step 5: App Review

For public use, submit for Facebook App Review:
- `pages_messaging` permission required

---

### Telegram

#### Step 1: Create Telegram Bot

1. Message [@BotFather](https://t.me/botfather) on Telegram
2. Send `/newbot`
3. Follow prompts to name your bot
4. Copy the **API Token**

#### Step 2: Configure Azure Bot

1. Azure Bot → **Channels** → **Telegram**
2. Enter the API Token from BotFather
3. Click **Save**

#### Step 3: Test

Search for your bot on Telegram and start chatting.

#### Note on File Uploads

Telegram has a 20MB file size limit. Ensure puzzle images are optimized.

Telegram down-renders Adaptive Cards ("image, partial") and **may drop the inline buttons**. Tell
users they can drive the bot with the text commands in the
[capability matrix](#channel-capability-matrix) (`hint`, `next`, `apply`, `status`, `new`).

---

### Email (Microsoft 365)

Lets users interact with the bot over email. Rich cards are heavily down-rendered and round-trips are
slow, so this is a fallback channel — expect the text-command experience.

1. Have a dedicated **Microsoft 365 mailbox** for the bot (e.g. `sudojo-bot@yourtenant.com`).
2. Azure Bot → **Channels** → **Email (Office 365)**.
3. Enter the mailbox address and authenticate (modern auth / the mailbox credentials, per the blade).
4. Click **Apply**. Users email the mailbox; attachments (puzzle photos) arrive as image attachments.

See [Connect a bot to Email](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-channel-connect-email).

---

### Twilio (SMS / MMS)

Text + picture messaging. **No Adaptive Cards** — the bot's cards collapse to text, and the board
image only shows where **MMS** is supported. Users send a puzzle photo as an MMS and drive the bot
entirely with text commands.

#### Step 1: Twilio setup

1. Create a [Twilio](https://www.twilio.com) account and buy / provision an **MMS-capable** number.
2. From the Twilio console, note the **Account SID** and **Auth Token**.

#### Step 2: Configure Azure Bot

1. Azure Bot → **Channels** → **Twilio SMS**.
2. Enter the **Phone Number**, **Account SID**, and **Auth Token**.
3. Copy the Bot Framework **messaging endpoint** that Azure shows and set it as the webhook on your
   Twilio number's Messaging configuration.
4. Click **Apply**.

See [Connect a bot to Twilio](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-channel-connect-twilio).

> MMS size and region rules vary by carrier; keep puzzle images small. Where only SMS (no MMS) is
> available, users cannot send a photo and the bot can't receive a puzzle.

---

### LINE

Popular in Japan / Taiwan / Thailand. Supports image upload; Adaptive Cards are partially rendered,
so prefer text commands for actions.

#### Step 1: LINE Developers setup

1. In the [LINE Developers Console](https://developers.line.biz), create a **Provider** and a
   **Messaging API channel**.
2. Note the **Channel secret** and issue a **Channel access token**.

#### Step 2: Configure Azure Bot

1. Azure Bot → **Channels** → **LINE**.
2. Enter the **Channel secret** and **Channel access token**.
3. Copy the **Webhook URL** Azure provides and paste it into the LINE channel's **Webhook settings**;
   enable "Use webhook".
4. Click **Apply**.

See [Connect a bot to LINE](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-channel-connect-line).

---

### GroupMe

Group-chat platform. Image upload works; cards are down-rendered.

1. Register an application in the [GroupMe developer portal](https://dev.groupme.com) and create a bot.
2. Azure Bot → **Channels** → **GroupMe**.
3. Enter the GroupMe app's **Client ID** / **access token** as prompted, and copy Azure's callback
   URL back into the GroupMe app's **Callback URL**.
4. Click **Apply**.

See [Connect a bot to GroupMe](https://learn.microsoft.com/en-us/azure/bot-service/bot-service-channel-connect-groupme).

---

### Deprecated / unavailable channels

Microsoft has **retired new-bot support for Skype, Kik, and Cortana**, and Microsoft Teams is now a
separate product surface (covered above). Don't plan new deployments on those. For anything not
listed here (a custom mobile/web app, WhatsApp via a partner, kiosks, etc.), use
[Direct Line](#direct-line-custom-apps).

---

### Direct Line (Custom Apps)

Direct Line allows integration with any custom application.

#### Step 1: Enable Direct Line

1. Azure Bot → **Channels** → **Direct Line**
2. Configure site (e.g., "Production")
3. Copy secret key

#### Step 2: Use Direct Line SDK

```typescript
import { DirectLine } from 'botframework-directlinejs';

const directLine = new DirectLine({
  secret: 'YOUR_DIRECT_LINE_SECRET'
  // Or use token for client-side apps
});

// Send message
directLine.postActivity({
  from: { id: 'user1', name: 'User' },
  type: 'message',
  text: 'Hello'
}).subscribe(
  id => console.log('Posted activity, id:', id),
  error => console.error('Error posting activity', error)
);

// Receive messages
directLine.activity$
  .filter(activity => activity.type === 'message')
  .subscribe(message => console.log('Received:', message));
```

#### Direct Line App Service Extension

For high-scale deployments, use Direct Line App Service Extension:

1. Azure Bot → Configuration → Enable Direct Line App Service Extension
2. Point to your App Service
3. Reduces latency by 2-3x

---

## Production Deployment with Traefik

This deployment method is compatible with `sudobility_dockerized` scripts.

### Step 1: Setup Doppler (Secrets Management)

1. Create project in [Doppler](https://doppler.com)
2. Add secrets:
   ```
   PORT=3978
   MICROSOFT_APP_ID=your-app-id
   MICROSOFT_APP_PASSWORD=your-secret
   MICROSOFT_APP_TYPE=MultiTenant
   SOLVER_API_URL=https://api.sudojo.com
   ```
   > Use `MultiTenant` for a public bot (Facebook, Telegram, Slack, public Web Chat) and **omit**
   > `MICROSOFT_APP_TENANT_ID`. Use `SingleTenant` **plus** `MICROSOFT_APP_TENANT_ID=<your-tenant-id>`
   > only for an in-org Teams bot. This must match the app registration's **Supported account types**
   > in Azure AD — see [How Bot Framework channels work](#how-bot-framework-channels-work).
3. Generate Service Token for production environment

### Step 2: Deploy Service

From the `sudobility_dockerized` directory on your server:

```bash
cd ~/shapeshyft/sudobility_dockerized
./add.sh
```

When prompted:
- **Service name**: `sudojo_bot`
- **Hostname**: `bot.sudojo.com` (your domain)
- **Docker image**: `docker.io/johnqh/sudojo_bot:latest`
- **Health endpoint**: Select "1" for `/health`
- **Doppler token**: Paste your service token

### Step 3: Verify Deployment

```bash
# Check status
./status.sh

# View logs
cd config-generated/services/sudojo_bot
docker compose logs -f

# Test endpoint
curl https://bot.sudojo.com/health
```

### Step 4: Update Azure Bot Messaging Endpoint

In Azure Portal → Bot → Configuration:
```
Messaging endpoint: https://bot.sudojo.com/api/messages
```

### Upgrading

```bash
cd ~/shapeshyft/sudobility_dockerized
./upgrade.sh
# Select sudojo_bot when prompted
```

### Directory Structure After Deployment

The `sudobility_dockerized` scripts manage all services centrally:

```
sudobility_dockerized/
├── add.sh
├── upgrade.sh
├── remove.sh
├── status.sh
├── versions.sh
├── setup-scripts/
│   ├── common.sh
│   ├── traefik.sh
│   └── doppler.sh
└── config-generated/
    ├── traefik/
    │   └── docker-compose.yml
    ├── services/
    │   └── sudojo_bot/
    │       ├── docker-compose.yml
    │       ├── .env
    │       └── .service.conf
    └── .doppler-tokens/
        └── sudojo_bot
```

---

## Environment Variables Reference

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | `3978` | HTTP server port |
| `MICROSOFT_APP_ID` | Yes | - | Azure Bot app ID |
| `MICROSOFT_APP_PASSWORD` | Yes | - | Azure Bot client secret |
| `MICROSOFT_APP_TYPE` | No | `SingleTenant` | Auth type: `SingleTenant`, `MultiTenant`, or `UserAssignedMSI` |
| `MICROSOFT_APP_TENANT_ID` | For `SingleTenant` | - | Azure AD tenant ID |
| `SOLVER_API_URL` | Yes (in production) | `http://localhost:3000` | Base URL of **sudojo_api**; the bot calls `/api/v1/solver/solve` and `/api/v1/solver/validate`. Pointing it straight at sudojo_solver gives 404s |
| `NODE_ENV` | No | `production` (set in Dockerfile) | Not read by the bot code |

---

## Troubleshooting

### Bot Not Responding

1. **Check container status**:
   ```bash
   docker ps -a | grep sudojo_bot
   docker logs sudojo_bot
   ```

2. **Verify health endpoint**:
   ```bash
   curl -v https://bot.sudojo.com/health
   ```

3. **Check Azure Bot Configuration**:
   - Messaging endpoint matches your deployment URL
   - App ID and Password are correct

### Teams: "Unable to reach app"

1. Verify SSL certificate is valid
2. Check messaging endpoint in Azure Bot Configuration
3. Ensure Traefik is routing correctly:
   ```bash
   docker logs traefik 2>&1 | grep sudojo
   ```

### Images Not Processing

1. **Check OCR logs**:
   ```bash
   docker logs sudojo_bot 2>&1 | grep -i ocr
   ```

2. **Verify solver connectivity**:
   ```bash
   docker exec sudojo_bot curl -v $SOLVER_API_URL/health
   ```

3. **Teams image download issues**:
   - Ensure `MICROSOFT_APP_ID` and `MICROSOFT_APP_PASSWORD` are set
   - Check Teams channel is enabled in Azure Bot
   - Inline images are fetched with the bot's connector token (from the CloudAdapter `ConnectorClient`), so a 401 means the app ID/password or tenant is wrong. File uploads need `supportsFiles: true` in the manifest and are fetched from their pre-authenticated `downloadUrl`

### SSL Certificate Issues

1. **Check Traefik logs**:
   ```bash
   docker logs traefik 2>&1 | grep -i acme
   ```

2. **Verify DNS**:
   ```bash
   dig +short bot.sudojo.com
   ```

3. **Force certificate renewal**:
   ```bash
   docker exec traefik rm /data/acme.json
   docker restart traefik
   ```

### High Memory Usage

OCR runs server-side in sudojo_api (`POST /api/v1/ocr/extract`), so the container bundles no OCR
engine or model file and only needs network access to `SOLVER_API_URL`. Board rendering
(`@napi-rs/canvas`) is the remaining memory consumer. If memory is constrained:

1. Add memory limits to docker-compose.yml:
   ```yaml
   deploy:
     resources:
       limits:
         memory: 512M
   ```

---

## Support

- **Issues**: [GitHub Issues](https://github.com/johnqh/sudojo_bot/issues)
- **Documentation**: [Sudojo Docs](https://docs.sudojo.com)
- **Bot Framework**: [Microsoft Docs](https://docs.microsoft.com/en-us/azure/bot-service/)

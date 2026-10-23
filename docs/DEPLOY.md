# Deploy and connect to Instagram: the complete guide

This is the one document to follow from "nothing" to "the assistant answers my Instagram DMs". It links to the detailed pages where needed. Allow about 2 to 3 hours for the first setup, plus about a week of practice mode before you switch it on for real.

## What you will have at the end

- A small server in the EU running the assistant (n8n) with automatic HTTPS.
- Your Instagram shop account connected to it through Meta's official API.
- A **dashboard** at `https://n8n.<your-domain>/webhook/admin?key=<your key>` where you switch the assistant On / Practice / Off, see who needs you, hand chats back, and edit the shop info.

## What you need before starting

| Item | Notes | Cost (approx.) |
|---|---|---|
| Instagram account of the shop | Must be switched to a **Business** (professional) account | free |
| Facebook login | Needed only to open developers.facebook.com | free |
| A domain name | For example `myshop.fi`. You only need a subdomain such as `n8n.myshop.fi` | 10 to 15 EUR / year |
| A small server (VPS) in the EU | 2 GB RAM is enough. Hetzner CX22, or similar | 4 to 6 EUR / month |
| Anthropic API key | https://console.anthropic.com, add a few euros of credit | a few EUR / month at small-shop volume |
| Telegram | A bot for your alerts (steps below) | free |

Not supported: n8n Cloud, because the assistant reads and writes `knowledge/shop.md` as a file on the server.

## Step 1: Fill in the shop info (10 minutes, no server needed)

Open `knowledge/shop.md` and fill in every section: name, address, opening hours, products with prices, delivery, returns, FAQ, and "Always hand off". The assistant answers **only** from this text, so anything missing means "I'll ask the team". You can edit it later from the dashboard.

Also edit `prompts/system.md`, section CANNED MESSAGES: set `shop_name` and check the Finnish and Persian lines.

## Step 2: Get a Telegram bot for alerts (5 minutes)

1. In Telegram open **@BotFather**, send `/newbot`, follow the questions. Copy the **bot token**.
2. Open a chat with your new bot and press **Start**.
3. Open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser. Find `"chat":{"id": 123456789`. That number is `TELEGRAM_CHAT_ID`.

## Step 3: Server and domain (30 minutes)

1. Rent a VPS in the EU (Ubuntu 24.04). Note its IP address. Add your SSH key when asked.
2. At your domain registrar add a DNS record: **A**, name `n8n`, value = the server's IP. Wait a few minutes.
3. Connect and install Docker:
   ```
   ssh root@<server-ip>
   curl -fsSL https://get.docker.com | sh
   ```
4. Open the firewall for web traffic only (in the VPS provider panel, or `ufw allow 22,80,443/tcp && ufw enable`).

## Step 4: Put the project on the server (10 minutes)

```
apt install -y git
git clone <your repository url> instagram-dm-bot
cd instagram-dm-bot
cp .env.example .env
nano .env
```

Fill in `.env`:

| Setting | Value |
|---|---|
| `N8N_HOST` | `n8n.<your-domain>` |
| `WEBHOOK_URL` | `https://n8n.<your-domain>/` |
| `N8N_ENCRYPTION_KEY` | output of `openssl rand -hex 32` (keep a copy, you cannot recover data without it) |
| `IG_VERIFY_TOKEN` | output of `openssl rand -hex 16` |
| `ADMIN_KEY` | output of `openssl rand -hex 16`. This is your dashboard password |
| `ANTHROPIC_API_KEY` | from console.anthropic.com |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | from Step 2 |
| `BOT_MODE` | leave `shadow` |

Leave `IG_ACCOUNT_ID` and `IG_APP_SECRET` empty for now; you fill them in Step 6. Leave `ANTHROPIC_API_BASE` and `TELEGRAM_API_BASE` empty.

Make the knowledge folder writable for n8n (so the dashboard can save), then start:

```
chmod -R a+rwX knowledge
docker compose up -d
docker compose logs -f caddy      # wait for "certificate obtained", then Ctrl+C
```

Open `https://n8n.<your-domain>`. You should see n8n with a valid padlock. Create the owner account with a **strong password**. Anyone who can log in here can read your Instagram token.

## Step 5: Create the tables and import the workflows (15 minutes)

1. In n8n: **Data tables > Create**. Make the four tables exactly as listed in README.md under "Create the Data Tables" (`igdm_processed_messages`, `igdm_conversations`, `igdm_messages`, `igdm_config`).
2. Import and activate the workflows:
   ```
   docker compose exec n8n n8n import:workflow --separate --input=/data/workflows
   for id in igdmWf3ErrorAlert igdmWf1Webhook01 igdmWf2TokenRefr1 igdmWf4Retention01 igdmWf5Admin01; do
     docker compose exec n8n n8n publish:workflow --id=$id
   done
   docker compose restart n8n
   ```
3. Check: open `https://n8n.<your-domain>/webhook/admin?key=<ADMIN_KEY>`. You should see the dashboard. (The Instagram connection will say "Unknown" until Step 6.)

## Step 6: Connect Instagram (30 to 60 minutes, by hand)

Follow **`docs/meta-setup.md`** click by click. In short:

1. Instagram app: switch to a Business account and allow access to messages.
2. developers.facebook.com: create a **Business** app, add the **Instagram** product, "API setup with Instagram login".
3. Generate the access token for your shop account (permissions `instagram_business_basic` and `instagram_business_manage_messages`).
4. In n8n **igdm_config** add two rows: `ig_access_token` (the token) and `ig_token_expires_at` (60 days from now, ISO format).
5. Get your account id with the `curl .../me?fields=user_id,username` command, put it in `.env` as `IG_ACCOUNT_ID`, and put the app secret in `IG_APP_SECRET` (and the second candidate in `IG_APP_SECRET_ALT`, see meta-setup section 5). Then `docker compose up -d`.
6. In the Meta dashboard set the webhook callback to `https://n8n.<your-domain>/webhook/ig` with your `IG_VERIFY_TOKEN`, subscribe to **messages**, then run `scripts/subscribe.sh <TOKEN>`.
7. Add a privacy policy URL and an app icon to the Meta app, then switch the app to **Live**.
8. From another Instagram account, send your shop a DM. In n8n **Executions** a WF1 run must appear, and in Practice mode the draft reply arrives on Telegram.

If a DM from an account with no role on the app does **not** trigger a run, Meta requires App Review for your app; see "Phase 2b" in `instagram-dm-bot-plan.md`.

## Step 7: Practice week

The assistant starts in **Practice** mode: it writes drafts to Telegram but sends **nothing** to customers.

1. Read the `[SHADOW]` drafts on Telegram for about a week. Wrong or missing answer? Fix the text in the dashboard's "Shop info" box.
2. Run the checks in README.md "Testing" with a second account (hours, price, price of an unknown product, "human", a photo).
3. When two days in a row have no wrong drafts, open the dashboard and press **On: reply to customers**.

## Using the dashboard every day

Bookmark `https://n8n.<your-domain>/webhook/admin?key=<ADMIN_KEY>` on your phone.

| You see | What to do |
|---|---|
| **What should the assistant do?** | Tap On, Practice or Off. Off is the emergency stop. |
| **Instagram connection** | Green is fine. Amber or red: renew the token (meta-setup.md, step 5). |
| **Needs you** | A customer asked for a person or the assistant was unsure. Tap **Reply in Instagram**, answer from the Instagram app. The assistant stays quiet for that customer for 12 hours. Tap **Done: hand back to assistant** to let it resume sooner. |
| **Shop info** | Edit hours, prices, etc. and press **Save**. Effective on the next message. |

When you reply from the Instagram app yourself, the assistant notices and goes quiet for that customer automatically.

## Keeping it healthy

- **Backups:** copy the `n8n_data` folder daily (for example `tar czf backup-$(date +%F).tgz n8n_data knowledge .env` from cron, and download it). Keep `N8N_ENCRYPTION_KEY` somewhere safe.
- **Updates:** pin the n8n version in `docker-compose.yml` to the tested one (`docker.n8n.io/n8nio/n8n:2.43.8`), upgrade deliberately, and re-run the test messages afterwards.
- **Token:** renews itself weekly; Telegram warns you if fewer than 7 days remain.
- **Privacy:** put a short notice in your privacy policy that an automated system and an AI provider (Anthropic) process messages. Messages are deleted after 30 days.

## If something goes wrong

| Problem | Likely cause and fix |
|---|---|
| Page does not load | DNS not pointing at the server yet, or ports 80/443 closed. `docker compose logs caddy` |
| Meta says "callback verification failed" | WF1 not active, or `IG_VERIFY_TOKEN` differs from what you typed in Meta. Restart n8n after editing `.env` |
| DM arrives but nothing happens | Check n8n **Executions**. A run ending after "Verify Signature" means the wrong app secret: use the other one |
| Dashboard says "Wrong or missing key" | Open the full link including `?key=...`; `ADMIN_KEY` in `.env` must be 12+ characters |
| Dashboard Save fails | The `knowledge` folder is not writable for n8n: `chmod -R a+rwX knowledge` |
| Telegram alert "OAuth 190" | Instagram token expired or invalid. Generate a new one (meta-setup.md) and update `igdm_config` |
| Customers get nothing in On mode | Dashboard still says Practice or Off, or the customer's last message is older than 24 hours (Instagram does not allow replies then) |
| Something looks wrong and you are unsure | Tap **Off** in the dashboard, then look at Executions. |

## Trying it from your own PC first (optional)

You can test the whole flow without a server by running n8n locally and exposing it with a free tunnel (for example Cloudflare Tunnel). Use the tunnel's HTTPS address as `WEBHOOK_URL` and as the Meta callback. This is for testing only; a PC that sleeps misses customer messages.

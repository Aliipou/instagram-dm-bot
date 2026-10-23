# Meta / Instagram setup (click-by-click)

These steps are **manual**. Do them yourself in a browser and in the Instagram app. Nothing in this repo logs in to Meta or Instagram for you. Meta moves menus often; where a menu name below no longer matches, look for the closest one and keep the intent.

Checked against Meta docs on 2026-10-19: Graph API version `v26.0`; text messages are limited to **1,000 UTF-8 bytes**; the 24-hour messaging window; long-lived tokens last 60 days and can be refreshed once they are at least 24 hours old.

## Before you start

- Phase 1 is done: `https://n8n.<your domain>` loads with a valid certificate.
- The four Data Tables (`igdm_*`) exist and WF1 and WF3 are **active** (see README, "First-time setup"). Meta's webhook verification calls WF1, so it must answer first.
- `.env` has `IG_VERIFY_TOKEN` set to a random string (`openssl rand -hex 16`).

## 1. Instagram app

1. Switch the shop account to a professional account, type **Business**: Settings > Account type and tools > Switch to professional account.
2. Allow connected tools to access messages: Settings > Messages and story replies > Message controls > Connected tools > **Allow access to messages**. (Menu path may differ; VERIFY.)

## 2. Create the Meta app

3. Go to https://developers.facebook.com > My Apps > **Create App**. Choose app type **Business**.
4. In the app dashboard, add the **Instagram** product, then open Instagram > **API setup with Instagram login**.

## 3. Generate the access token

5. Under **Generate access tokens**, click **Add account**, log in with the shop account, and grant:
   - `instagram_business_basic`
   - `instagram_business_manage_messages`

   Click **Generate token**. Copy it. It is long-lived (60 days).
6. In n8n open **Data tables > igdm_config** and add two rows:

   | key | value |
   |---|---|
   | `ig_access_token` | the token |
   | `ig_token_expires_at` | now + 60 days as an ISO date, e.g. `2026-12-18T12:00:00.000Z` |

   Never paste the token into git, chat, or a screenshot.
7. Get the account ID and put `user_id` into `IG_ACCOUNT_ID` in `.env`:
   ```
   curl "https://graph.instagram.com/v26.0/me?fields=user_id,username&access_token=<TOKEN>"
   ```
   Restart n8n after editing `.env` (`docker compose up -d`).

## 4. Webhook

8. Under **Configure webhooks** set:
   - Callback URL: `https://n8n.<your domain>/webhook/ig`
   - Verify token: the value of `IG_VERIFY_TOKEN`

   Click **Verify and save**. Then subscribe to the **messages** field.
9. Subscribe the account itself:
   ```
   scripts/subscribe.sh <TOKEN>
   ```
   The reply should be `{"success":true}`.

## 5. Which app secret signs the webhooks (Phase 3)

Meta shows an Instagram app secret under *API setup with Instagram login* and a Meta app secret under *App settings > Basic*. Which one signs Instagram Login webhooks must be confirmed with a real delivery:

1. Put one in `IG_APP_SECRET` and the other in `IG_APP_SECRET_ALT`.
2. Send a real DM from a second account, open the WF1 execution, and read the `Verify Signature` node output: `matched` says `primary`, `alt`, or `none`.
3. Keep the matching one in `IG_APP_SECRET`, empty `IG_APP_SECRET_ALT`, restart n8n.

## 6. Go live

10. App settings > **Basic**: add a **Privacy Policy URL** (a simple page on the shop's site is enough, mention that an automated system and an AI provider process messages) and an **app icon**. Switch the app to **Live**. Webhooks are only delivered in Live mode.
11. From a **second Instagram account that has no role on the app**, DM the shop. A WF1 execution must appear in n8n.
    - It appears: Standard Access is enough. Save the payload from that execution as a fixture in `fixtures/` (replace ids with `__ACCOUNT_ID__`, `__MID__`, `__NOW_MS__`).
    - It does not appear: go to Phase 2b (Business Verification + App Review for Advanced Access on `instagram_business_manage_messages`). Reviewers want a screencast of a test user messaging the account and the app replying through the API.

## Token renewal

WF2 refreshes the token weekly. If it ever fails you get a Telegram alert; refresh by hand with `scripts/refresh-token.sh <TOKEN>` and update the `igdm_config` table. A token that has fully expired cannot be refreshed: generate a new one in step 5.

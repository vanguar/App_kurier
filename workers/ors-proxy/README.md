# ORS proxy for Kurier

The public PWA calls this Worker at `/optimize`. The Worker keeps the Basic Key private and
forwards a tightly validated, one-vehicle request to the current HeiGIT VROOM endpoint:
`https://api.heigit.org/vroom/v0`. It then asks ORS Directions for the exact road distance
along the optimized order. Tours are capped at 48 jobs so Base + jobs + Base stays within the
50-coordinate Directions limit.

## Deploy

From this directory:

```powershell
npx wrangler login
npx wrangler secret put ORS_API_KEY
npx wrangler deploy
```

Paste the **Basic Key** only when `wrangler secret put ORS_API_KEY` asks for it. Do not put it
in the root `.env`, GitHub Actions variables, application source, or a `VITE_*` variable.

After deploy, copy the resulting URL and append `/optimize`, for example:

```text
https://kurier-ors-proxy.<your-subdomain>.workers.dev/optimize
```

Set that public URL as the GitHub Actions repository variable `ORS_PROXY_URL`. The deploy
workflow exposes only this non-secret proxy URL to Vite as `VITE_ORS_PROXY_URL`.

## Local development

1. Copy `.dev.vars.example` to `.dev.vars` and put the Basic Key there.
2. Run `npx wrangler dev` in this directory.
3. In the repository root, create `.env.local`:

```env
VITE_ORS_PROXY_URL=http://localhost:8787/optimize
```

Both `.dev.vars` and `.env.local` are ignored by Git.

# Harbor Desk

Operations desk for Northline. Each workspace keeps its own cases, chat, and follow-ups.

## Run

```powershell
npm install
npm run dev
```

Open the URL Vite prints, usually `http://localhost:5173`.

## Inbound mail

```powershell
Invoke-RestMethod -Method Post -Uri http://localhost:5173/api/webhooks/inbound -Headers @{ "x-harbor-token" = "harbor-demo" } -ContentType "application/json" -Body '{"workspace":"northline","customer":"Maya Chen","subject":"Damaged tent","body":"The pole snapped in transit.","channel":"email"}'
```

`WEBHOOK_TOKEN` in `wrangler.jsonc` is the local demo token. For a deploy, set it with `npx wrangler secret put WEBHOOK_TOKEN`.

```powershell
npm run deploy
```

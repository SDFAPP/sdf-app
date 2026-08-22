# Studio Define Fitness — running this for real

This is a real Vite + React project (not a chat preview), so it can
actually reach your Supabase backend.

## Option A — StackBlitz (recommended, fastest)
1. Unzip this folder on your computer.
2. Go to https://stackblitz.com
3. Drag the unzipped folder straight onto the StackBlitz homepage —
   it'll detect it's a Vite project and start it automatically.
4. Wait for the preview pane to load, then try registering a client
   or coach account for real.

## Option B — CodeSandbox
1. Go to https://codesandbox.io
2. Click "Create" → "Import Project" (or the upload icon).
3. Upload this zip file directly.
4. It'll install dependencies and start the dev server automatically.

## Option C — run it locally
If you have Node.js installed:
```bash
npm install
npm run dev
```
Then open the local URL it prints (usually http://localhost:5173).

## Once it's running
Register a client account with a real email you can check, or a coach
account to test the approval-email flow end to end. This version can
actually reach Supabase, so this is the first real test of the whole
signup → login → training log flow.

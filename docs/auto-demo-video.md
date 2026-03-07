# Auto Demo Video Generator

Generate a demo video directly from a URL with Playwright autopilot.

## 1) Install browser runtime (first time only)

```bash
npx playwright install chromium
```

## 2) Record demo

```bash
npm run demo:record -- --url https://www.starkwall.com --minutes 2.5
```

Output is saved to `demo-videos/`.

## Useful options

- Watch run live:

```bash
npm run demo:record -- --url https://www.starkwall.com --minutes 2.5 --headed
```

- Custom output filename:

```bash
npm run demo:record -- --url https://www.starkwall.com --minutes 2.5 --out demo-videos/starkwall-full-demo.webm
```

import { chromium } from 'playwright';
import { mkdir, rename } from 'fs/promises';
import path from 'path';

function parseArgs(argv) {
  const out = {
    url: 'https://www.starkwall.com',
    minutes: 2.5,
    out: '',
    headless: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--url' && argv[i + 1]) out.url = String(argv[++i]);
    else if (arg === '--minutes' && argv[i + 1]) out.minutes = Number(argv[++i]);
    else if (arg === '--out' && argv[i + 1]) out.out = String(argv[++i]);
    else if (arg === '--headed') out.headless = false;
  }
  if (!Number.isFinite(out.minutes) || out.minutes <= 0) out.minutes = 2.5;
  return out;
}

function tsStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function clickByText(page, text, timeout = 1200) {
  try {
    const locator = page.getByRole('button', { name: text }).first();
    if (await locator.isVisible({ timeout })) {
      await locator.click({ timeout: 2000 });
      return true;
    }
  } catch {}
  return false;
}

async function closeAnyModal(page) {
  const closeLabels = ['Close', 'Cancel', 'Back'];
  for (const label of closeLabels) {
    if (await clickByText(page, label, 350)) {
      await sleep(450);
      return true;
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

async function runAutopilot(page, budgetMs) {
  const start = Date.now();
  const keepTime = () => Date.now() - start < budgetMs;

  await page.goto(page.url(), { waitUntil: 'domcontentloaded' }).catch(() => {});
  await sleep(1500);

  // Try wallet connect if available.
  if (await clickByText(page, '🎮 Connect Wallet', 1000)) {
    await sleep(4500);
  }

  const showcaseButtons = [
    'Add Post',
    'Add Paid Post',
    'Create Auction Post',
    '⇄ Send STRK',
    '⇄ Swap STRK/WBTC',
    '🧪 Verify Sealed Result',
    'Followers',
    'Following',
    '🔒 Stake',
    '✨ Claim',
  ];

  while (keepTime()) {
    let acted = false;
    for (const label of showcaseButtons) {
      if (!keepTime()) break;
      if (await clickByText(page, label, 450)) {
        acted = true;
        await sleep(1200);
        await closeAnyModal(page);
        await sleep(500);
      }
    }

    // Scroll a bit to reveal more UI and retry.
    await page.mouse.wheel(0, 700).catch(() => {});
    await sleep(800);
    await page.mouse.wheel(0, -500).catch(() => {});
    await sleep(600);
    if (!acted) await sleep(1200);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const outputDir = path.resolve(process.cwd(), 'demo-videos');
  await mkdir(outputDir, { recursive: true });

  const outputPath = args.out
    ? path.resolve(process.cwd(), args.out)
    : path.join(outputDir, `starkwall-demo-${tsStamp()}.webm`);

  const browser = await chromium.launch({ headless: args.headless });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: {
      dir: outputDir,
      size: { width: 1920, height: 1080 },
    },
  });
  const page = await context.newPage();
  const video = page.video();

  try {
    await page.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await runAutopilot(page, Math.floor(args.minutes * 60 * 1000));
  } finally {
    await context.close();
    await browser.close();
  }

  const recordedTmpPath = await video.path();
  await rename(recordedTmpPath, outputPath);

  console.log(`Demo video saved: ${outputPath}`);
  console.log('Tip: add --headed to watch the run live.');
}

main().catch((error) => {
  console.error('Demo recording failed:', error?.message || error);
  process.exit(1);
});

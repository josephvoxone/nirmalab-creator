// overlay-guard.mjs — keeps Flow's first-run dialogs from swallowing clicks.
//
// Flow opens Angular CDK modals (welcome tour, privacy notice, changelog) that put a
// `.cdk-overlay-backdrop-showing` over the composer. Playwright's click then fails with
// "subtree intercepts pointer events", which surfaced as a 30 s timeout on the first job after a
// profile was reset. The privacy dialog also keeps its Continue button disabled until the text is
// scrolled to the end, so this scrolls first and clicks second.
//
// Runs in the background next to the bridge (entry.sh), every 20 s, best effort: any error is
// swallowed so it can never take the container down.
import { chromium } from '/opt/google-flow-mcp/node_modules/playwright-core/index.mjs';

const CDP = process.env.FLOW_CDP_URL ?? 'http://127.0.0.1:9333';
const EVERY_MS = Number(process.env.FLOW_OVERLAY_CHECK_MS ?? 20_000);
const ACCEPT = /continue|understand|agree|accept|got it|get started|done/i;

const log = (message) => console.log(`${new Date().toISOString()} [overlay-guard] ${message}`);

async function clearOnce() {
  const browser = await chromium.connectOverCDP(CDP);
  try {
    const page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().includes('flow.google.com'));
    if (!page) return;
    for (let round = 0; round < 3; round++) {
      const state = await page.evaluate((acceptSource) => {
        const accept = new RegExp(acceptSource, 'i');
        const root = document.querySelector('.cdk-overlay-container');
        if (!root || !document.querySelector('.cdk-overlay-backdrop-showing')) return { showing: false };
        // Legal dialogs enable their button only after the body is scrolled to the end.
        for (const el of root.querySelectorAll('*')) {
          if (el.scrollHeight > el.clientHeight + 20) el.scrollTop = el.scrollHeight;
        }
        const buttons = [...root.querySelectorAll('button')];
        const target = buttons.find(b => accept.test(b.innerText || b.getAttribute('aria-label') || '') && !b.disabled);
        const label = buttons.map(b => (b.innerText || '').trim()).filter(Boolean).join('/');
        if (target) target.click();
        return { showing: true, clicked: (target?.innerText || '').trim() || null, buttons: label.slice(0, 80) };
      }, ACCEPT.source);
      if (!state.showing) return;
      log(`overlay: ${state.buttons} → clicked ${state.clicked ?? 'nothing'}`);
      await page.waitForTimeout(1000);
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

log(`watching ${CDP} every ${EVERY_MS} ms`);
for (;;) {
  await clearOnce().catch(error => log(`skipped: ${String(error).slice(0, 120)}`));
  await new Promise(resolve => setTimeout(resolve, EVERY_MS));
}

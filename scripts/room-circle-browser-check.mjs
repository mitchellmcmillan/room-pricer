import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const start = (command, args) => spawn(command, args, { stdio: 'ignore' });
const waitFor = async (url) => {
    for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
            await fetch(url);
            return;
        } catch {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
    }
    throw new Error(`Timed out waiting for ${url}`);
};

const api = start('npm', ['run', 'auction-dev']);
const vite = start('npm', ['run', 'dev', '--', '--host', '127.0.0.1']);
let browser;

try {
    await waitFor('http://127.0.0.1:5173');
    await waitFor('http://127.0.0.1:8080');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto('http://127.0.0.1:5173/#/start');
    await page.getByRole('button', { name: 'Generate example data' }).click();
    await page.getByRole('button', { name: 'Next' }).click();
    await page.waitForTimeout(1000);
    await page.getByText('Alice', { exact: true }).click();
    await page.waitForSelector('[data-testid="room-circle"]', { timeout: 5000 });

    const failures = await page.locator('[data-testid="room-circle"]').evaluateAll(circles => circles.flatMap(circle => {
        const circleRect = circle.getBoundingClientRect();
        const cx = circleRect.left + circleRect.width / 2;
        const cy = circleRect.top + circleRect.height / 2;
        const radius = Math.min(circleRect.width, circleRect.height) / 2 - 2;
        return ['room-name', 'room-description'].flatMap(testId => {
            const textElement = circle.querySelector(`[data-testid="${testId}"]`);
            const range = document.createRange();
            range.selectNodeContents(textElement);
            const textRect = range.getBoundingClientRect();
            const corners = [[textRect.left, textRect.top], [textRect.right, textRect.top], [textRect.left, textRect.bottom], [textRect.right, textRect.bottom]];
            return corners.some(([x, y]) => Math.hypot(x - cx, y - cy) > radius)
                ? [`${testId} crosses circle boundary`]
                : [];
        });
    }));

    assert.deepEqual(failures, []);
    console.log('RoomCircle browser geometry: pass');
} finally {
    if (browser) await browser.close();
    api.kill();
    vite.kill();
}

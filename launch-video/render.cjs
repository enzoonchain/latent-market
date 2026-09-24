// Renders index.html frame-by-frame with Playwright and encodes an MP4 with ffmpeg.
//   node render.cjs                      -> out/latent-launch.mp4 (needs out/audio.wav, see audio.py)
//   node render.cjs --stills 2,5,9.5     -> out/still-<t>.png for quick review
// Env: FFMPEG (ffmpeg binary), FPS (default 30), NODE_PATH should include the global playwright.
const { chromium } = require('playwright');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const FPS = +(process.env.FPS || 30);
const FFMPEG = process.env.FFMPEG || 'ffmpeg';
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('file://' + path.join(__dirname, 'index.html') + '?capture=1');
  await page.evaluate(() => document.fonts.ready);
  const dur = await page.evaluate(() => window.DUR);

  const si = process.argv.indexOf('--stills');
  if (si > -1) {
    for (const t of process.argv[si + 1].split(',').map(Number)) {
      await page.evaluate(t => window.render(t), t);
      await page.screenshot({ path: path.join(OUT, `still-${t}.png`) });
    }
    await browser.close();
    return;
  }

  const audio = path.join(OUT, 'audio.wav');
  const args = ['-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-'];
  if (fs.existsSync(audio)) args.push('-i', audio, '-c:a', 'aac', '-b:a', '192k', '-shortest');
  args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(OUT, 'latent-launch.mp4'));
  const ff = spawn(FFMPEG, args, { stdio: ['pipe', 'inherit', 'inherit'] });

  const frames = Math.round(dur * FPS);
  for (let f = 0; f < frames; f++) {
    await page.evaluate(t => window.render(t), f / FPS);
    const buf = await page.screenshot({ type: 'jpeg', quality: 94 });
    if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
    if (f % 60 === 0) process.stderr.write(`frame ${f}/${frames}\n`);
  }
  ff.stdin.end();
  await new Promise(r => ff.on('close', r));
  await browser.close();
})();

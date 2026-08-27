// scripts/verify.mjs
// 사용법: node scripts/verify.mjs L03-conditional-probability.html
//
// 잡는 것: JS 콘솔 에러, SVG 텍스트가 viewBox를 벗어남, 중복 id,
//          해결되지 않는 url(#...) 참조, 모바일 가로 오버플로우,
//          데스크톱/모바일 전체 스크린샷 + 도해별 개별 스크린샷
// 못 잡는 것: 도형끼리 겹쳐서 글자가 안 읽히는 것, 설명의 질, 예제 난이도.
//            그건 도해별 스크린샷을 사람이 봐야 한다.

import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { mkdirSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const target = process.argv[2];
if (!target) {
  console.error('사용법: node scripts/verify.mjs <파일.html>');
  process.exit(1);
}
const abs = resolve(process.cwd(), target);
if (!existsSync(abs)) {
  console.error(`파일 없음: ${abs}`);
  process.exit(1);
}

const stem = basename(target).replace(/\.html$/, '');
const url = pathToFileURL(abs).href;
mkdirSync('shots', { recursive: true });

const MOBILE = 390;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

const consoleErrors = [];
page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', e => consoleErrors.push('pageerror: ' + e.message));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForTimeout(400);

// ── 정적 검사 ────────────────────────────────
const report = await page.evaluate(() => {
  const out = { dupIds: [], badRefs: [], overflow: [], counts: {} };

  // 중복 id
  const seen = new Map();
  document.querySelectorAll('[id]').forEach(el => {
    seen.set(el.id, (seen.get(el.id) || 0) + 1);
  });
  seen.forEach((n, id) => { if (n > 1) out.dupIds.push(`${id} (${n}회)`); });

  // url(#...) 참조가 실제 존재하는지
  const refAttrs = ['clip-path', 'mask', 'fill', 'stroke', 'marker-end', 'marker-start', 'filter'];
  document.querySelectorAll('svg *').forEach(el => {
    refAttrs.forEach(a => {
      const v = el.getAttribute(a);
      if (!v) return;
      const m = /url\(#([^)]+)\)/.exec(v);
      if (m && !document.getElementById(m[1])) out.badRefs.push(`${a}="${v}"`);
    });
  });

  // SVG 텍스트가 viewBox 밖으로 나가는지
  document.querySelectorAll('svg').forEach((svg, si) => {
    const vb = svg.viewBox && svg.viewBox.baseVal;
    if (!vb || (!vb.width && !vb.height)) return;
    const label = svg.getAttribute('aria-label') || `svg#${si}`;
    svg.querySelectorAll('text').forEach(t => {
      let b;
      try { b = t.getBBox(); } catch { return; }
      if (b.width === 0 && b.height === 0) return;
      const pad = 1.5;
      const left = b.x < vb.x - pad;
      const right = b.x + b.width > vb.x + vb.width + pad;
      const top = b.y < vb.y - pad;
      const bottom = b.y + b.height > vb.y + vb.height + pad;
      if (left || right || top || bottom) {
        const side = [left && '왼쪽', right && '오른쪽', top && '위', bottom && '아래']
          .filter(Boolean).join('/');
        out.overflow.push(
          `[${label}] "${(t.textContent || '').trim().slice(0, 24)}" ${side} 이탈 ` +
          `(x=${b.x.toFixed(0)} w=${b.width.toFixed(0)} / viewBox w=${vb.width})`
        );
      }
    });
  });

  out.counts.sections = document.querySelectorAll('section').length;
  out.counts.figures = document.querySelectorAll('figure, .mini').length;
  out.counts.examples = document.querySelectorAll('.ex').length;
  out.counts.traps = document.querySelectorAll('.trap').length;
  out.counts.details = document.querySelectorAll('details').length;
  return out;
});

// ── 스크린샷: 데스크톱 / 모바일 전체 ──────────
await page.screenshot({ path: `shots/${stem}-desktop.png`, fullPage: true });
await page.setViewportSize({ width: MOBILE, height: 844 });
await page.waitForTimeout(250);
await page.screenshot({ path: `shots/${stem}-mobile.png`, fullPage: true });

// ── 모바일 가로 오버플로우 (풀이를 다 펼친 상태로) ──
// 풀이가 접혀 있을 때는 멀쩡하다가 펼치면 터지는 경우가 있어서 펼쳐놓고 잰다.
await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true));
await page.waitForTimeout(300);
const hoverflow = await page.evaluate(() => {
  const de = document.documentElement;
  const doc = de.scrollWidth;
  const view = de.clientWidth;
  const bad = [];
  if (doc > view + 1) {
    document.querySelectorAll('body *').forEach(el => {
      // SVG 내부 요소는 좌표계가 달라 의미 없는 값이 나온다
      if (el.tagName !== 'svg' && el.closest('svg')) return;
      // 가로 스크롤 컨테이너 안쪽은 의도된 것이므로 제외
      for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
        if (getComputedStyle(p).overflowX === 'auto') return;
      }
      const b = el.getBoundingClientRect();
      if (b.right <= view + 1) return;
      // 더 안쪽 요소가 이미 걸렸으면 바깥 요소는 생략
      const inner = [...el.children].some(k => k.getBoundingClientRect().right > view + 1);
      if (inner) return;
      const sec = el.closest('section');
      bad.push(
        `<${el.tagName.toLowerCase()} class="${String(el.className).slice(0, 22)}"> ` +
        `right=${Math.round(b.right)} [${sec ? sec.id : '-'}] ` +
        `"${(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40)}"`
      );
    });
  }
  return { doc, view, bad: bad.slice(0, 8) };
});

// ── 스크린샷: 도해별 개별 (풀이 펼친 상태, 데스크톱 폭) ──
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(250);
const figs = await page.$$('figure, .play');
let shotCount = 0;
for (const el of figs) {
  const id = String(shotCount + 1).padStart(2, '0');
  try {
    await el.scrollIntoViewIfNeeded();
    await page.waitForTimeout(60);
    await el.screenshot({ path: `shots/${stem}-fig${id}.png` });
    shotCount++;
  } catch {
    // 렌더되지 않는 요소는 건너뛴다
  }
}

await browser.close();

// ── 결과 출력 ────────────────────────────────
const line = (s) => console.log(s);
let fail = 0;

line(`\n검증: ${target}`);
line(`섹션 ${report.counts.sections} · 도해 ${report.counts.figures} · ` +
     `예제 ${report.counts.examples} · 함정 ${report.counts.traps} · 접힌풀이 ${report.counts.details}`);

if (consoleErrors.length) {
  fail++; line(`\n[FAIL] JS 콘솔 에러 ${consoleErrors.length}건`);
  consoleErrors.slice(0, 8).forEach(e => line('  · ' + e));
} else line('\n[OK] JS 콘솔 에러 없음');

if (report.dupIds.length) {
  fail++; line(`\n[FAIL] 중복 id ${report.dupIds.length}건 (SVG 렌더링이 깨진다)`);
  report.dupIds.forEach(e => line('  · ' + e));
} else line('[OK] 중복 id 없음');

if (report.badRefs.length) {
  fail++; line(`\n[FAIL] 존재하지 않는 참조 ${report.badRefs.length}건`);
  report.badRefs.slice(0, 8).forEach(e => line('  · ' + e));
} else line('[OK] url(#...) 참조 정상');

if (report.overflow.length) {
  fail++; line(`\n[FAIL] SVG 텍스트 이탈 ${report.overflow.length}건`);
  report.overflow.slice(0, 15).forEach(e => line('  · ' + e));
} else line('[OK] SVG 텍스트 viewBox 안에 있음');

if (hoverflow.doc > hoverflow.view + 1) {
  fail++;
  line(`\n[FAIL] 모바일 가로 오버플로우 (문서 ${hoverflow.doc}px > 화면 ${hoverflow.view}px)`);
  hoverflow.bad.forEach(e => line('  · ' + e));
  line('  힌트: 긴 .m 수식(nowrap), 표의 min-content, 그리드 트랙 1fr을 의심할 것.');
} else line(`[OK] 모바일(${MOBILE}px) 가로 오버플로우 없음 (풀이 펼친 상태 기준)`);

line(`\n전체 스크린샷: shots/${stem}-desktop.png, shots/${stem}-mobile.png`);
if (shotCount > 0) {
  line(`도해 스크린샷: shots/${stem}-fig01.png … -fig${String(shotCount).padStart(2, '0')}.png (${shotCount}장)`);
  line('도해 스크린샷은 반드시 한 장씩 열어서 눈으로 확인할 것.');
  line('도형 겹침(테두리가 글자를 관통하는 것)과 색 대비는 자동 검사가 못 잡는다.\n');
} else {
  line('도해 스크린샷: 없음 (figure / .play 요소가 없는 파일)\n');
}

process.exit(fail ? 1 : 0);

// scripts/verify.mjs
// 사용법: node scripts/verify.mjs L03-conditional-probability.html
//
// 잡는 것: JS 콘솔 에러, SVG 텍스트가 viewBox를 벗어남, 중복 id,
//          해결되지 않는 url(#...) 참조, 모바일 가로 오버플로우,
//          데스크톱/모바일 전체 스크린샷 + 도해별 개별 스크린샷
// 못 잡는 것: 도형끼리 겹쳐서 글자가 안 읽히는 것, 설명의 질, 예제 난이도.
//            그건 도해별 스크린샷을 사람이 봐야 한다.

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, mkdirSync, existsSync, statSync } from 'node:fs';
import { resolve, basename, extname, join, relative, sep } from 'node:path';

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
mkdirSync('shots', { recursive: true });

// ── 정적 서버 ────────────────────────────────
// file://로 열면 브라우저가 PDF와 모듈 fetch를 막아서 슬라이드 리더를 검증할 수 없다.
// GitHub Pages와 같은 조건(http)으로 맞춘다.
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};
const ROOT = process.cwd();

function serve() {
  return new Promise(ok => {
    const server = createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      const file = resolve(ROOT, rel);
      // 루트 밖으로 나가는 요청은 막는다
      const inside = file === ROOT || file.startsWith(ROOT + sep);
      if (!inside || !existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream' });
      createReadStream(file).pipe(res);
    });
    server.listen(0, '127.0.0.1', () => ok({
      origin: `http://127.0.0.1:${server.address().port}`,
      close: () => new Promise(done => server.close(done)),
    }));
  });
}

const site = await serve();
const url = `${site.origin}/${relative(ROOT, abs).split(sep).join('/')}`;

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

// ── 슬라이드 리더 ────────────────────────────
// 앵커가 있는 파일만 검사한다. 리더는 1100px 이상에서만 뜨므로 넓은 뷰포트로 연다.
const reader = { anchors: 0, mounted: false, pages: 0, outOfRange: [], overlaps: [], backward: [], gaps: [], folded: [], lostLabel: [], starts: 0, marks: 0, ticks: 0, skipped: false };
{
  const anchorCount = await page.evaluate(() => document.querySelectorAll('[data-slide]').length);
  reader.anchors = anchorCount;
  if (anchorCount === 0) {
    reader.skipped = true;
  } else {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto(url, { waitUntil: 'networkidle' });
    try {
      // 첫 쪽이 렌더될 때까지 기다린다
      await page.waitForSelector('#rdr canvas', { timeout: 20000 });
      reader.mounted = true;
    } catch { /* mounted=false로 아래에서 보고된다 */ }

    Object.assign(reader, await page.evaluate(() => {
      const txt = document.querySelector('#rdr-pg')?.textContent || '';
      const total = +(/\/\s*(\d+)/.exec(txt)?.[1] || 0);
      const list = [...document.querySelectorAll('[data-slide]')].map(el => {
        const m = /^(\d+)(?:\s*[-–~]\s*(\d+))?$/.exec(String(el.dataset.slide).trim());
        // 앵커는 id가 없는 div.sec-head인 경우가 많아 감싸는 섹션 id를 같이 보여준다.
        const sec = el.closest('section');
        const where = (sec ? sec.id + ' ' : '') + el.tagName.toLowerCase() +
          ' "' + (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 26) + '"';
        const isSec = el.classList.contains('sec-head');
        if (!m) return { where, isSec, bad: true, raw: el.dataset.slide };
        return { where, isSec, from: +m[1], to: m[2] ? +m[2] : +m[1] };
      });
      const outOfRange = list
        .filter(a => a.bad || (total && (a.from < 1 || a.to > total || a.from > a.to)))
        .map(a => `${a.where} → data-slide="${a.bad ? a.raw : a.from + '-' + a.to}"`);
      const overlaps = [];
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = list[i], b = list[j];
          if (a.bad || b.bad) continue;
          if (a.from <= b.to && b.from <= a.to) {
            // 섹션과 그 안의 h3는 포함 관계라 정상. 완전 포함은 봐준다.
            const contains = (a.from <= b.from && b.to <= a.to) || (b.from <= a.from && a.to <= b.to);
            if (!contains) overlaps.push(`${a.where} [${a.from}-${a.to}] ↔ ${b.where} [${b.from}-${b.to}]`);
          }
        }
      }
      // 문서 순서대로 읽었을 때 슬라이드 번호가 뒤로 가는 곳.
      // 노트 구성이 슬라이드 진행과 어긋난다는 신호다. 의도한 재배열일 수도 있어 경고만 한다.
      const backward = [];
      for (let i = 1; i < list.length; i++) {
        const a = list[i - 1], b = list[i];
        if (a.bad || b.bad) continue;
        if (b.from < a.from) backward.push(`${a.where} [${a.from}] → ${b.where} [${b.from}]`);
      }
      // 어떤 앵커에도 안 걸린 쪽. 노트가 그 슬라이드를 아예 안 다룬다는 뜻이다.
      // 표지나 손글씨 삽입 페이지는 정상이지만, 범위를 짧게 잡아 빠뜨린 경우도 여기 걸린다.
      const covered = new Set();
      for (const a of list) {
        if (a.bad) continue;
        for (let i = a.from; i <= a.to; i++) covered.add(i);
      }
      const gaps = [];
      for (let i = 1; i <= total; i++) if (!covered.has(i)) gaps.push(i);

      // 노트의 판정선과 슬라이드의 판정선은 개수가 맞아야 한다.
      // 단, 기준은 앵커 개수가 아니라 "서로 다른 시작 쪽" 개수다.
      // 노트 앵커 둘이 같은 슬라이드 쪽에서 시작하면 PDF에는 그릴 자리가 하나뿐이라
      // 하나로 접힌다. 그건 정상이고, 그 외에 어긋나면 표시를 잃어버린 것이다.
      const starts = new Map();      // 시작 쪽 → 그 쪽에서 시작하는 앵커 이름들
      for (const a of list) {
        if (a.bad) continue;
        if (!starts.has(a.from)) starts.set(a.from, []);
        starts.get(a.from).push(a);
      }
      const marks = document.querySelectorAll('.rdr-mark').length;
      const ticks = document.querySelectorAll('.rdr-tick').length;
      // 접힌 자리 중, 섹션끼리 부딪힌 것은 라벨 이름을 실제로 잃는다.
      // 섹션 + h3 조합은 라벨이 이기므로 정보 손실이 없다.
      const folded = [], lostLabel = [];
      for (const [pg, v] of starts.entries()) {
        if (v.length < 2) continue;
        const line = `${pg}쪽: ${v.map(x => x.where).join('  |  ')}`;
        if (v.filter(x => x.isSec).length > 1) lostLabel.push(line);
        else folded.push(line);
      }

      return {
        pages: total, outOfRange, overlaps, backward, gaps,
        starts: starts.size, marks, ticks, folded, lostLabel,
      };
    }));
  }
}

// ── 스크린샷: 도해별 개별 (풀이 펼친 상태, 데스크톱 폭) ──
await page.setViewportSize({ width: 1280, height: 900 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true));
await page.waitForTimeout(300);
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
await site.close();

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

if (reader.skipped) {
  line('[--] 슬라이드 리더: data-slide 앵커가 없어 건너뜀');
} else if (!reader.mounted) {
  fail++;
  line(`\n[FAIL] 슬라이드 리더가 뜨지 않음 (앵커는 ${reader.anchors}개 있음)`);
  line(`  slides/${stem}.pdf 가 있는지, reader.js 태그가 들어갔는지 확인할 것.`);
} else {
  line(`[OK] 슬라이드 리더 동작 (앵커 ${reader.anchors}개 / PDF ${reader.pages}쪽)`);

  // 노트의 판정선과 슬라이드의 판정선 개수가 맞는지.
  // 앵커 개수가 아니라 "서로 다른 시작 쪽" 개수와 맞아야 한다.
  const shown = reader.marks + reader.ticks;
  if (shown === reader.starts) {
    line(`[OK] 판정선 개수 일치 (노트 시작 쪽 ${reader.starts}개 = PDF 표시 ${shown}개` +
         `: 라벨 ${reader.marks} + 눈금 ${reader.ticks})`);
    if (reader.folded.length) {
      line(`     같은 슬라이드 쪽에서 시작해 하나로 접힌 앵커 ${reader.folded.length}곳 (정상):`);
      reader.folded.slice(0, 6).forEach(e => line('       · ' + e));
    }
  } else {
    fail++;
    line(`\n[FAIL] 판정선 개수 불일치: 노트 시작 쪽 ${reader.starts}개 ≠ PDF 표시 ${shown}개`);
    line(`  라벨 ${reader.marks} + 눈금 ${reader.ticks}. 슬라이드쪽 표시가 조용히 사라졌다.`);
    line('  섹션 두 개가 같은 쪽에서 시작하면 라벨 하나를 잃는다. reader.js의 layout()을 볼 것.');
  }
}

if (reader.outOfRange?.length) {
  fail++;
  line(`\n[FAIL] data-slide가 PDF 쪽 범위를 벗어남 ${reader.outOfRange.length}건 (PDF는 ${reader.pages}쪽)`);
  reader.outOfRange.slice(0, 10).forEach(e => line('  · ' + e));
}
if (reader.overlaps?.length) {
  fail++;
  line(`\n[FAIL] data-slide 범위가 서로 겹침 ${reader.overlaps.length}건`);
  reader.overlaps.slice(0, 10).forEach(e => line('  · ' + e));
  line('  겹치면 역방향 동기화(PDF→노트)가 어느 쪽으로 갈지 정해지지 않는다.');
  line('  한 슬라이드는 그것을 실제로 다루는 곳 한 군데에만 앵커를 단다.');
}
if (reader.lostLabel?.length) {
  fail++;
  line(`\n[FAIL] 섹션 두 개가 같은 슬라이드 쪽에서 시작 ${reader.lostLabel.length}곳`);
  reader.lostLabel.forEach(e => line('  · ' + e));
  line('  슬라이드쪽에 라벨을 하나만 그릴 수 있어 섹션 이름 하나가 사라진다.');
  line('  두 섹션이 정말 같은 쪽에서 시작한다면 하나로 합치거나 범위를 다시 나눌 것.');
}
if (reader.gaps?.length) {
  // 실패로 치지 않는다. 표지나 손글씨 삽입 페이지는 노트가 안 다루는 게 정상이다.
  line(`\n[WARN] 어떤 앵커에도 안 걸린 슬라이드 ${reader.gaps.length}쪽: ${reader.gaps.join(', ')}`);
  line('  노트가 그 슬라이드를 안 다룬다는 뜻이다. 표지·삽입 페이지면 정상이지만,');
  line('  범위를 짧게 잡아 빠뜨린 것일 수도 있다. 해당 쪽을 열어서 확인할 것.');
}
if (reader.backward?.length) {
  // 실패로 치지 않는다. 노트를 일부러 슬라이드와 다르게 배열할 수도 있다.
  line(`\n[WARN] 노트를 따라 내려가는데 슬라이드가 뒤로 가는 곳 ${reader.backward.length}건`);
  reader.backward.slice(0, 10).forEach(e => line('  · ' + e));
  line('  읽으면서 슬라이드가 앞뒤로 튄다. 의도한 재배열이 아니면 노트 순서를 슬라이드에 맞추는 게 낫다.');
}

line(`\n전체 스크린샷: shots/${stem}-desktop.png, shots/${stem}-mobile.png`);
if (shotCount > 0) {
  line(`도해 스크린샷: shots/${stem}-fig01.png … -fig${String(shotCount).padStart(2, '0')}.png (${shotCount}장)`);
  line('도해 스크린샷은 반드시 한 장씩 열어서 눈으로 확인할 것.');
  line('도형 겹침(테두리가 글자를 관통하는 것)과 색 대비는 자동 검사가 못 잡는다.\n');
} else {
  line('도해 스크린샷: 없음 (figure / .play 요소가 없는 파일)\n');
}

process.exit(fail ? 1 : 0);

/**
 * scripts/build-icon.js
 *
 * exe 파일 아이콘(assets/icon.ico)을 코드로 직접 그려서 만든다. 외부 이미지를
 * 안 쓰는 이유: PokeAPI/sprites 저장소의 몬스터볼 이미지가 전부 저해상도(30~90px)라
 * 256px 아이콘엔 흐릿하게 나옴 — 그냥 깔끔한 2톤 몬스터볼을 Canvas로 직접 그려서
 * 해상도별로 따로 렌더링(업스케일 없이 각 크기마다 새로 그림 = 항상 선명함).
 *
 * Electron의 BrowserWindow.capturePage()로 캔버스를 래스터화해야 해서 일반
 * node가 아니라 electron으로 실행해야 함: `npm run build-icon`
 * (앱 실행 아님 — 아이콘 한 번 만들고 바로 종료됨)
 */

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow } = require("electron");

const SIZES = [16, 24, 32, 48, 64, 128, 256];

function pokeballHtml(size) {
  return `<!DOCTYPE html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;}
    canvas{display:block;}
  </style></head><body>
  <canvas id="c" width="${size}" height="${size}"></canvas>
  <script>
    const ctx = document.getElementById("c").getContext("2d");
    const size = ${size};
    const cx = size / 2, cy = size / 2;
    const r = size / 2 - size * 0.04;

    // 바깥 검은 테두리
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fillStyle = "#1a1a1a"; ctx.fill();

    const ri = r - size * 0.035;
    // 위쪽 빨강
    ctx.beginPath(); ctx.arc(cx, cy, ri, Math.PI, 0); ctx.closePath(); ctx.fillStyle = "#ee1515"; ctx.fill();
    // 아래쪽 흰색
    ctx.beginPath(); ctx.arc(cx, cy, ri, 0, Math.PI); ctx.closePath(); ctx.fillStyle = "#ffffff"; ctx.fill();

    // 가운데 검은 띠
    const bandH = size * 0.1;
    ctx.fillStyle = "#1a1a1a";
    ctx.fillRect(cx - ri, cy - bandH / 2, ri * 2, bandH);

    // 가운데 버튼(검은 테두리 + 흰 안쪽)
    ctx.beginPath(); ctx.arc(cx, cy, size * 0.17, 0, Math.PI * 2); ctx.fillStyle = "#1a1a1a"; ctx.fill();
    ctx.beginPath(); ctx.arc(cx, cy, size * 0.105, 0, Math.PI * 2); ctx.fillStyle = "#ffffff"; ctx.fill();
  </script>
  </body></html>`;
}

// ICO 컨테이너를 직접 조립 — ICONDIR(6B) + ICONDIRENTRY(이미지당 16B) + PNG 데이터들.
// 최신 .ico는 각 항목에 BMP 대신 PNG를 그대로 담는 방식이 표준으로 지원됨.
function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const headerSize = 6 + count * 16;
  let offset = headerSize;
  const entries = [];
  for (const { size, buffer } of pngBuffers) {
    entries.push({ size, buffer, offset });
    offset += buffer.length;
  }

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dirEntries = Buffer.concat(
    entries.map(({ size, buffer, offset }) => {
      const e = Buffer.alloc(16);
      e.writeUInt8(size >= 256 ? 0 : size, 0); // width (0 = 256)
      e.writeUInt8(size >= 256 ? 0 : size, 1); // height
      e.writeUInt8(0, 2); // color count
      e.writeUInt8(0, 3); // reserved
      e.writeUInt16LE(1, 4); // color planes
      e.writeUInt16LE(32, 6); // bits per pixel
      e.writeUInt32LE(buffer.length, 8); // bytes in resource
      e.writeUInt32LE(offset, 12); // offset
      return e;
    })
  );

  return Buffer.concat([header, dirEntries, ...entries.map((e) => e.buffer)]);
}

async function renderSize(size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    show: false,
    transparent: true,
    frame: false,
    webPreferences: { offscreen: false },
  });
  await win.loadURL("data:text/html," + encodeURIComponent(pokeballHtml(size)));
  await new Promise((r) => setTimeout(r, 50)); // 캔버스 그리기 완료 대기
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
  win.close();
  return image.toPNG();
}

async function main() {
  console.log(`Rendering pokeball icon at sizes: ${SIZES.join(", ")}`);
  const pngBuffers = [];
  for (const size of SIZES) {
    const buffer = await renderSize(size);
    pngBuffers.push({ size, buffer });
    console.log(`  ${size}x${size}: ${buffer.length} bytes`);
  }

  const ico = buildIco(pngBuffers);
  const outPath = path.join(__dirname, "..", "assets", "icon.ico");
  fs.writeFileSync(outPath, ico);
  console.log(`Saved: ${outPath} (${ico.length} bytes)`);

  // 트레이 아이콘도 같은 디자인으로 교체(지금 있는 건 예전에 대충 만든 placeholder).
  const trayPng = pngBuffers.find((p) => p.size === 32).buffer;
  fs.writeFileSync(path.join(__dirname, "..", "assets", "tray-icon.png"), trayPng);
  console.log("Also replaced assets/tray-icon.png with the 32x32 version.");
}

app.whenReady().then(async () => {
  await main();
  app.exit(0);
});

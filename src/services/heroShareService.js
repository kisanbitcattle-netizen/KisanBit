// src/services/heroShareService.js
//
// Generates the single shareable card for the WHOLE home hero â€”
// map snapshot + cattle count + today's advisory quote + KisanBit
// branding â€” so sharing works directly from the home screen without
// requiring the user to open the full map first.
//
// Like shareCardService.js, this draws a stylized card rather than
// screenshotting live OSM tiles (avoids canvas-tainting CORS issues
// with public tile servers).

const CARD_WIDTH = 800;
const CARD_HEIGHT = 900;
const MAP_AREA = { x: 40, y: 190, w: 720, h: 420 };

function project(lat, lon, bounds) {
  const { minLat, maxLat, minLon, maxLon } = bounds;
  const latSpan = maxLat - minLat || 0.001;
  const lonSpan = maxLon - minLon || 0.001;
  const x = MAP_AREA.x + ((lon - minLon) / lonSpan) * MAP_AREA.w;
  const y = MAP_AREA.y + (1 - (lat - minLat) / latSpan) * MAP_AREA.h;
  return { x, y };
}

function computeBounds(points) {
  const pad = 0.002;
  const lats = points.map((p) => p[0]);
  const lons = points.map((p) => p[1]);
  return {
    minLat: Math.min(...lats) - pad,
    maxLat: Math.max(...lats) + pad,
    minLon: Math.min(...lons) - pad,
    maxLon: Math.max(...lons) + pad,
  };
}

async function loadLogo() {
  return new Promise((resolve) => {
    const img = new Image();
    // FIX: crossOrigin='anonymous' used to be set unconditionally, even
    // though this path ('/assets/branding/...') is a local bundled asset,
    // not a remote URL - in the packaged Capacitor app it resolves to a
    // local scheme (capacitor://, file://), and forcing crossOrigin on a
    // local scheme is exactly the bug already found and fixed in
    // utils/shareCard.js's loadImage(): it can make the load fail, or
    // succeed but leave the canvas tainted so the toBlob() call below
    // throws. Only set it for an actual http(s) URL, which is the only
    // case that both needs it and can serve the right CORS headers back.
    const logoUrl = '/assets/branding/kisanbit-logo.png';
    if (/^https?:\/\//i.test(logoUrl)) {
      img.crossOrigin = 'anonymous';
    }
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = logoUrl;
  });
}

export async function generateAndShareHomeCard({ cattleList, quote }) {
  const points = cattleList.map((c) => c.displayPosition).filter(Boolean);
  const bounds = computeBounds(points.length > 0 ? points : [[17.385, 78.4867]]);

  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  // Header band â€” brand navy
  ctx.fillStyle = '#2b3a61';
  ctx.fillRect(0, 0, CARD_WIDTH, 150);

  const logo = await loadLogo();
  if (logo) {
    ctx.drawImage(logo, 30, 30, 90, 90);
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 34px Poppins, sans-serif';
  ctx.fillText('KisanBit', 140, 78);
  ctx.font = '400 16px sans-serif';
  ctx.fillStyle = '#dea03b';
  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  ctx.fillText(today, 140, 106);

  // Map area
  ctx.fillStyle = '#f0f3ee';
  ctx.fillRect(MAP_AREA.x, MAP_AREA.y, MAP_AREA.w, MAP_AREA.h);
  ctx.strokeStyle = '#dfe6dc';
  for (let gx = MAP_AREA.x; gx <= MAP_AREA.x + MAP_AREA.w; gx += 40) {
    ctx.beginPath();
    ctx.moveTo(gx, MAP_AREA.y);
    ctx.lineTo(gx, MAP_AREA.y + MAP_AREA.h);
    ctx.stroke();
  }
  ctx.strokeStyle = '#2b3a61';
  ctx.lineWidth = 2;
  ctx.strokeRect(MAP_AREA.x, MAP_AREA.y, MAP_AREA.w, MAP_AREA.h);

  // Cattle dots
  const colors = ['#2b3a61', '#dea03b', '#2f9e64', '#d64545', '#7b5ea7'];
  cattleList.forEach((c, i) => {
    if (!c.displayPosition) return;
    const { x, y } = project(c.displayPosition[0], c.displayPosition[1], bounds);
    ctx.beginPath();
    ctx.arc(x, y, 8, 0, Math.PI * 2);
    ctx.fillStyle = colors[i % colors.length];
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.font = 'bold 13px sans-serif';
    ctx.fillStyle = '#1a1a2e';
    ctx.textAlign = 'center';
    ctx.fillText(c.name, x, y - 14);
    ctx.textAlign = 'left';
  });

  // Stat line
  ctx.fillStyle = '#1a1a2e';
  ctx.font = '600 20px Poppins, sans-serif';
  ctx.fillText(`${cattleList.length} animals tracked today`, 40, MAP_AREA.y + MAP_AREA.h + 45);

  // Quote card
  const quoteY = MAP_AREA.y + MAP_AREA.h + 70;
  ctx.fillStyle = '#f5f6f8';
  ctx.fillRect(40, quoteY, 720, 110);
  ctx.fillStyle = '#dea03b';
  ctx.fillRect(40, quoteY, 6, 110);
  ctx.fillStyle = '#1a1a2e';
  ctx.font = '600 17px Noto Sans Telugu, sans-serif';
  wrapText(ctx, quote.te, 62, quoteY + 35, 680, 26);
  ctx.font = '400 13px sans-serif';
  ctx.fillStyle = '#6b7280';
  ctx.fillText(quote.en, 62, quoteY + 90);

  // Footer
  ctx.fillStyle = '#9aa0aa';
  ctx.font = '13px sans-serif';
  ctx.fillText('Tracked live with KisanBit - Smart Cattle & Crop Tracking', 40, CARD_HEIGHT - 20);

  // FIX: canvas.toBlob() used to be called with no error handling - if
  // the canvas ended up tainted (e.g. the logo taint bug above, before
  // the crossOrigin fix), toBlob() throws a SecurityError synchronously
  // and that was never caught here, matching the same uncaught-crash
  // shape already found and fixed in utils/shareCard.js's drawCard().
  const blob = await new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => {
        if (b) resolve(b);
        else reject(new Error('Canvas toBlob returned null'));
      }, 'image/png');
    } catch (err) {
      reject(err);
    }
  });
  const fileName = `kisanbit_home_${Date.now()}.png`;
  const file = new File([blob], fileName, { type: 'image/png' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({
      files: [file],
      title: 'KisanBit',
      text: 'My farm today, tracked with KisanBit',
    });
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }
}

function wrapText(ctx, text, x, y, maxWidth, lineHeight) {
  text = String(text ?? '');
  const words = text.split(' ');
  let line = '';
  let curY = y;
  for (const word of words) {
    const testLine = line + word + ' ';
    if (ctx.measureText(testLine).width > maxWidth && line !== '') {
      ctx.fillText(line, x, curY);
      line = word + ' ';
      curY += lineHeight;
    } else {
      line = testLine;
    }
  }
  ctx.fillText(line, x, curY);
}
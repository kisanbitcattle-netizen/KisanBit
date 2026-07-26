// src/services/shareCardService.js
//
// Generates a branded, WhatsApp-shareable image card showing today's
// cattle movement trail. Deliberately does NOT screenshot the live
// Leaflet/OSM tiles (tile servers don't send CORS headers reliably,
// which taints canvas exports) — instead it draws a clean, stylized
// "route card" from the same trail coordinates, which is faster,
// always works offline-safe, and looks more shareable anyway.

const CARD_WIDTH = 800;
const CARD_HEIGHT = 1000;
const MAP_AREA = { x: 40, y: 140, w: 720, h: 650 };

function project(lat, lon, bounds) {
  const { minLat, maxLat, minLon, maxLon } = bounds;
  const latSpan = maxLat - minLat || 0.001;
  const lonSpan = maxLon - minLon || 0.001;

  const x = MAP_AREA.x + ((lon - minLon) / lonSpan) * MAP_AREA.w;
  // Flip Y since latitude increases upward but canvas Y increases downward.
  const y = MAP_AREA.y + (1 - (lat - minLat) / latSpan) * MAP_AREA.h;
  return { x, y };
}

function computeBounds(allPoints) {
  const lats = allPoints.map((p) => p[0]);
  const lons = allPoints.map((p) => p[1]);
  const pad = 0.002; // small padding so points aren't flush against edges
  return {
    minLat: Math.min(...lats) - pad,
    maxLat: Math.max(...lats) + pad,
    minLon: Math.min(...lons) - pad,
    maxLon: Math.max(...lons) + pad,
  };
}

const TRAIL_COLORS = ['#1976d2', '#d32f2f', '#7b1fa2', '#00897b', '#f57c00'];

/// Builds the canvas card, then triggers Web Share (with image file) if
/// supported, falling back to a direct download the user can attach
/// manually to a WhatsApp chat.
export async function generateAndShareMapCard({ cattleList, trails, center }) {
  const allPoints = [
    ...Object.values(trails).flat(),
    ...cattleList.map((c) => c.displayPosition).filter(Boolean),
  ];

  if (allPoints.length === 0) {
    allPoints.push(center);
  }

  const bounds = computeBounds(allPoints);

  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext('2d');

  // Background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  // Header band
  ctx.fillStyle = '#2e7d32';
  ctx.fillRect(0, 0, CARD_WIDTH, 110);
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 34px sans-serif';
  ctx.fillText('🐄 KisanBit', 30, 55);
  ctx.font = '18px sans-serif';
  const today = new Date().toLocaleDateString('en-IN', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
  ctx.fillText(`Today's Cattle Movement — ${today}`, 30, 88);

  // Map area background (light green "field" look)
  ctx.fillStyle = '#eef5ee';
  ctx.fillRect(MAP_AREA.x, MAP_AREA.y, MAP_AREA.w, MAP_AREA.h);
  ctx.strokeStyle = '#c8ddc8';
  ctx.lineWidth = 1;
  for (let gx = MAP_AREA.x; gx <= MAP_AREA.x + MAP_AREA.w; gx += 40) {
    ctx.beginPath();
    ctx.moveTo(gx, MAP_AREA.y);
    ctx.lineTo(gx, MAP_AREA.y + MAP_AREA.h);
    ctx.stroke();
  }
  for (let gy = MAP_AREA.y; gy <= MAP_AREA.y + MAP_AREA.h; gy += 40) {
    ctx.beginPath();
    ctx.moveTo(MAP_AREA.x, gy);
    ctx.lineTo(MAP_AREA.x + MAP_AREA.w, gy);
    ctx.stroke();
  }
  ctx.strokeStyle = '#2e7d32';
  ctx.lineWidth = 2;
  ctx.strokeRect(MAP_AREA.x, MAP_AREA.y, MAP_AREA.w, MAP_AREA.h);

  // Draw each animal's trail
  let colorIdx = 0;
  const legendEntries = [];
  for (const c of cattleList) {
    const points = trails[c.id];
    const color = TRAIL_COLORS[colorIdx % TRAIL_COLORS.length];
    colorIdx += 1;

    if (points && points.length > 1) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.setLineDash([8, 5]);
      ctx.beginPath();
      points.forEach(([lat, lon], i) => {
        const { x, y } = project(lat, lon, bounds);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.setLineDash([]);

      // Start marker (morning) and end marker (latest position)
      const start = project(points[0][0], points[0][1], bounds);
      const end = project(points[points.length - 1][0], points[points.length - 1][1], bounds);
      drawDot(ctx, start.x, start.y, color, true);
      drawDot(ctx, end.x, end.y, color, false);
      drawLabel(ctx, end.x, end.y - 14, c.name);
    } else if (c.displayPosition) {
      const { x, y } = project(c.displayPosition[0], c.displayPosition[1], bounds);
      drawDot(ctx, x, y, color, false);
      drawLabel(ctx, x, y - 14, c.name);
    }

    legendEntries.push({ name: c.name, color });
  }

  // Legend footer
  let legendY = MAP_AREA.y + MAP_AREA.h + 30;
  ctx.font = '16px sans-serif';
  legendEntries.forEach((entry, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const lx = MAP_AREA.x + col * 360;
    const ly = legendY + row * 28;
    ctx.fillStyle = entry.color;
    ctx.beginPath();
    ctx.arc(lx + 6, ly - 5, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#333';
    ctx.fillText(entry.name, lx + 20, ly);
  });

  // Branding footer
  ctx.fillStyle = '#888';
  ctx.font = '14px sans-serif';
  ctx.fillText('Tracked live with KisanBit — Smart Cattle Tracking', 30, CARD_HEIGHT - 20);

  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const fileName = `kisanbit_trail_${Date.now()}.png`;
  const file = new File([blob], fileName, { type: 'image/png' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    await navigator.share({
      files: [file],
      title: 'KisanBit — Cattle Movement Today',
      text: 'Check out where my cattle roamed today 🐄📍',
    });
  } else {
    // Fallback: trigger a download the user can manually attach in WhatsApp.
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);
  }
}

function drawDot(ctx, x, y, color, isStart) {
  ctx.beginPath();
  ctx.arc(x, y, isStart ? 6 : 8, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 2;
  ctx.stroke();
}

function drawLabel(ctx, x, y, text) {
  ctx.font = 'bold 13px sans-serif';
  ctx.fillStyle = '#222';
  ctx.textAlign = 'center';
  ctx.fillText(text, x, y);
  ctx.textAlign = 'left';
}

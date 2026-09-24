// src/utils/shareCard.js
//
// Draws a branded, shareable image card (app name/logo + key details) on
// an offscreen canvas, then hands it to the device's native share sheet.
//
// Requires (install if not already present):
//   npm install @capacitor/share @capacitor/filesystem
//   npx cap sync
//
// Falls back to the browser's Web Share API (navigator.share with files)
// if the Capacitor plugins aren't available — useful when testing in a
// plain browser tab instead of the packaged app.

import { Share } from '@capacitor/share';
import { Filesystem, Directory } from '@capacitor/filesystem';
import logo from '../assets/branding/kisanbit-logo.png';

const APP_NAME = 'KisanBit';
// Mirrors FieldDetailModal.jsx's STATUS_LABEL - duplicated here (not
// imported) for the same reason shareServiceCard takes a pre-resolved
// typeLabel instead of importing SERVICE_TYPES: utils/ shouldn't depend
// on components/.
const CROP_STATUS_LABEL = {
  growing: 'Growing',
  ready_to_harvest: 'Ready to harvest',
  harvested: 'Harvested',
};
// Real logo image drawn into every card's header, replacing the plain
// 🌾 emoji.
const LOGO_URL = logo;
// Fixed 9:16 output for every card, regardless of how much content it
// holds - consistent size in a WhatsApp thread or on the map, whether
// it's a service with two details or a cattle listing with six.
const CARD_WIDTH = 1080;
const CARD_HEIGHT = 1920;

// How long we'll wait for any single image (logo or hero photo) before
// giving up on it and moving on without it.
//
// FIX: loadImage used to have no timeout at all - a slow/hanging network
// request for a Supabase Storage photo (bad signal, server hiccup) meant
// the whole card generation just sat there indefinitely, which is what
// showed up as "share button pressed, takes forever to appear" — the
// card wasn't stuck, the awaited photo load was.
const IMAGE_LOAD_TIMEOUT_MS = 7000;

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // FIX: crossOrigin='anonymous' used to be set unconditionally on
    // EVERY image, including local device photos (localImageUri - a
    // Capacitor capacitor://, file://, content://, or blob: URI). Local
    // schemes don't serve CORS headers at all, and forcing
    // crossOrigin='anonymous' on them made the load fail (or, worse,
    // succeed but leave the canvas tainted so the later toBlob() call
    // threw) unpredictably depending on platform/webview - this is the
    // root cause behind "sometimes the photo just doesn't come" and
    // "sometimes only the text shows up". Only set crossOrigin for an
    // actual http(s) URL (Supabase Storage / any remote photo), which is
    // the only case that both needs it and can serve the right headers.
    if (/^https?:\/\//i.test(url)) {
      img.crossOrigin = 'anonymous';
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error('Image load timed out'));
    }, IMAGE_LOAD_TIMEOUT_MS);
    img.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Image failed to load'));
    };
    img.src = url;
  });
}

// Draws `img` into the (x, y, w, h) box, cropping like CSS `object-fit: cover`.
function drawImageCover(ctx, img, x, y, w, h) {
  const scale = Math.max(w / img.width, h / img.height);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (img.width - sw) / 2;
  const sy = (img.height - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
}

// Word-wraps `text` to fit within maxWidth (at ctx's currently-set font),
// returning at most maxLines lines. If the text doesn't fit in
// maxLines, the last line is truncated with an ellipsis.
//
// ADDED: nothing in this file used to measure text at all - every
// title/subtitle/detail line was drawn as a single fillText call
// regardless of how long it was. That's fine for a short cattle name
// like "Baccha", but shareCropCard's title is
// `${field.name} — ${crop.crop_type}` and its lines can include a full
// free-text `description` (ServiceDetailModal) - both routinely run past
// CARD_WIDTH and were simply drawn off the right edge of the canvas,
// invisible. This is the concrete shape of "one same design doesn't
// work for everything" - cattle/crop/fish/service cards all share this
// one drawCard(), but only cattle's content reliably stays short enough
// to fit undrawn-and-unwrapped.
function wrapLines(ctx, text, maxWidth, maxLines) {
  if (!text) return [];
  const words = String(text).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const lines = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
      if (lines.length === maxLines) break;
    }
  }
  if (lines.length < maxLines && current) lines.push(current);

  // Truncate with an ellipsis if there was more text than maxLines could
  // hold (either words left over, or the last accepted line itself is
  // still too wide because a single word alone overruns maxWidth).
  const consumedWords = lines.join(' ').split(/\s+/).length;
  const truncated = consumedWords < words.length;
  if (truncated || (lines.length && ctx.measureText(lines[lines.length - 1]).width > maxWidth)) {
    let last = lines[lines.length - 1] || '';
    while (last.length > 0 && ctx.measureText(`${last}…`).width > maxWidth) {
      last = last.slice(0, -1);
    }
    lines[lines.length - 1] = `${last}…`;
  }
  return lines;
}

// title: main heading (animal/field name)
// subtitle: secondary line (animal type / crop status)
// photoUrl: optional hero image
// lines: array of detail strings, already fully formatted (no nulls) —
//        caller decides exactly what appears, so it's easy to keep
//        private fields (collar ID, device EUI, etc.) out entirely.
// accentColor: header band color
//
// Always renders onto a fixed CARD_WIDTH x CARD_HEIGHT (9:16) canvas.
// Rather than growing the canvas to fit the content (the old
// behavior), the space *within* the fixed card adapts: the photo band
// takes a fixed share of the body, and detail-line spacing is derived
// from whatever room is left so 2 lines or 8 lines both end up filling
// the same card - never a taller or shorter image.
//
// FIX: this used to draw the photo, then unconditionally call
// canvas.toBlob() at the end - if the photo load "succeeded" but left
// the canvas tainted (a remote image whose host didn't actually send
// CORS headers back, despite crossOrigin='anonymous' being set), toBlob
// throws a SecurityError. That exception was never caught here, so it
// bubbled up as an uncaught crash - the "sometimes it just crashes"
// symptom - instead of the card just quietly finishing without its
// photo like the two `catch (_)` blocks around image loading already
// intend. drawCard now takes an internal `skipPhoto` flag; the exported
// generateCard() below calls it once normally and, only if toBlob
// itself fails, retries once with skipPhoto so the person always gets a
// usable card back instead of a crash.
async function drawCard({ title, subtitle, photoUrl, lines = [], accentColor = '#1f6e46' }, skipPhoto = false) {
  const HEADER_HEIGHT = 130;
  const FOOTER_HEIGHT = 60;
  const PAD_X = 48;
  const MAX_TEXT_WIDTH = CARD_WIDTH - PAD_X * 2;

  const canvas = document.createElement('canvas');
  canvas.width = CARD_WIDTH;
  canvas.height = CARD_HEIGHT;
  const ctx = canvas.getContext('2d');

  // background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);

  // header band with app branding
  ctx.fillStyle = accentColor;
  ctx.fillRect(0, 0, CARD_WIDTH, HEADER_HEIGHT);

  let logoDrawn = false;
  if (LOGO_URL) {
    try {
      const logoImg = await loadImage(LOGO_URL);
      const logoSize = HEADER_HEIGHT - 40;
      drawImageCover(ctx, logoImg, PAD_X, 20, logoSize, logoSize);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 46px sans-serif';
      ctx.fillText(APP_NAME, PAD_X + logoSize + 20, 82);
      logoDrawn = true;
    } catch (_) {
      // logo failed to load (e.g. offline, bad path) - fall through to
      // the emoji+text header below so the card still renders cleanly
    }
  }
  if (!logoDrawn) {
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 46px sans-serif';
    ctx.fillText(`🌾 ${APP_NAME}`, PAD_X, 82);
  }

  // Body = everything between header and footer. Photo (if present)
  // always takes a fixed share of it, so the remaining text area is
  // predictable regardless of whether a photo was supplied.
  const bodyTop = HEADER_HEIGHT;
  const bodyHeight = CARD_HEIGHT - HEADER_HEIGHT - FOOTER_HEIGHT;
  const wantsPhoto = Boolean(photoUrl) && !skipPhoto;
  const PHOTO_HEIGHT = wantsPhoto ? Math.round(bodyHeight * 0.42) : 0;

  let y = bodyTop + 60;
  if (wantsPhoto) {
    try {
      const img = await loadImage(photoUrl);
      drawImageCover(ctx, img, 0, bodyTop, CARD_WIDTH, PHOTO_HEIGHT);
      y = bodyTop + PHOTO_HEIGHT + 70;
    } catch (_) {
      // image failed to load or timed out - just skip it, text area
      // below still reflows to fill the space it would have used
      y = bodyTop + 60;
    }
  }

  // title - wrapped to at most 2 lines instead of a single fillText that
  // could run off the right edge for longer titles (e.g. shareCropCard's
  // "Field Name — Crop Type").
  ctx.fillStyle = '#14213d';
  ctx.font = 'bold 54px sans-serif';
  const titleLines = wrapLines(ctx, title || '', MAX_TEXT_WIDTH, 2);
  for (const line of titleLines) {
    ctx.fillText(line, PAD_X, y);
    y += 58;
  }
  if (titleLines.length === 0) y += 54;

  // subtitle - single line with ellipsis if too long.
  if (subtitle) {
    ctx.font = '32px sans-serif';
    ctx.fillStyle = '#555555';
    y += 44;
    const [subtitleLine] = wrapLines(ctx, subtitle, MAX_TEXT_WIDTH, 1);
    if (subtitleLine) ctx.fillText(subtitleLine, PAD_X, y);
  }
  y += 30;

  // Detail lines get whatever vertical room is left before the
  // footer, spread evenly - so a 2-line card and an 8-line card both
  // use the full remaining height instead of leaving the card looking
  // sparse or overflowing it. Each source line is wrapped to at most 2
  // rendered lines first (a long free-text `description` no longer runs
  // off-canvas), then spacing is computed from the actual rendered line
  // count so wrapped lines don't throw off the "fill the remaining
  // space evenly" math.
  ctx.font = '32px sans-serif';
  const footerY = CARD_HEIGHT - 32;
  const availableForLines = Math.max(footerY - 40 - y, 0);
  const renderLines = lines.flatMap((line) => wrapLines(ctx, line, MAX_TEXT_WIDTH, 2));
  const lineHeight = renderLines.length
    ? Math.min(64, Math.max(38, availableForLines / renderLines.length))
    : 0;
  const fontSize = Math.round(Math.min(34, Math.max(24, lineHeight * 0.6)));

  ctx.font = `${fontSize}px sans-serif`;
  ctx.fillStyle = '#222222';
  y += lineHeight * 0.7;
  for (const line of renderLines) {
    ctx.fillText(line, PAD_X, y);
    y += lineHeight;
  }

  // footer
  ctx.font = 'italic 26px sans-serif';
  ctx.fillStyle = '#888888';
  ctx.fillText(`Shared via ${APP_NAME} app`, PAD_X, footerY);

  // FIX: was 'image/png'. The card's background is always fully opaque
  // (white fillRect at the very top of this function) so there's no
  // transparency to lose - but a PNG of a card with a photo baked in
  // (photographic content, losslessly encoded) can run several MB. That
  // multi-MB blob then gets base64-encoded (+33% size) and pushed through
  // the Capacitor JS<->native bridge in Filesystem.writeFile below - this,
  // not image loading (already capped at 7s above), is what was actually
  // behind "share button takes ~1 minute": the photo loads fine, then the
  // encode+bridge-write of a huge PNG is the slow part. JPEG at 0.85
  // quality is visually indistinguishable for a shared card and typically
  // 5-10x smaller for the same photo content.
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('Canvas toBlob returned null'));
      }, 'image/jpeg', 0.85);
    } catch (err) {
      reject(err);
    }
  });
}

// Generates the card, retrying once without the photo if the first
// attempt fails for any reason (tainted canvas, toBlob failure, etc.) -
// see the FIX note above drawCard. Only if BOTH attempts fail does this
// throw, so callers' existing "Could not create share card" alerts stay
// meaningful instead of firing on every ordinary photo hiccup.
async function generateCard(options) {
  try {
    return await drawCard(options, false);
  } catch (err) {
    if (!options.photoUrl) throw err;
    return drawCard(options, true);
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// How long we'll wait for the local Filesystem write before giving up.
// This is plain local I/O (writing a small file to the app's own cache
// dir) - it should always be near-instant, so a stall here means the
// Capacitor bridge call itself failed to return, not that anything
// legitimate is still happening. FIX: previously unbounded, so a stuck
// bridge call left the share button in "sharing..." forever with no
// error - this is the "sometimes not working" symptom (as opposed to
// "takes forever", which was the JPEG/PNG size issue above). Deliberately
// NOT applied to Share.share() below - that call waits on the user
// actually picking an app in the native share sheet, which can
// legitimately take longer than any fixed timeout.
const FILE_WRITE_TIMEOUT_MS = 15000;

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function shareGeneratedCard(blob, fileName) {
  try {
    const base64Data = await blobToBase64(blob);
    const written = await withTimeout(
      Filesystem.writeFile({
        path: fileName,
        data: base64Data,
        directory: Directory.Cache,
      }),
      FILE_WRITE_TIMEOUT_MS,
      'Saving the card timed out'
    );
    await Share.share({
      title: APP_NAME,
      url: written.uri,
      dialogTitle: 'Share',
    });
  } catch (err) {
    // Capacitor Share/Filesystem missing or failed (e.g. running in a
    // plain browser tab) — fall back to the Web Share API if it can
    // handle file attachments.
    if (navigator.share && navigator.canShare) {
      const file = new File([blob], fileName, { type: 'image/jpeg' });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: APP_NAME });
        return;
      }
    }
    throw err;
  }
}

// Deliberately does NOT include collar_id / tag_deveui — device tracking
// IDs must never appear on a card that gets shared outside the app.
export async function shareCattleCard(cattle) {
  const lines = [];
  if (cattle.breed) lines.push(`Breed: ${cattle.breed}`);
  if (cattle.birthDate || cattle.birth_date) {
    const d = new Date(cattle.birthDate || cattle.birth_date);
    if (!Number.isNaN(d.getTime())) lines.push(`Born: ${d.toLocaleDateString('en-IN')}`);
  }
  if (cattle.salePriceMin != null || cattle.sale_price_min != null) {
    const min = cattle.salePriceMin ?? cattle.sale_price_min;
    const max = cattle.salePriceMax ?? cattle.sale_price_max;
    lines.push(`For sale: ₹${min}${max != null ? ` - ₹${max}` : ''}`);
  }

  const blob = await generateCard({
    title: cattle.name,
    subtitle: cattle.animalType || cattle.animal_type,
    photoUrl: cattle.localImageUri || cattle.marketplacePhotoUrl || cattle.marketplace_photo_url,
    lines,
  });
  await shareGeneratedCard(blob, `${(cattle.name || 'cattle').replace(/\s+/g, '-')}-kisanbit.jpg`);
}

// field: a row from `fields` (needs .name); crop: a row from crops_marketplace.
export async function shareCropCard(field, crop) {
  const lines = [];
  if (crop.harvest_date) {
    lines.push(`Expected: ${new Date(crop.harvest_date).toLocaleDateString('en-IN')}`);
  }
  if (crop.wholesale_price || crop.retail_price) {
    lines.push(
      `${crop.wholesale_price ? `Wholesale ₹${crop.wholesale_price}` : ''}` +
      `${crop.wholesale_price && crop.retail_price ? ' · ' : ''}` +
      `${crop.retail_price ? `Retail ₹${crop.retail_price}` : ''}`
    );
  }
  if (crop.expected_yield_kg != null) lines.push(`Expected yield: ${crop.expected_yield_kg} kg`);

  const blob = await generateCard({
    title: `${field.name} — ${crop.crop_type}`,
    subtitle: crop.status,
    photoUrl: crop.image_url,
    lines,
    accentColor: '#DEA03B',
  });
  await shareGeneratedCard(blob, `${(field.name || 'field').replace(/\s+/g, '-')}-${(crop.crop_type || 'crop').replace(/\s+/g, '-')}-kisanbit.jpg`);
}

// field: a row from `fields` (needs .name); crops: the field's CURRENT
// (non-harvested) crops_marketplace rows - caller decides what "current"
// means, same as shareServiceCard/shareCropCard's "caller decides exactly
// what appears" convention.
//
// ADDED: FieldDetailModal used to give each crop its own share button
// (shareCropCard, one (field, crop) pair at a time), so a field with
// Grass + Munga produced two separate share images. A farmer sharing
// "Khammam field" wants ONE image with all of it, the way the field
// itself reads in the app - this is that card. Reuses the same
// drawCard() layout as every other card (fixed 9:16, wrapped lines) by
// flattening each crop into 1-2 detail lines rather than inventing a
// new per-card layout - "same design," just fed a longer `lines` list.
export async function shareFieldCard(field, crops = []) {
  const lines = [];
  for (const crop of crops) {
    const statusLabel = CROP_STATUS_LABEL[crop.status] || crop.status;
    lines.push(`${crop.crop_type}${statusLabel ? ` · ${statusLabel}` : ''}`);
    const priceParts = [];
    if (crop.wholesale_price) priceParts.push(`Wholesale ₹${crop.wholesale_price}`);
    if (crop.retail_price) priceParts.push(`Retail ₹${crop.retail_price}`);
    if (priceParts.length) lines.push(priceParts.join(' · '));
  }

  // Same "first crop with a photo" hero rule FieldDetailModal already
  // uses for its own on-screen hero strip (heroPhoto in that file) -
  // keeps the shared card matching what's on screen.
  const heroPhoto = crops.find((c) => c.image_url)?.image_url || null;

  const blob = await generateCard({
    title: field.name,
    subtitle: crops.length === 1
      ? `${crops[0].crop_type}${CROP_STATUS_LABEL[crops[0].status] ? ` · ${CROP_STATUS_LABEL[crops[0].status]}` : ''}`
      : `${crops.length} current crops`,
    photoUrl: heroPhoto,
    lines,
    accentColor: '#DEA03B',
  });
  await shareGeneratedCard(blob, `${(field.name || 'field').replace(/\s+/g, '-')}-kisanbit.jpg`);
}

// pond: a row shaped like PondDetailModal's `pond` prop (needs .pondName);
// fishStock: the pond's LISTED fish-stock rows - caller decides what
// "listed" means, same "caller decides exactly what appears" convention
// as shareFieldCard's crops param.
//
// ADDED: PondDetailModal used to give each fish-stock entry its own share
// button (shareFishCard, one (pond, fish) pair at a time) - a pond with
// Catla + Rohu both listed produced two separate share images. Same fix
// as shareFieldCard: one image covering everything currently listed on
// the pond, instead of one per fish. Reuses drawCard() the same way -
// each fish flattens into 1-2 detail lines rather than a new layout.
export async function sharePondCard(pond, fishStock = []) {
  const lines = [];
  for (const fish of fishStock) {
    lines.push(`${fish.fish_species}${fish.quantity != null ? ` · ${fish.quantity}` : ''}`);
    const priceParts = [];
    if (fish.price_per_kg != null) priceParts.push(`₹${fish.price_per_kg}/kg`);
    if (fish.average_weight_kg != null) priceParts.push(`Avg ${fish.average_weight_kg} kg`);
    if (priceParts.length) lines.push(priceParts.join(' · '));
  }

  // Same "first entry with a photo" hero rule shareFieldCard uses.
  const heroPhoto = fishStock.find((f) => f.image_url)?.image_url || null;

  const blob = await generateCard({
    title: pond.pondName,
    subtitle: fishStock.length === 1 ? fishStock[0].fish_species : `${fishStock.length} fish listed`,
    photoUrl: heroPhoto,
    lines,
    accentColor: '#2B3A61',
  });
  await shareGeneratedCard(blob, `${(pond.pondName || 'pond').replace(/\s+/g, '-')}-kisanbit.jpg`);
}

// pond: a row shaped like PondDetailModal's `pond` prop (needs .pondName /
// .waterSource); fish: one entry from pond.fishStock. Mirrors
// shareCropCard's (field, crop) pairing — a Pond has multiple sellable
// fish-stock children just like a Field has multiple Crops, so callers
// share one fish listing at a time, not the whole pond.
// Deliberately does NOT include internal fields (notes, owner contact,
// unlisted stock) — only what a buyer-facing card should show.
export async function shareFishCard(pond, fish) {
  const lines = [];
  if (fish.quantity != null) lines.push(`Quantity: ${fish.quantity}`);
  if (fish.average_weight_kg != null) lines.push(`Avg weight: ${fish.average_weight_kg} kg`);
  if (fish.price_per_kg != null) lines.push(`Price: ₹${fish.price_per_kg}/kg`);
  if (fish.expected_harvest_date) {
    const d = new Date(fish.expected_harvest_date);
    if (!Number.isNaN(d.getTime())) lines.push(`Expected harvest: ${d.toLocaleDateString('en-IN')}`);
  }

  const blob = await generateCard({
    title: `${pond.pondName} — ${fish.fish_species}`,
    subtitle: pond.waterSource,
    photoUrl: fish.image_url,
    lines,
    accentColor: '#2B3A61',
  });
  await shareGeneratedCard(
    blob,
    `${(pond.pondName || 'pond').replace(/\s+/g, '-')}-${(fish.fish_species || 'fish').replace(/\s+/g, '-')}-kisanbit.jpg`
  );
}

// service: pass through ServiceDetailModal's own destructured fields
// (serviceName, equipmentModel, description, priceAmount, priceUnit,
// placeName, photoUrl) plus typeLabel (the SERVICE_TYPES label the
// caller already resolved - kept out of this file so utils/ doesn't
// need to import from components/).
export async function shareServiceCard(service) {
  const { serviceName, typeLabel, equipmentModel, description, priceAmount, priceUnit, placeName, photoUrl } = service;

  const lines = [];
  if (placeName) lines.push(`Place: ${placeName}`);
  if (typeLabel) lines.push(`Service: ${typeLabel}`);
  if (equipmentModel) lines.push(`Model: ${equipmentModel}`);
  if (priceAmount != null) lines.push(`Cost: ₹${priceAmount}${priceUnit ? ` / ${priceUnit}` : ''}`);
  if (description) lines.push(description);

  const blob = await generateCard({
    title: serviceName,
    subtitle: typeLabel,
    photoUrl,
    lines,
    accentColor: '#2B3A61',
  });
  await shareGeneratedCard(blob, `${(serviceName || 'service').replace(/\s+/g, '-')}-kisanbit.jpg`);
}
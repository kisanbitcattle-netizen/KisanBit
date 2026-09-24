// src/utils/imageCompression.js
//
// Single shared image-compression core, used by both utils/imageUpload.js
// (browser <input type="file"> flow) and services/imageService.js
// (Capacitor native Camera flow). Previously each had its own separate
// canvas/quality-stepping implementation that could silently drift out
// of sync with each other - same job, two codepaths.
//
// Format: prefers WebP (meaningfully smaller than JPEG at equivalent
// visual quality) but falls back to JPEG automatically wherever WebP
// ENCODING isn't actually supported - notably iOS's WKWebView
// (Capacitor's iOS webview is Safari-based, and Safari has long
// supported WebP DEcoding but not reliable canvas.toBlob() WebP
// ENcoding; calling toBlob with 'image/webp' there commonly silently
// produces a PNG instead, which is much LARGER than JPEG and defeats
// the entire point of compressing). This module feature-detects real
// WebP encode support once per session (cached) and picks the right
// format automatically - callers don't need to know or care which
// format they got, only that the result is under budget. The final
// blob's own `.type` tells the caller what format it actually is, so
// upload code (uploadCompressedAsset / uploadForMarketplaceListing)
// derives the file extension from that rather than assuming.

let webpSupportPromise = null;

function detectWebpEncodingSupport() {
  if (webpSupportPromise) return webpSupportPromise;
  webpSupportPromise = new Promise((resolve) => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 1;
      canvas.height = 1;
      canvas.toBlob((blob) => resolve(!!blob && blob.type === 'image/webp'), 'image/webp');
    } catch {
      resolve(false);
    }
  });
  return webpSupportPromise;
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
}

/// Draws `img` onto a canvas capped at maxDimension on its longest
/// side, then steps quality down (0.8 -> 0.2) until the blob is under
/// targetKB, or the quality floor is hit and dimensions are shrunk
/// instead (whichever gets there first - at the floor, whatever size
/// results is accepted rather than degrading further into unusable
/// image quality).
export async function compressImageElement(img, { targetKB = 80, maxDimension = 640 } = {}) {
  const useWebp = await detectWebpEncodingSupport();
  const mimeType = useWebp ? 'image/webp' : 'image/jpeg';

  let width = img.width;
  let height = img.height;
  if (width > maxDimension || height > maxDimension) {
    const scale = maxDimension / Math.max(width, height);
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }

  const targetBytes = targetKB * 1024;
  let quality = 0.8;
  let blob = null;

  for (let attempt = 0; attempt < 8; attempt++) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(img, 0, 0, width, height);

    // eslint-disable-next-line no-await-in-loop
    blob = await canvasToBlob(canvas, mimeType, quality);
    if (!blob || blob.size <= targetBytes) break;

    if (quality > 0.2) {
      quality -= 0.1;
    } else {
      width = Math.round(width * 0.85);
      height = Math.round(height * 0.85);
    }
  }

  return blob;
}

export function loadImageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = dataUrl;
  });
}
// src/utils/imageUpload.js
//
// Shared helpers for compressing photos client-side before they ever
// touch Supabase, and uploading the result to Storage.
//
// IMPORTANT: never store a raw base64 data URL directly in a database
// column (e.g. `local_image_path: reader.result`). A Storage-hosted file
// gets downloaded once and cached by the browser; a base64 blob sitting
// in a DB column gets re-transferred in FULL, every single time any
// query selects that column — this was the cause of a 343%-over-quota
// egress bill from a small project. Always compress + upload to
// Storage, and store only the resulting (short) URL string in the DB.

import { supabase } from '../config/supabaseClient';
import { compressImageElement, loadImageFromDataUrl } from './imageCompression';

// Compresses an image file down to roughly `targetKB`, capping its
// longest side at `maxDimension` px. Format (WebP where supported,
// JPEG fallback otherwise) is decided by the shared compressor - see
// imageCompression.js for why that decision can't just be "always WebP."
export async function compressImageToTargetKB(file, targetKB = 40, maxDimension = 640) {
  const dataUrl = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const img = await loadImageFromDataUrl(dataUrl);
  return compressImageElement(img, { targetKB, maxDimension });
}

// Uploads a (already-compressed) file/blob to the given bucket and
// returns its public URL — the thing that should actually go in the DB.
export async function uploadCompressedAsset(fileOrBlob, bucket, fileNamePrefix) {
  if (!fileOrBlob) return null;
  const ext = (fileOrBlob.type && fileOrBlob.type.split('/')[1]) || 'jpg';
  const path = `${fileNamePrefix}-${Date.now()}.${ext}`;
  const { error } = await supabase.storage.from(bucket).upload(path, fileOrBlob, { upsert: true });
  if (error) throw error;
  const { data } = supabase.storage.from(bucket).getPublicUrl(path);
  return data.publicUrl;
}
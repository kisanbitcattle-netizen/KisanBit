// src/services/imageService.js
//
// Local-first image strategy using Capacitor's native Camera and
// Filesystem plugins:
//   1. Photos are captured/picked and saved to app-private device
//      storage FIRST, at full quality — never touching Supabase by
//      default, and always available for fast local map-marker use.
//   2. Only when a farmer flips the "Sell" toggle for that cattle/crop
//      is a compressed copy uploaded to Supabase Storage — compressed
//      as small as possible (target: well under 100KB) since Storage
//      quota is limited and this is display-only, not archival quality.

import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { supabase } from '../config/supabaseClient';

const LOCAL_PHOTO_DIR = 'kisanbit_photos';
const MAX_UPLOAD_KB = 80; // target comfortably under the 100KB ceiling
const MAX_UPLOAD_DIMENSION = 640; // px, longest side

/// Step 1 — capture/pick a photo and persist it ONLY on-device, at
/// full camera quality. Returns a local file URI to store in
/// cattle.local_image_path (or the equivalent crop field).
export async function pickAndSaveLocally(entityId) {
  const photo = await Camera.getPhoto({
    resultType: CameraResultType.Base64,
    source: CameraSource.Prompt,
    quality: 90,
  });

  const fileName = `${LOCAL_PHOTO_DIR}/${entityId}_${Date.now()}.jpg`;

  await Filesystem.writeFile({
    path: fileName,
    data: photo.base64String,
    directory: Directory.Data,
    recursive: true,
  });

  const { uri } = await Filesystem.getUri({ path: fileName, directory: Directory.Data });
  return uri;
}

function loadImageFromBase64(base64String) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = `data:image/jpeg;base64,${base64String}`;
  });
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/// Resizes to at most MAX_UPLOAD_DIMENSION on the longest side, then
/// steps JPEG quality down (0.8 -> 0.2) until the blob is under
/// MAX_UPLOAD_KB, or the quality floor is hit (whichever comes first —
/// at the floor we accept whatever size results rather than degrading
/// further into unusable image quality).
async function compressForUpload(base64String) {
  const img = await loadImageFromBase64(base64String);

  let { width, height } = img;
  if (width > height && width > MAX_UPLOAD_DIMENSION) {
    height = Math.round((height * MAX_UPLOAD_DIMENSION) / width);
    width = MAX_UPLOAD_DIMENSION;
  } else if (height > MAX_UPLOAD_DIMENSION) {
    width = Math.round((width * MAX_UPLOAD_DIMENSION) / height);
    height = MAX_UPLOAD_DIMENSION;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(img, 0, 0, width, height);

  let quality = 0.8;
  let blob = await canvasToBlob(canvas, quality);

  while (blob.size > MAX_UPLOAD_KB * 1024 && quality > 0.2) {
    quality -= 0.1;
    blob = await canvasToBlob(canvas, quality);
  }

  return blob;
}

/// Step 2 — call this ONLY when the user toggles "List on Marketplace".
/// Reads the local file, compresses it aggressively, uploads the
/// compressed copy to Supabase Storage, and returns the public URL.
export async function uploadForMarketplaceListing({ localFileUri, entityId, bucket }) {
  const fileData = await Filesystem.readFile({ path: localFileUri });
  const compressedBlob = await compressForUpload(fileData.data);

  const storagePath = `${entityId}/${Date.now()}.jpg`;

  const { error } = await supabase.storage.from(bucket).upload(storagePath, compressedBlob, {
    contentType: 'image/jpeg',
    upsert: true,
  });

  if (error) throw error;

  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  return data.publicUrl;
}

export async function removeMarketplaceCopy({ bucket, storagePath }) {
  const { error } = await supabase.storage.from(bucket).remove([storagePath]);
  if (error) throw error;
}

export async function deleteLocalCopy(localFileUri, relativePath) {
  await Filesystem.deleteFile({ path: relativePath, directory: Directory.Data });
}
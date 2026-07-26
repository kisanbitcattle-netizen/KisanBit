// src/services/imageService.js
//
// Local-first image strategy using Capacitor's native Camera and
// Filesystem plugins:
//   1. Photos are captured/picked and saved to app-private device
//      storage FIRST — never touching Supabase by default.
//   2. Only when a farmer flips the "Sell" toggle for that cattle/crop
//      is a compressed copy uploaded to Supabase Storage.

import { Camera, CameraResultType, CameraSource } from '@capacitor/camera';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { supabase } from '../config/supabaseClient';

const LOCAL_PHOTO_DIR = 'kisanbit_photos';

/// Step 1 — capture/pick a photo and persist it ONLY on-device.
/// Returns a local file URI to store in cattle.local_image_path
/// (or the equivalent crop field). Nothing is uploaded here.
export async function pickAndSaveLocally(entityId) {
  const photo = await Camera.getPhoto({
    resultType: CameraResultType.Base64,
    source: CameraSource.Prompt, // lets user choose camera or gallery
    quality: 90,
  });

  const fileName = `${LOCAL_PHOTO_DIR}/${entityId}_${Date.now()}.jpg`;

  await Filesystem.writeFile({
    path: fileName,
    data: photo.base64String,
    directory: Directory.Data, // app-private storage, not shared/public
    recursive: true,
  });

  const { uri } = await Filesystem.getUri({
    path: fileName,
    directory: Directory.Data,
  });

  return uri; // save this into local_image_path
}

/// Step 2 — call this ONLY when the user toggles "List on Marketplace".
/// Reads the local file, uploads it (already reasonably compressed by
/// the camera quality setting above) to Supabase Storage, and returns
/// the public URL to store in marketplace_photo_url.
export async function uploadForMarketplaceListing({ localFileUri, entityId, bucket }) {
  const fileData = await Filesystem.readFile({ path: localFileUri });

  const byteCharacters = atob(fileData.data);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const blob = new Blob([new Uint8Array(byteNumbers)], { type: 'image/jpeg' });

  const storagePath = `${entityId}/${Date.now()}.jpg`;

  const { error } = await supabase.storage.from(bucket).upload(storagePath, blob, {
    contentType: 'image/jpeg',
    upsert: true,
  });

  if (error) throw error;

  const { data } = supabase.storage.from(bucket).getPublicUrl(storagePath);
  return data.publicUrl;
}

/// When a listing is un-toggled, remove the uploaded copy from
/// Supabase Storage to reclaim free-tier quota. Local device photo
/// is left untouched.
export async function removeMarketplaceCopy({ bucket, storagePath }) {
  const { error } = await supabase.storage.from(bucket).remove([storagePath]);
  if (error) throw error;
}

/// Deletes the local device copy (e.g. animal/crop removed entirely).
export async function deleteLocalCopy(localFileUri, relativePath) {
  await Filesystem.deleteFile({
    path: relativePath,
    directory: Directory.Data,
  });
}

// src/services/offlineSync.js
import { supabase } from '../config/supabaseClient';

// 1. స్థానికంగా మార్పులను సేవ్ చేయడం (Offline Save)
export const saveFieldUpdateOffline = (fieldData) => {
  // పాత పెండింగ్ లిస్ట్ తెచ్చుకోవడం
  const pending = JSON.parse(localStorage.getItem('kb_pending_fields') || '[]');
  
  // కొత్త మార్పును ఆరేలో చేర్చడం
  pending.push({ ...fieldData, updated_at: new Date().toISOString() });
  
  localStorage.setItem('kb_pending_fields', JSON.stringify(pending));
};

// 2. నెట్ వచ్చినప్పుడు సర్వర్ కి ఒకేసారి పంపడం (Single Push API Call)
export const syncPendingUpdatesWithSupabase = async () => {
  if (!navigator.onLine) return; // నెట్ లేకపోతే ఆగిపోతుంది

  const pending = JSON.parse(localStorage.getItem('kb_pending_fields') || '[]');
  if (pending.length === 0) return;

  try {
    console.log('Pushing offline data to Supabase...', pending);

    // ఒకేసారి అన్ని మార్పులను అప్‌డేట్ చేయడానికి Upsert/Bulk Call
    const { error } = await supabase.from('fields').upsert(pending);

    if (!error) {
      // సక్సెస్ అయితే పెండింగ్ క్యూ ని క్లియర్ చేయడం
      localStorage.removeItem('kb_pending_fields');
      console.log('Sync completed successfully!');
    } else {
      // Previously silently swallowed here - a failed sync looked
      // identical to "nothing was pending." The queue is deliberately
      // NOT cleared on error (so it retries on the next 'online' event
      // or app open), but at least log why it's stuck.
      console.error('[offlineSync] upsert failed, will retry next time online:', error.message, error.details, error.hint, error.code);
    }
  } catch (err) {
    console.error('Sync failed:', err);
  }
};

// 3. ఫోన్ ఆన్‌లైన్ రాగానే ఆటోమేటిక్‌గా రన్ అయ్యే లిజనర్
window.addEventListener('online', () => {
  syncPendingUpdatesWithSupabase();
});
// src/config/supabaseClient.js
//
// Central Supabase client. Fill in your project URL and anon key
// from Supabase Dashboard -> Settings -> API.
//
// IMPORTANT: never commit real keys to git. Use a .env file instead
// (see .env.example) and add .env to .gitignore.

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  console.warn(
    'Supabase URL/Anon Key missing. Add them to a .env file as ' +
    'VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

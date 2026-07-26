// src/services/voiceService.js
//
// Zero-cost voice UI using the browser/WebView's native Web Speech API
// (works inside a Capacitor WebView on Android via the system speech
// recognizer — no paid cloud STT/NLU). Matches recognized Telugu text
// against simple keyword patterns to resolve farmer intents.

import { supabase } from '../config/supabaseClient';

export const VoiceIntent = {
  FIND_ANIMAL: 'findAnimal',
  CROP_PRICE: 'cropPrice',
  UNKNOWN: 'unknown',
};

const ANIMAL_KEYWORDS = {
  'గేదె': 'buffalo',
  'ఆవు': 'cow',
  'మేక': 'goat',
  'గొర్రె': 'sheep',
};

const CROP_KEYWORDS = {
  'వరి': 'paddy',
  'మొక్కజొన్న': 'maize',
  'మిర్చి': 'chilli',
};

const LOCATION_TRIGGERS = ['ఎక్కడ', 'ఎక్కడుంది', 'ఎక్కడ ఉంది'];
const PRICE_TRIGGERS = ['రేటు', 'ధర', 'ఎంత'];

function findFirstMatch(text, keywordMap) {
  for (const [key, value] of Object.entries(keywordMap)) {
    if (text.includes(key)) return value;
  }
  return null;
}

function parseIntent(text) {
  const animalMatch = findFirstMatch(text, ANIMAL_KEYWORDS);
  const cropMatch = findFirstMatch(text, CROP_KEYWORDS);
  const hasLocationTrigger = LOCATION_TRIGGERS.some((kw) => text.includes(kw));
  const hasPriceTrigger = PRICE_TRIGGERS.some((kw) => text.includes(kw));

  if (animalMatch && hasLocationTrigger) {
    return { intent: VoiceIntent.FIND_ANIMAL, rawText: text, animalType: animalMatch };
  }
  if (cropMatch && hasPriceTrigger) {
    return { intent: VoiceIntent.CROP_PRICE, rawText: text, cropType: cropMatch };
  }
  return { intent: VoiceIntent.UNKNOWN, rawText: text };
}

/// Starts listening once and resolves with the parsed command.
/// Requires the Android WebView to support SpeechRecognition (Chrome
/// WebView on modern Android does); wrap calls in try/catch.
export function listenAndParse({ lang = 'te-IN' } = {}) {
  return new Promise((resolve, reject) => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      reject(new Error('Speech recognition not supported on this device/browser.'));
      return;
    }

    const recognizer = new SpeechRecognition();
    recognizer.lang = lang;
    recognizer.continuous = false;
    recognizer.interimResults = false;

    recognizer.onresult = (event) => {
      const transcript = event.results[0][0].transcript;
      resolve(parseIntent(transcript));
    };

    recognizer.onerror = (event) => {
      reject(new Error(`Speech recognition error: ${event.error}`));
    };

    recognizer.start();
  });
}

/// Executes the resolved intent against Supabase and returns a
/// human-readable Telugu answer string for display/TTS.
export async function resolveAndAnswer(result) {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return 'దయచేసి లాగిన్ అవ్వండి.'; // "Please log in"

  if (result.intent === VoiceIntent.FIND_ANIMAL) {
    const { data, error } = await supabase
      .from('cattle')
      .select('name, live_location')
      .eq('owner_id', user.id)
      .eq('animal_type', result.animalType)
      .limit(1);

    if (error || !data || data.length === 0) return 'జంతువు కనబడలేదు.';
    return `${data[0].name} మీ ఇంటి సమీపంలో ఉంది.`;
  }

  if (result.intent === VoiceIntent.CROP_PRICE) {
    const { data, error } = await supabase
      .from('crops_marketplace')
      .select('market_price')
      .eq('crop_type', result.cropType)
      .order('created_at', { ascending: false })
      .limit(1);

    if (error || !data || data.length === 0) return 'ధర సమాచారం లేదు.';
    return `ప్రస్తుత రేటు: ₹${data[0].market_price}`;
  }

  return 'క్షమించండి, అర్థం కాలేదు.';
}

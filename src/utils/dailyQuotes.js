// src/utils/dailyQuotes.js
//
// Small local set of Telugu farming advisory quotes/tips. Picked
// deterministically by day-of-year so it's the same all day and
// changes daily, no network call needed.

const QUOTES = [
  { te: 'వర్షం పడే ముందు పశువులను షెడ్‌కు తరలించండి.', en: 'Move cattle to shelter before expected rain.' },
  { te: 'ఉదయం చల్లని వేళల్లో పశువులను మేపడం మంచిది.', en: 'Early morning grazing is best in cool hours.' },
  { te: 'నీటి తొట్టెను ప్రతిరోజు శుభ్రం చేయండి.', en: 'Clean the water trough daily for herd health.' },
  { te: 'ఎండ ఎక్కువగా ఉన్నప్పుడు నీడలో విశ్రాంతి ఇవ్వండి.', en: 'Give shade rest during peak sun hours.' },
  { te: 'పంట కోతకు ముందు మార్కెట్ ధరలు చూసుకోండి.', en: 'Check market rates before harvest.' },
  { te: 'పాడి పశువులకు సమతుల్య ఆహారం ముఖ్యం.', en: 'Balanced feed matters most for dairy cattle.' },
  { te: 'జీవాల ఆరోగ్యం కోసం వారానికోసారి వెటర్నరీ చెక్ చేయించండి.', en: 'Get a weekly vet check for herd health.' },
];

export function getTodaysQuote() {
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0)) / 86400000
  );
  return QUOTES[dayOfYear % QUOTES.length];
}

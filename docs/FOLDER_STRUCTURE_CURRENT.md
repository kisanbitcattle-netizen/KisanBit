# KisanBit (React + Capacitor) — Complete Folder Structure

Ee structure ippativaraku ichina ANNI files కి సరిపోతుంది. మీ
`KisanBit` project root లో ఇలా ఉండాలి:

```
KisanBit/
├── .env                          ← create this yourself (copy .env.example, fill real keys)
├── .env.example                  ✅ ఇచ్చాను
├── pubspec.yaml                  ❌ DELETE — ఇది Flutter file, ఇప్పుడు అవసరం లేదు
├── package.json                  (auto-created by npm/vite)
├── vite.config.js                (auto-created)
│
├── public/
│   └── assets/
│       └── branding/
│           └── kisanbit-logo.png ✅ ఇచ్చాను
│
├── src/
│   ├── App.jsx                   ✅ ఇచ్చాను (latest version — replace)
│   ├── App.css                   ✅ ఇచ్చాను (latest version — replace)
│   ├── main.jsx                  (auto-created by Vite — DON'T touch)
│   │
│   ├── config/
│   │   └── supabaseClient.js     ✅ ఇచ్చాను
│   │
│   ├── screens/
│   │   ├── HomeScreen.jsx        ✅ ఇచ్చాను
│   │   ├── ProfileScreen.jsx     ✅ ఇచ్చాను (latest version — replace)
│   │   └── MapScreen.jsx         ⚠️ OLD/unused now — HomeScreen.jsx replaced it.
│   │                               Safe to delete, or keep unused.
│   │
│   ├── components/
│   │   ├── Header.jsx            ✅ ఇచ్చాను
│   │   ├── MapPreviewCard.jsx    ✅ ఇచ్చాను (latest version — replace, this is the hero card)
│   │   ├── FullMapModal.jsx      ✅ ఇచ్చాను (full-screen map + trail + share)
│   │   ├── GeofenceSetupModal.jsx ✅ ఇచ్చాను
│   │   ├── MarketplaceModal.jsx  ✅ ఇచ్చాను (buyer cart/bucket)
│   │   ├── CattleMarker.jsx      ✅ ఇచ్చాను
│   │   ├── CattleCard.jsx        ✅ ఇచ్చాను
│   │   ├── CattleInfoPanel.jsx   ✅ ఇచ్చాను (latest version — replace, uses CattleCard now)
│   │   ├── FieldCard.jsx         ✅ ఇచ్చాను
│   │   └── WeatherCard.jsx       ✅ ఇచ్చాను (latest version — replace)
│   │
│   ├── services/
│   │   ├── imageService.js       ✅ ఇచ్చాను
│   │   ├── voiceService.js       ✅ ఇచ్చాను
│   │   ├── shareCardService.js   ✅ ఇచ్చాను (trail share, used by FullMapModal)
│   │   └── heroShareService.js   ✅ ఇచ్చాను (home hero card share, used by MapPreviewCard)
│   │
│   └── utils/
│       └── dailyQuotes.js        ✅ ఇచ్చాను
│
└── supabase/
    ├── schema_complete.sql       ✅ RUN THIS ONE (has everything — tables, RLS, history)
    └── schema_addendum_location_history.sql   ⚠️ redundant now — already inside
                                                  schema_complete.sql, don't run separately
```

## Cheyaalsina pani (step by step)

1. **`pubspec.yaml` delete cheyandi** — idi Flutter file, React project ki avasaram ledu, confusion create chesthundi.
2. **`src/screens/MapScreen.jsx` delete cheyochu** — `HomeScreen.jsx` దాన్ని replace chesindi, ippudu use avvatledu app.jsx nunchi.
3. **`schema_addendum_location_history.sql` run cheyakandi separately** — ఆ table already `schema_complete.sql` లో ఉంది. Rెండూ run chesthe "table already exists" error vasthundi.
4. Migతా అన్ని ✅ marked files — ivi already meeru pettina folders lo unnayi kada? Okasari check cheyandi, ala unte sare, లేకపోతే ఇచ్చిన path prakaram pettandi.

## Quick sanity check command (VS Code terminal)

```powershell
cd \Users\seetaram\documents\KisanBit
tree /F src
```

Ide run chesi output naaku pettandi — ఏదైనా file miss ayindo, wrong place lo pettaro nenu chusi cheputha.

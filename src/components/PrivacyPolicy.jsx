// src/screens/PrivacyPolicy.jsx (or src/components/, wherever your other
// screens live — move as needed)
//
// DRAFT — first pass, written per user's answers on 2026-08-06:
//   - Contact: both email AND phone/WhatsApp shown (placeholders below,
//     REPLACE BOTH before shipping — search for "REPLACE_ME")
//   - Bilingual: Telugu + English, stacked per section (same te/en
//     pattern already used for dailyQuotes.js)
//   - Alert tiers: confirmed a third-party SMS/voice call provider is
//     used for paid Tier 2/Tier 3 alerts — provider NOT named yet
//     (user didn't specify), so this uses generic wording ("a
//     third-party SMS/voice call provider") rather than a real vendor
//     name. REPLACE if you want the actual provider named specifically
//     (recommended — most SMS/voice APIs require you to disclose them
//     by name in your privacy policy under their own ToS).
//
// This is a DRAFT — legal-adjacent content, please review/edit before
// treating this as your actual published policy. Sections are based on
// what's actually confirmed live in this app (cattle GPS, geofencing,
// field boundaries, crop marketplace, images, contact info) — not
// generic boilerplate for features KisanBit doesn't have.
//
// Last updated date below is a placeholder — update it whenever the
// policy content actually changes.

const LAST_UPDATED = 'REPLACE_ME_DATE'; // e.g. 'August 6, 2026'
const CONTACT_EMAIL = 'REPLACE_ME@example.com';
const CONTACT_PHONE = 'REPLACE_ME_+91XXXXXXXXXX';

function Section({ te, en }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <p style={{ fontSize: 14, fontWeight: 600, color: 'var(--color-ink)', marginBottom: 4 }}>{te}</p>
      <p style={{ fontSize: 13, color: 'var(--color-muted)', lineHeight: 1.5 }}>{en}</p>
    </div>
  );
}

function Heading({ children }) {
  return (
    <h3
      className="display-text"
      style={{ fontSize: 15, color: 'var(--color-navy)', marginTop: 24, marginBottom: 10 }}
    >
      {children}
    </h3>
  );
}

export default function PrivacyPolicy({ onClose }) {
  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: 16,
        background: 'var(--color-bg)',
        color: 'var(--color-ink)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
        <h2 className="display-text" style={{ fontSize: 18, color: 'var(--color-ink)' }}>
          Privacy Policy · గోప్యతా విధానం
        </h2>
        {onClose && (
          <button
            onClick={onClose}
            style={{ border: 'none', background: 'none', color: 'var(--color-muted)', fontSize: 20, padding: 4 }}
            aria-label="Close"
          >
            ×
          </button>
        )}
      </div>

      <p style={{ fontSize: 12, color: 'var(--color-muted)', marginBottom: 16 }}>
        Last updated: {LAST_UPDATED}
      </p>

      <Section
        te="ఈ గోప్యతా విధానం KisanBit యాప్‌ను ఉపయోగించే రైతులు మరియు కొనుగోలుదారులకు వర్తిస్తుంది. మేము మీ డేటాను ఎలా సేకరిస్తాము, ఉపయోగిస్తాము మరియు రక్షిస్తాము అని ఇది వివరిస్తుంది."
        en="This Privacy Policy applies to farmers and buyers using the KisanBit app. It explains what data we collect, how we use it, and how we protect it."
      />

      <Heading>1. Information We Collect · మేము సేకరించే సమాచారం</Heading>

      <Section
        te="పశువుల డేటా: మీరు నమోదు చేసే ప్రతి పశువు కోసం పేరు, జాతి, పుట్టిన తేదీ, బరువు, ఫోటోలు, మరియు GoTag కాలర్ ఉంటే దాని లొకేషన్ డేటాను మేము నిల్వ చేస్తాము."
        en="Cattle data: for each animal you register, we store its name, animal type/breed, birth date, weight, photos, and — if it has a GoTag collar — live GPS location and geofence settings."
      />
      <Section
        te="పొలం డేటా: మీరు గీసే పొలం సరిహద్దులు (GPS పాలిగాన్‌లు), నేల ఆరోగ్య డేటా (N-P-K మరియు pH), మరియు పంట వివరాలు నిల్వ చేయబడతాయి."
        en="Field data: field boundaries you draw (GPS polygons), soil health data (N-P-K and pH readings), and crop listing details are stored."
      />
      <Section
        te="ప్రొఫైల్ మరియు సంప్రదింపు సమాచారం: మీ ఫోన్ నంబర్, WhatsApp నంబర్, గ్రామం మరియు — మీరు అమ్మకానికి పెడితే — కొనుగోలుదారులకు కనిపించే సంప్రదింపు వివరాలు."
        en="Profile and contact info: your phone number, WhatsApp number, village, and — if you list an animal or crop for sale — contact details shown to potential buyers."
      />
      <Section
        te="లొకేషన్ డేటా: పశువు GPS లొకేషన్, జియోఫెన్స్ కేంద్రం మరియు వ్యాసార్థం, మరియు మీరు యాప్ ఉపయోగించే సాధారణ ప్రాంతం (వాతావరణం చూపించడానికి)."
        en="Location data: cattle GPS position, geofence center and radius, and your general area (used to show local weather)."
      />

      <Heading>2. How We Use This Information · మేము దీన్ని ఎలా ఉపయోగిస్తాము</Heading>
      <Section
        te="మీ పశువు జియోఫెన్స్ నుండి బయటకు వెళ్తే మిమ్మల్ని హెచ్చరించడానికి; మీ పొలాలు, పశువులు మరియు పంటలను మ్యాప్‌లో చూపించడానికి; అమ్మకానికి పెట్టిన జాబితాలను కొనుగోలుదారులకు చూపించడానికి; స్థానిక వాతావరణ సమాచారం అందించడానికి."
        en="To alert you when your cattle leave a geofenced area; to display your fields, cattle, and crops on the map; to show your sale listings to buyers; to provide local weather information."
      />

      <Heading>3. Who We Share Data With · మేము ఎవరితో డేటా పంచుకుంటాము</Heading>
      <Section
        te="Supabase: మా బ్యాకెండ్ మరియు డేటాబేస్ ప్రొవైడర్. మీ డేటా అంతా Supabase సర్వర్లలో నిల్వ చేయబడుతుంది."
        en="Supabase: our backend and database provider. All your app data is stored on Supabase's servers."
      />
      <Section
        te="OpenStreetMap: మ్యాప్ టైల్స్ కోసం ఉపయోగించబడుతుంది. మ్యాప్ చూసేటప్పుడు మీ సాధారణ లొకేషన్ OpenStreetMap సర్వర్లకు పంపబడవచ్చు."
        en="OpenStreetMap: used to display map tiles. Your general viewing area may be sent to OpenStreetMap's servers when you view the map."
      />
      <Section
        te="మూడవ పక్ష SMS/కాల్ ప్రొవైడర్: మీరు పెయిడ్ టైర్ 2 (SMS) లేదా టైర్ 3 (కాల్) హెచ్చరికలను ఎంచుకుంటే, హెచ్చరిక పంపడానికి మీ ఫోన్ నంబర్ ఒక మూడవ పక్ష SMS/వాయిస్ కాల్ ప్రొవైడర్‌కు పంపబడుతుంది."
        en="A third-party SMS/voice call provider: if you opt into paid Tier 2 (SMS) or Tier 3 (call) alerts, your phone number is shared with a third-party SMS/voice provider to deliver that alert."
      />
      <p style={{ fontSize: 12, color: 'var(--color-danger, #c0392b)', marginTop: -8, marginBottom: 16 }}>
        ⚠️ Draft note: name the actual SMS/call provider here once confirmed — most providers require being disclosed by name.
      </p>
      <Section
        te="మేము మీ డేటాను ప్రకటనల కోసం అమ్మము లేదా మూడవ పక్షాలకు ఇవ్వము, పైన పేర్కొన్న సేవల తప్ప."
        en="We do not sell your data or share it with third parties for advertising purposes, beyond the services listed above."
      />

      <Heading>4. Data Storage &amp; Security · డేటా నిల్వ మరియు భద్రత</Heading>
      <Section
        te="మీ డేటా Supabase సర్వర్లలో నిల్వ చేయబడుతుంది మరియు రో-లెవల్ సెక్యూరిటీ (RLS) ద్వారా రక్షించబడుతుంది — అంటే మీ డేటాను మీరు మాత్రమే (లేదా మీరు స్పష్టంగా అమ్మకానికి/పంచుకోవడానికి ఎంచుకున్నది తప్ప) చూడగలరు."
        en="Your data is stored on Supabase's servers and protected by row-level security (RLS) — meaning only you can access your data, except what you explicitly choose to list for sale or share."
      />
      <Section
        te="మేము యాప్‌లో ఆఫ్‌లైన్ ఉపయోగం కోసం మీ పరికరంలో కొంత డేటాను తాత్కాలికంగా కాష్ చేస్తాము."
        en="We cache some data locally on your device to support offline use of the app."
      />

      <Heading>5. Your Rights · మీ హక్కులు</Heading>
      <Section
        te="మీరు ఏ సమయంలోనైనా మీ పశువు లేదా పొలం జాబితాను తీసివేయవచ్చు, అమ్మకం నుండి తొలగించవచ్చు, లేదా మీ ఖాతాను తొలగించమని అభ్యర్థించవచ్చు."
        en="You can remove a cattle or field listing, unlist something from sale, or request account deletion at any time."
      />
      <Section
        te="మీ డేటాను తొలగించమని అభ్యర్థించడానికి, దిగువ సంప్రదింపు వివరాలను ఉపయోగించండి."
        en="To request data deletion, use the contact details below."
      />

      <Heading>6. Children's Privacy · పిల్లల గోప్యత</Heading>
      <Section
        te="KisanBit 18 సంవత్సరాల కంటే తక్కువ వయస్సు ఉన్నవారి కోసం ఉద్దేశించబడలేదు మరియు వారి నుండి ఉద్దేశపూర్వకంగా డేటాను సేకరించదు."
        en="KisanBit is not intended for users under 18 and does not knowingly collect data from them."
      />

      <Heading>7. Changes to This Policy · ఈ విధానంలో మార్పులు</Heading>
      <Section
        te="మేము ఈ విధానాన్ని కాలానుగుణంగా నవీకరించవచ్చు. ముఖ్యమైన మార్పులు ఉంటే, యాప్‌లో మిమ్మల్ని తెలియజేస్తాము."
        en="We may update this policy from time to time. We'll notify you in the app if there are significant changes."
      />

      <Heading>8. Contact Us · మమ్మల్ని సంప్రదించండి</Heading>
      <Section
        te={`గోప్యత సంబంధిత ప్రశ్నలు లేదా అభ్యర్థనల కోసం, మమ్మల్ని సంప్రదించండి:`}
        en={`For privacy-related questions or requests, contact us:`}
      />
      <p style={{ fontSize: 13, color: 'var(--color-ink)', marginTop: -8 }}>
        📧 {CONTACT_EMAIL}
        <br />
        📞 {CONTACT_PHONE}
      </p>

      <p style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 24 }}>
        This is a draft policy generated for review. Please have it checked against your actual data
        practices and, if needed, by someone qualified to advise on privacy/legal compliance in your
        jurisdiction before publishing.
      </p>
    </div>
  );
}
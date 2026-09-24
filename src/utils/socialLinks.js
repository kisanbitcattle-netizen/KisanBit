// src/utils/socialLinks.js
//
// Shared "auto-link" behaviour for the three optional social page URL
// fields (YouTube / Instagram / Facebook) that now appear the same way on
// AddCattleForm, AddFieldForm, and AddPondForm.
//
// Most farmers only maintain ONE public page/channel, so typing a link
// into any single field auto-fills the other two empty fields with the
// same URL - saves retyping the same link three times and keeps the data
// consistent. A field is only ever auto-filled while it's still empty AND
// the farmer has never typed into it directly - the moment they edit a
// field by hand (even to type a *different* link, or to clear it) it's
// "claimed" and is never silently overwritten again. This means a farmer
// who really does run three different pages can still enter each one
// distinctly and have all three accepted as-is.
import { useRef } from 'react';

export function useLinkedSocialLinks({
  youtubeUrl, setYoutubeUrl,
  instagramUrl, setInstagramUrl,
  facebookUrl, setFacebookUrl,
}) {
  // Seeded from whatever the fields already contained at mount (e.g. an
  // edit-mode form loading an existing record) - a field that already had
  // a value should count as "claimed" from the start, not up for grabs.
  const touched = useRef({
    youtube: !!youtubeUrl?.trim(),
    instagram: !!instagramUrl?.trim(),
    facebook: !!facebookUrl?.trim(),
  });

  const fields = {
    youtube: { value: youtubeUrl, set: setYoutubeUrl },
    instagram: { value: instagramUrl, set: setInstagramUrl },
    facebook: { value: facebookUrl, set: setFacebookUrl },
  };

  const makeHandler = (key) => (value) => {
    touched.current[key] = true;
    fields[key].set(value);

    if (!value.trim()) return; // clearing a field never pushes out to siblings

    Object.entries(fields).forEach(([otherKey, other]) => {
      if (otherKey === key) return;
      // Only fill a sibling that's still empty and that the farmer hasn't
      // personally touched yet - never clobber a distinct link they typed.
      if (!touched.current[otherKey] && !other.value?.trim()) {
        other.set(value);
      }
    });
  };

  return {
    onYoutubeChange: makeHandler('youtube'),
    onInstagramChange: makeHandler('instagram'),
    onFacebookChange: makeHandler('facebook'),
  };
}
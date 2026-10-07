'use strict';
// Contacts of a place (the host of a night) and the log of what was exchanged with it.
// Pure helpers: validation of each field, extraction from free text and OpenStreetMap tags.
// Nothing here sends anything: the plugin never writes to a host, it records what the
// user declares and drafts messages for the user to send.

const { urlsIn } = require('./util');

const CHANNELS = ['email', 'phone', 'whatsapp', 'website_form'];
const LOG_CHANNELS = ['email', 'phone', 'whatsapp', 'website_form', 'sms', 'in_person', 'other'];
const DIRECTIONS = ['sent', 'received'];
const LOG_MAX = 50;
const FIELDS = ['email', 'phone', 'whatsapp', 'website', 'contact_name', 'languages', 'preferred_channel', 'notes'];

class ContactError extends Error {}

const blankContacts = () => ({
  email: null, phone: null, whatsapp: null, website: null, contact_name: null, languages: [], preferred_channel: null, notes: null,
});

const EMAIL = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}$/;

function email(v) {
  const s = String(v).trim().replace(/^mailto:/i, '');
  if (!EMAIL.test(s) || s.length > 254) throw new ContactError(`email "${String(v).slice(0, 60)}" is not a valid e-mail address (name@domain.tld)`);
  return s.toLowerCase();
}

/**
 * "+39 0471 000 000" → "+390471000000" (E.164). A number without country code is kept as
 * typed when it is plausible (6 to 15 digits, only digits, spaces and . - / ( )).
 */
function phone(v, field = 'phone') {
  const raw = String(v).trim().replace(/^tel:/i, '');
  const digits = raw.replace(/\D/g, '');
  if (!/^[+0-9][0-9 .\-/()]*$/.test(raw) || digits.length < 6 || digits.length > 15) {
    throw new ContactError(`${field} "${raw.slice(0, 40)}" is not a phone number: use the international form, e.g. +39 0471 000000`);
  }
  if (raw.startsWith('+')) return `+${digits}`;
  if (raw.startsWith('00')) return `+${digits.slice(2)}`;
  return raw.replace(/\s+/g, ' ');
}

/** http(s) URL; a bare host ("www.example.com") is completed to https. */
function website(v) {
  let s = String(v).trim();
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s) && /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { u = null; }
  if (!u || !/^https?:$/.test(u.protocol) || !u.hostname.includes('.') || s.length > 500) {
    throw new ContactError(`website "${String(v).slice(0, 60)}" is not a web address: it must start with http:// or https://`);
  }
  return s;
}

function text(v, field, max) {
  const s = String(v).replace(/\s+/g, ' ').trim();
  if (s.length > max) throw new ContactError(`${field} is too long (${max} characters at most)`);
  return s || null;
}

function languages(v) {
  const list = Array.isArray(v) ? v : String(v).split(/[,;/]/);
  const out = list.map((x) => String(x).trim()).filter(Boolean);
  if (out.length > 8 || out.some((x) => x.length > 20)) throw new ContactError('languages: at most 8 entries of 20 characters (e.g. ["it", "de", "en"])');
  return out;
}

/** One validated field value; null (or "") clears it. */
function field(k, v) {
  if (!FIELDS.includes(k)) throw new ContactError(`unknown contact field "${k}" (known: ${FIELDS.join(', ')})`);
  if (v === null || v === undefined || v === '') return k === 'languages' ? [] : null;
  switch (k) {
    case 'email': return email(v);
    case 'phone': return phone(v, 'phone');
    case 'whatsapp': return phone(v, 'whatsapp');
    case 'website': return website(v);
    case 'contact_name': return text(v, k, 100);
    case 'languages': return languages(v);
    case 'preferred_channel':
      if (!CHANNELS.includes(v)) throw new ContactError(`preferred_channel must be one of ${CHANNELS.join(', ')}`);
      return v;
    default: return text(v, k, 300); // notes
  }
}

/** Apply a patch { field: value|null } onto contacts; returns the new contacts and the changed keys. */
function patchContacts(current, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new ContactError('contacts must be an object of fields');
  const out = { ...blankContacts(), ...(current || {}) };
  const changed = [];
  for (const [k, v] of Object.entries(patch)) {
    const next = field(k, v);
    // A form sends every field back: only a value that really changes counts as a change.
    if (JSON.stringify(next) !== JSON.stringify(out[k])) changed.push(k);
    out[k] = next;
  }
  return { contacts: out, changed };
}

/** A validated log entry { date, channel, direction, summary }. */
function logEntry(e) {
  if (!e || typeof e !== 'object') throw new ContactError('log must be an object { date, channel, direction, summary }');
  const date = String(e.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ContactError('log.date must be a date YYYY-MM-DD');
  if (!LOG_CHANNELS.includes(e.channel)) throw new ContactError(`log.channel must be one of ${LOG_CHANNELS.join(', ')}`);
  if (!DIRECTIONS.includes(e.direction)) throw new ContactError('log.direction must be "sent" or "received"');
  const summary = text(e.summary || '', 'log.summary', 300);
  if (!summary) throw new ContactError('log.summary is required (one short sentence)');
  return { date, channel: e.channel, direction: e.direction, summary };
}

/** Add an entry: most recent first (by date, then insertion), at most LOG_MAX kept. */
function addLog(log, entry) {
  const list = [entry, ...(Array.isArray(log) ? log : [])];
  return list.map((x, i) => [x, i]).sort((a, b) => b[0].date.localeCompare(a[0].date) || a[1] - b[1]).map(([x]) => x).slice(0, LOG_MAX);
}

// Pages that are not the host's own site (platforms, maps, social networks, encyclopedias):
// never taken as its website, wherever the address comes from.
const PLATFORM_DOMAINS = /(^|\.)(park4night\.com|openstreetmap\.org|osm\.org|goo\.gl|booking\.com|campercontact\.com|camping\.info|pitchup\.com|facebook\.com|fb\.com|instagram\.com|wikipedia\.org|wikimedia\.org)$/i;
// Brands present under several country domains (airbnb.fr, pincamp.de, eurocampings.co.uk...).
const PLATFORM_BRANDS = /(^|\.)(airbnb|tripadvisor|nomady|campspace|alpacacamping|pincamp|eurocampings)\.[a-z]{2,6}(\.[a-z]{2})?$/i;
// The same, as one pattern over a raw text (an address that does not parse).
const NOT_OWN_SITE = /(park4night\.com|openstreetmap\.org|osm\.org|google\.[a-z.]+\/maps|maps\.google\.|goo\.gl|booking\.com|airbnb\.|tripadvisor\.|campercontact\.com|camping\.info|pitchup\.com|nomady|campspace|alpacacamping|pincamp|eurocampings|facebook\.com|fb\.com|instagram\.com|wikipedia\.org|wikimedia\.org)/i;

/** Is this address a platform page (park4night, Google Maps, Booking, Facebook...) rather than the host's own site? */
function notOwnSite(url) {
  if (!url) return false;
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(String(url)) ? String(url) : `https://${url}`); } catch { return NOT_OWN_SITE.test(String(url)); }
  const host = u.hostname.toLowerCase();
  if (PLATFORM_DOMAINS.test(host) || PLATFORM_BRANDS.test(host)) return true;
  // Google: only its maps (a site hosted on sites.google.com may be the host's own).
  return /(^|\.)google\.[a-z.]+$/.test(host) && (host.startsWith('maps.') || /^\/maps(\/|$|\?)/.test(u.pathname));
}

/** E-mails, phone numbers and web addresses quoted in a free text (notes, description). */
function extract(txt) {
  const s = String(txt || '');
  const emails = [...new Set((s.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}/g) || []).map((x) => x.toLowerCase()))];
  const phones = [];
  const push = (raw) => { try { const p = phone(raw.trim()); if (!phones.includes(p)) phones.push(p); } catch { /* not a number */ } };
  for (const m of s.matchAll(/(?:\+|\b00)\d{1,3}[\d .\-/()]{5,17}\d/g)) push(m[0]);
  for (const m of s.matchAll(/(?:t[ée]l(?:[ée]phone)?|phone|tel\.|telefono|telefon|cell|mobile|handy|whatsapp)\s*[:.]?\s*([+0-9][0-9 .\-/()]{5,18}\d)/gi)) push(m[1]);
  const urls = [];
  // http(s) addresses through the shared extractor; a bare "www." address completed after.
  const bare = [...s.matchAll(/(?<![/\w.])www\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"')]*/gi)].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
  for (const u of [...urlsIn(s), ...bare]) {
    if (notOwnSite(u)) continue;
    try { const w = website(u); if (!urls.includes(w)) urls.push(w); } catch { /* not a web address */ }
  }
  return { emails, phones, urls };
}

/** Contacts an OpenStreetMap element states (email, phone, website and their contact:* forms). */
function fromOsmTags(tags = {}) {
  const pick = (...keys) => keys.map((k) => tags[k]).find((v) => v != null && v !== '') || null;
  const safe = (fn, v) => { if (v == null) return null; try { return fn(String(v).split(';')[0]); } catch { return null; } };
  return {
    email: safe(email, pick('email', 'contact:email')),
    phone: safe(phone, pick('phone', 'contact:phone', 'contact:mobile', 'mobile')),
    website: [pick('website'), pick('contact:website'), pick('url')].map((v) => safe(website, v)).find((v) => v && !notOwnSite(v)) || null,
  };
}

/** The known channels of a place, best first: the preferred one, then e-mail, WhatsApp, phone, website. */
function channels(c) {
  if (!c) return [];
  const all = [
    c.email && { channel: 'email', address: c.email },
    c.whatsapp && { channel: 'whatsapp', address: c.whatsapp },
    c.phone && { channel: 'phone', address: c.phone },
    c.website && { channel: 'website_form', address: c.website },
  ].filter(Boolean);
  const pref = all.findIndex((x) => x.channel === c.preferred_channel);
  if (pref > 0) all.unshift(...all.splice(pref, 1));
  return all;
}

/**
 * The host's ways in, as every reader shows and uses them: the plugin's record first, then
 * TREK's own phone and website fields (a platform page is never the host's site). The one
 * merge of the two sources: the widget, the night list, the check and the host message.
 */
function reachOf(info, raw) {
  const c = { ...blankContacts(), ...((info && info.contacts) || {}) };
  const site = c.website || (raw && raw.website) || null;
  return { ...c, phone: c.phone || (raw && raw.phone) || null, website: site && !notOwnSite(site) ? site : null };
}

/** Can the host be asked anything: an e-mail, a phone, WhatsApp or its own website (a contact form)? */
const hasContact = (c) => !!(c && (c.email || c.phone || c.whatsapp || (c.website && !notOwnSite(c.website))));

module.exports = {
  CHANNELS, LOG_CHANNELS, DIRECTIONS, LOG_MAX, FIELDS, ContactError, notOwnSite,
  blankContacts, email, phone, website, field, patchContacts, logEntry, addLog, extract, fromOsmTags, channels, hasContact, reachOf,
};

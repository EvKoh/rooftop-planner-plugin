'use strict';
// Drafts the information request to the host of a night: English, a line of dashes, French
// (and Italian or German on request). The questions come from what the place's record does
// not answer yet. The draft is returned to the assistant, which must show it word for word
// to the user and wait for an explicit go before anyone sends it: nothing is ever sent here.
// The texts are the message itself, in the host's languages, not interface strings: they
// live here rather than in the 27 interface catalogues.
const contacts = require('./contacts');
const { nightOf } = require('./trip');
const { hhmm, toNum } = require('./util');
const { money } = require('./i18n');

const SEPARATOR = '————————————';
const EXTRA = ['it', 'de'];
const LOCALE = { en: 'en-GB', fr: 'fr-FR', it: 'it-IT', de: 'de-DE' };

class MessageError extends Error {}

// {placeholders}: dates, n (nights), people, dog, vehicle, size, time, price.
const TEXT = {
  en: {
    hello: 'Hello,',
    intro: 'We are planning a road trip and would like to stay with you {dates} ({n}).',
    party: 'We are {people}{dog}, travelling {vehicle}.',
    ask: 'Could you please tell us:',
    rooftop_tent: 'Do you accept a car with a rooftop tent (we sleep in the tent on the roof of the car, {size})?',
    van: 'Can we stay overnight in our {vehicleShort} ({size})?',
    dog: 'Is our dog welcome, and is there a supplement for it?',
    dog_fee: 'How much is the supplement for our dog?',
    open: 'Are you open {dates}?',
    arrival: 'We expect to arrive around {time}: is that fine?',
    arrival_hours: 'Until what time can we arrive?',
    price: 'What would the price be for {people}{dog} and our vehicle, for {n}?',
    price_confirm: 'Could you confirm the price of {price} for {people}{dog} and our vehicle, for {n}?',
    water: 'Is there drinking water to fill our tank?',
    electricity: 'Is an electric hook-up available, and at what price?',
    notBooking: 'This is a request for information, not a booking yet: we will confirm once we have your answer.',
    thanks: 'Thank you very much,',
    subject: 'Information request',
    night: ['night', 'nights'],
    person: ['1 person', '{k} people'],
    withDog: ' with a dog',
    rooftop: 'by car with a rooftop tent',
    campervan: 'in a campervan',
    motorhome: 'in a motorhome',
    campervanShort: 'campervan',
    motorhomeShort: 'motorhome',
    on: 'on {date}',
    fromTo: 'from {from} to {to}',
  },
  fr: {
    hello: 'Bonjour,',
    intro: 'Nous préparons un voyage en voiture et aimerions séjourner chez vous {dates} ({n}).',
    party: 'Nous sommes {people}{dog}, et voyageons {vehicle}.',
    ask: 'Pourriez-vous nous dire :',
    rooftop_tent: 'Acceptez-vous une voiture avec une tente de toit (nous dormons dans la tente, sur le toit de la voiture, {size}) ?',
    van: 'Pouvons-nous passer la nuit dans notre {vehicleShort} ({size}) ?',
    dog: 'Notre chien est-il le bienvenu, et y a-t-il un supplément ?',
    dog_fee: 'Quel est le montant du supplément pour notre chien ?',
    open: 'Êtes-vous ouverts {dates} ?',
    arrival: 'Nous pensons arriver vers {time} : cela vous convient-il ?',
    arrival_hours: "Jusqu'à quelle heure pouvons-nous arriver ?",
    price: 'Quel serait le prix pour {people}{dog} et notre véhicule, pour {n} ?',
    price_confirm: 'Pouvez-vous nous confirmer le prix de {price} pour {people}{dog} et notre véhicule, pour {n} ?',
    water: "Y a-t-il de l'eau potable pour remplir notre réservoir ?",
    electricity: 'Un branchement électrique est-il possible, et à quel prix ?',
    notBooking: "Il s'agit d'une demande d'informations, pas encore d'une réservation : nous confirmerons après votre réponse.",
    thanks: 'Merci beaucoup,',
    subject: "Demande d'informations",
    night: ['nuit', 'nuits'],
    person: ['1 personne', '{k} personnes'],
    withDog: ' avec un chien',
    rooftop: 'en voiture avec une tente de toit',
    campervan: 'en van aménagé',
    motorhome: 'en camping-car',
    campervanShort: 'van aménagé',
    motorhomeShort: 'camping-car',
    on: 'le {date}',
    fromTo: 'du {from} au {to}',
  },
  it: {
    hello: 'Buongiorno,',
    intro: 'Stiamo organizzando un viaggio in auto e vorremmo soggiornare da voi {dates} ({n}).',
    party: 'Siamo {people}{dog} e viaggiamo {vehicle}.',
    ask: 'Potreste dirci:',
    rooftop_tent: "Accettate un'auto con tenda da tetto (dormiamo nella tenda sul tetto dell'auto, {size})?",
    van: 'Possiamo pernottare nel nostro {vehicleShort} ({size})?',
    dog: 'Il nostro cane è il benvenuto, e c’è un supplemento?',
    dog_fee: 'Quanto costa il supplemento per il nostro cane?',
    open: 'Siete aperti {dates}?',
    arrival: 'Pensiamo di arrivare verso le {time}: va bene?',
    arrival_hours: 'Fino a che ora possiamo arrivare?',
    price: 'Quale sarebbe il prezzo per {people}{dog} e il nostro veicolo, per {n}?',
    price_confirm: 'Potreste confermarci il prezzo di {price} per {people}{dog} e il nostro veicolo, per {n}?',
    water: "C'è acqua potabile per riempire il serbatoio?",
    electricity: "È disponibile un allacciamento elettrico, e a quale prezzo?",
    notBooking: 'Questa è una richiesta di informazioni, non ancora una prenotazione: confermeremo dopo la vostra risposta.',
    thanks: 'Grazie mille,',
    subject: 'Richiesta di informazioni',
    night: ['notte', 'notti'],
    person: ['1 persona', '{k} persone'],
    withDog: ' con un cane',
    rooftop: 'in auto con tenda da tetto',
    campervan: 'in camper van',
    motorhome: 'in camper',
    campervanShort: 'camper van',
    motorhomeShort: 'camper',
    on: 'il {date}',
    fromTo: 'dal {from} al {to}',
  },
  de: {
    hello: 'Guten Tag,',
    intro: 'Wir planen eine Reise mit dem Auto und würden gerne bei Ihnen übernachten, {dates} ({n}).',
    party: 'Wir sind {people}{dog} und reisen {vehicle}.',
    ask: 'Könnten Sie uns bitte sagen:',
    rooftop_tent: 'Akzeptieren Sie ein Auto mit Dachzelt (wir schlafen im Zelt auf dem Autodach, {size})?',
    van: 'Dürfen wir in unserem {vehicleShort} übernachten ({size})?',
    dog: 'Ist unser Hund willkommen, und gibt es einen Aufpreis?',
    dog_fee: 'Wie hoch ist der Aufpreis für unseren Hund?',
    open: 'Haben Sie {dates} geöffnet?',
    arrival: 'Wir kommen voraussichtlich gegen {time} Uhr an: passt das?',
    arrival_hours: 'Bis wann können wir ankommen?',
    price: 'Was würde es für {people}{dog} und unser Fahrzeug kosten, für {n}?',
    price_confirm: 'Können Sie uns den Preis von {price} für {people}{dog} und unser Fahrzeug bestätigen, für {n}?',
    water: 'Gibt es Trinkwasser, um unseren Tank zu füllen?',
    electricity: 'Gibt es einen Stromanschluss, und zu welchem Preis?',
    notBooking: 'Dies ist eine Anfrage, noch keine Buchung: Wir bestätigen nach Ihrer Antwort.',
    thanks: 'Vielen Dank,',
    subject: 'Anfrage',
    night: ['Nacht', 'Nächte'],
    person: ['1 Person', '{k} Personen'],
    withDog: ' mit Hund',
    rooftop: 'mit dem Auto und einem Dachzelt',
    campervan: 'mit einem Campervan',
    motorhome: 'mit einem Wohnmobil',
    campervanShort: 'Campervan',
    motorhomeShort: 'Wohnmobil',
    on: 'am {date}',
    fromTo: 'vom {from} bis {to}',
  },
};

const fill = (tpl, p) => tpl.replace(/\{(\w+)\}/g, (_, k) => (p[k] == null ? '' : String(p[k])));

function dateText(iso, lg) {
  return new Intl.DateTimeFormat(LOCALE[lg], { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${iso}T12:00:00Z`));
}

/** The questions the record leaves open, in order: [{ key, params }]. */
function questionsFor(info, settings, ctxt) {
  const am = (info && info.amenities) || {};
  const q = [];
  if (settings.vehicle === 'rooftop_tent') { if (am.rooftop_tent !== 'yes') q.push('rooftop_tent'); } else q.push('van');
  if (settings.dog) {
    if (am.dog === 'fee' && (!info || info.dog_fee == null)) q.push('dog_fee');
    else if (am.dog !== 'yes' && am.dog !== 'fee') q.push('dog');
  }
  q.push('open');
  q.push(ctxt.arrival != null ? 'arrival' : 'arrival_hours');
  q.push(ctxt.price != null ? 'price_confirm' : 'price');
  if (am.water !== 'yes') q.push('water');
  if (settings.vehicle !== 'rooftop_tent' && am.electricity !== 'yes') q.push('electricity');
  return q;
}

function body(lg, keys, p, extraQuestions) {
  const T = TEXT[lg];
  const lines = [T.hello, '', fill(T.intro, p), fill(T.party, p), '', T.ask];
  const all = keys.map((k) => fill(T[k], p));
  // Questions the assistant adds are written by it in English; they go in the English part.
  if (lg === 'en') all.push(...extraQuestions);
  all.forEach((x, i) => lines.push(`${i + 1}. ${x}`));
  lines.push('', T.notBooking, '', T.thanks);
  if (p.signature) lines.push(p.signature);
  return lines.join('\n');
}

function params(lg, base) {
  const T = TEXT[lg];
  const n = `${base.nights} ${T.night[base.nights > 1 ? 1 : 0]}`;
  const dates = base.end ? fill(T.fromTo, { from: dateText(base.start, lg), to: dateText(base.end, lg) }) : fill(T.on, { date: dateText(base.start, lg) });
  const people = fill(T.person[base.travellers > 1 ? 1 : 0], { k: base.travellers });
  const dec = (x) => new Intl.NumberFormat(LOCALE[lg], { maximumFractionDigits: 2 }).format(x);
  return {
    ...base, n, dates, people, size: `${dec(base.length)} m × ${dec(base.height)} m`, dog: base.dog ? T.withDog : '',
    vehicle: T[base.vehicle === 'rooftop_tent' ? 'rooftop' : base.vehicle],
    vehicleShort: T[`${base.vehicle}Short`],
    price: base.price == null ? null : money(base.price, base.currency, lg),
  };
}

/**
 * a: { placeId, dayNumber?, dayId?, nights?, arrival?, extra_questions?, language_extra?, signature? }
 * → { to, otherChannels, subject, text, questions, reminder }
 */
function draft(model, settings, a) {
  const place = model.poolById.get(a.placeId);
  if (!place) throw new MessageError(`place ${a.placeId} is not in trip ${model.tripId}`);
  const noDay = a.dayNumber == null && a.dayId == null;
  const planned = model.nights.find((n) => n.placeId === place.id && (noDay || model.days.some((d) => d.id === n.startDayId && (d.n === a.dayNumber || d.id === a.dayId))));
  const day = model.days.find((d) => (a.dayId != null && d.id === a.dayId) || (a.dayNumber != null && d.n === a.dayNumber)) || (planned && model.days.find((d) => d.id === planned.startDayId));
  if (!day || !day.date) throw new MessageError(`"${place.name}" is not a planned night with a date: give dayNumber, the evening of the night`);
  const nights = Math.max(1, Math.min(30, a.nights || (planned ? planned.nights : 1)));
  const endDay = model.days[day.index + nights];
  const endDate = nights > 1 ? (endDay && endDay.date) || new Date(Date.parse(`${day.date}T12:00:00Z`) + nights * 864e5).toISOString().slice(0, 10) : null;
  // Arrival: the night's planned time in the day, else its check-in.
  let arrival = a.arrival || null;
  if (!arrival) {
    const tonight = nightOf(model, day);
    const asg = tonight && tonight.placeId === place.id ? day.assignments.find((x) => x.accommodationId === tonight.id) : null;
    const m = asg && asg.place.time != null ? asg.place.time : null;
    arrival = m != null ? hhmm(m) : tonight && tonight.placeId === place.id && tonight.checkIn ? tonight.checkIn : null;
  }
  const info = place.info;
  const priceN = toNum(place.price);
  const base = {
    start: day.date, end: endDate, nights, travellers: settings.travellers || 2, dog: !!settings.dog, vehicle: settings.vehicle,
    length: settings.vehicle_length_m, height: settings.vehicle_height_m,
    time: arrival, price: priceN, currency: (place.raw && place.raw.currency) || model.currency, signature: a.signature ? String(a.signature).slice(0, 80) : null,
  };
  const keys = questionsFor(info, settings, { arrival, price: priceN });
  const extraQ = (a.extra_questions || []).map((x) => String(x).slice(0, 200)).slice(0, 5);
  const langs = ['en', 'fr', ...(EXTRA.includes(a.language_extra) ? [a.language_extra] : [])];
  const parts = langs.map((lg) => body(lg, keys, params(lg, base), extraQ));
  const text = parts.join(`\n\n${SEPARATOR}\n\n`);
  const routes = contacts.channels(info && info.contacts);
  if (!routes.length && place.raw && place.raw.phone) routes.push({ channel: 'phone', address: place.raw.phone });
  if (!routes.length && place.raw && place.raw.website && !contacts.NOT_OWN_SITE.test(place.raw.website)) routes.push({ channel: 'website_form', address: place.raw.website });
  const dateShort = day.date.split('-').reverse().join('/');
  const subject = `${TEXT.en.subject} / ${TEXT.fr.subject}${a.language_extra && EXTRA.includes(a.language_extra) ? ` / ${TEXT[a.language_extra].subject}` : ''} — ${dateShort}${nights > 1 ? ` (${nights})` : ''}`;
  return {
    placeId: place.id, place: place.name, date: day.date, nights,
    to: routes[0] ? { ...routes[0], name: (info && info.contacts.contact_name) || place.name } : null,
    otherChannels: routes.slice(1),
    ...(routes.length ? {} : { noContact: 'No e-mail, phone or website known for this place: find the official contact first (vanlife_place with fill, or the official site), and record it with vanlife_place set.contacts.' }),
    languages: (info && info.contacts.languages && info.contacts.languages.length) ? info.contacts.languages : null,
    subject,
    text,
    questions: keys.map((k) => ({ key: k, en: fill(TEXT.en[k], params('en', base)), fr: fill(TEXT.fr[k], params('fr', base)) })).concat(extraQ.map((x) => ({ key: 'extra', en: x, fr: null }))),
    reminder: 'DRAFT ONLY. Show this exact text to the user and wait for their explicit validation before it is sent; the user sends it, or tells you to. It is a request for information, not a booking. Once sent, record it with vanlife_place log (direction "sent") and vanlife_night set status "contacted".',
  };
}

module.exports = { draft, questionsFor, TEXT, SEPARATOR, EXTRA, MessageError };

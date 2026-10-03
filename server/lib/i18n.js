'use strict';
// Message catalogue for everything a traveller reads (warnings banner, tab, tool reports).
// English is canonical; every key must exist in every language (a test enforces it).

const MESSAGES = {
  en: {
    'level.blocking': 'BLOCKING',
    'level.fix': 'TO FIX',
    'level.verify': 'TO VERIFY',
    'level.info': 'INFO',
    day: 'Day {n} ({date})',
    'scope.bookings': 'Bookings',
    'scope.budget': 'Budget',
    'scope.todos': 'To-dos',
    no_trace: 'no route place for the day: the map draws straight lines',
    trace_not_first: 'the route place is not the first item of the day (the map draws a straight line to the morning start)',
    trace_start: 'the route does not start at last night\'s place ({name})',
    trace_end: 'the route does not end at tonight\'s place ({name})',
    no_time: '"{name}" has no time',
    ends_before_start: '"{name}" ends ({end}) before it starts ({start})',
    unreachable: '"{name}" at {start} is impossible: "{prev}" ends at {prevEnd} + {min} min drive = {eta}',
    overlap: '"{name}" starts ({start}) before "{prev}" ends ({prevEnd})',
    after_sunset: '"{name}" ends at {end}, after sunset ({sunset}): the day finishes in the dark',
    closure_neighbour: '"{name}": the {day} closure quoted concerns a neighbouring business — "{quote}"',
    closure_cited: '"{name}": the notes mention a closure on {day} — "{quote}" (check it is this place, not a nearby restaurant)',
    outside_hours: '"{name}": visit {from}–{to} is outside the {day} opening hours ({open}–{close})',
    shop_detour: '{min} min detour for "{name}" (limit {max} min): look for a shop or a station on the way',
    night_no_arrival: 'unknown arrival time at "{name}"',
    night_late: 'arrival at "{name}" at {arr} is TOO LATE: sunset {sunset}, arrive by {limit} to unfold the tent in daylight',
    checkin_mismatch: 'accommodation "{name}": check-in {checkin} but the itinerary says {arr}',
    night_margin: 'night at "{name}": arrival {arr}, sunset {sunset} — margin {margin}',
    night_aire: '"{name}" is a motorhome area or car park: an opened rooftop tent is camping there — campsite or farm only',
    night_farm_zone: '"{name}" is a farm in {zone}: {note}. Accept the risk explicitly or choose a campsite',
    night_private: '"{name}" is neither a campsite nor a farm: check that a rooftop tent is legal there and accepted in writing',
    tent_banned: '"{name}": the notes say tents or camping are not allowed — "{quote}"',
    welcome_window: 'arrival {arr} is outside the check-in window of "{name}" ({open}–{close})',
    min_nights: '"{name}": a minimum stay is mentioned and the plan stays {n} night(s) — get it confirmed',
    water_fix: '{n} nights in a row without water: plan where to refill the {litres} L reserve before arriving',
    water_ok: '{n} nights in a row without water: a refill is planned in the day notes',
    price_high: '"{name}": {price} € a night is above the {max} € ceiling — justify it or look for an alternative',
    price_target: '"{name}": {price} € a night is above the {target} € target',
    price_unknown: '"{name}": no price — find it (official site first) or ask the host',
    resa_mismatch: 'booking "{title}" is attached to the night at "{name}"',
    resa_confirmed: '"{title}" is marked CONFIRMED: check the traveller really booked it (TREK confirms automatically when an accommodation is created)',
    stale_budget: '"{name}" mentions a night that is no longer planned ({list})',
    budget_total: 'accommodation in the budget: {budget} €; planned nights: {nights} €',
    stale_todo: '"{name}" mentions a night that is no longer planned ({list})',
    stale_note: 'note "{text}" mentions {list}, which is no longer planned',
    route_pending: '{n} drive time(s) not computed yet (time budget reached): run the check again',
    weekday: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  },
  fr: {
    'level.blocking': 'BLOQUANT',
    'level.fix': 'À CORRIGER',
    'level.verify': 'À VÉRIFIER',
    'level.info': 'INFO',
    day: 'J{n} ({date})',
    'scope.bookings': 'Résa',
    'scope.budget': 'Budget',
    'scope.todos': 'Tâches',
    no_trace: 'aucun tracé pour la journée : la carte trace des lignes droites',
    trace_not_first: 'le tracé n\'est pas le premier élément de la journée (ligne droite sur la carte vers le départ du matin)',
    trace_start: 'le tracé ne part pas de la nuit d\'avant ({name})',
    trace_end: 'le tracé n\'arrive pas à la nuit du jour ({name})',
    no_time: '« {name} » n\'a pas d\'heure',
    ends_before_start: '« {name} » finit ({end}) avant de commencer ({start})',
    unreachable: '« {name} » à {start} impossible : fin de « {prev} » à {prevEnd} + {min} min de route = {eta}',
    overlap: '« {name} » commence ({start}) avant la fin de « {prev} » ({prevEnd})',
    after_sunset: '« {name} » finit à {end}, après le coucher du soleil ({sunset}) : la journée finit de nuit',
    closure_neighbour: '« {name} » : la fermeture du {day} citée vise un établissement voisin — « {quote} »',
    closure_cited: '« {name} » : la fiche cite une fermeture le {day} — « {quote} » (vérifier que c\'est bien ce lieu, pas un restaurant voisin)',
    outside_hours: '« {name} » : passage {from}–{to} hors des horaires du {day} ({open}–{close})',
    shop_detour: 'détour de {min} min pour « {name} » (limite {max} min) : chercher un magasin ou une station sur la route',
    night_no_arrival: 'heure d\'arrivée inconnue à « {name} »',
    night_late: 'arrivée à « {name} » à {arr} : TROP TARD (coucher du soleil {sunset}, arrivée au plus tard {limit} pour déplier la tente de jour)',
    checkin_mismatch: 'fiche d\'hébergement « {name} » : arrivée {checkin} alors que l\'étape dit {arr}',
    night_margin: 'nuit à « {name} » : arrivée {arr}, coucher du soleil {sunset} — marge {margin}',
    night_aire: '« {name} » est une aire ou un parking : tente de toit ouverte = camping — camping ou ferme uniquement',
    night_farm_zone: '« {name} » est une ferme en zone {zone} : {note}. Risque à accepter explicitement, sinon camping',
    night_private: '« {name} » n\'est ni un camping ni une ferme : vérifier que la tente de toit y est légale et acceptée par écrit',
    tent_banned: '« {name} » : la fiche interdit la tente ou le camping — « {quote} »',
    welcome_window: 'arrivée {arr} hors du créneau d\'accueil de « {name} » ({open}–{close})',
    min_nights: '« {name} » : minimum de nuits cité dans la fiche, on n\'y reste que {n} nuit(s) — à faire confirmer',
    water_fix: '{n} nuits d\'affilée sans eau : prévoir où remplir la réserve de {litres} L avant d\'arriver',
    water_ok: '{n} nuits d\'affilée sans eau : remplissage prévu dans les notes du jour',
    price_high: '« {name} » : {price} € la nuit dépasse le plafond de {max} € — justifier ou chercher une alternative',
    price_target: '« {name} » : {price} € la nuit dépasse la cible de {target} €',
    price_unknown: '« {name} » : prix inconnu — le trouver (site officiel d\'abord) ou le demander à l\'hôte',
    resa_mismatch: 'la réservation « {title} » est rattachée à la nuit de « {name} »',
    resa_confirmed: '« {title} » est marquée CONFIRMÉE : vérifier que le voyageur a vraiment réservé (TREK confirme tout seul à la création d\'un hébergement)',
    stale_budget: '« {name} » cite une nuitée hors programme ({list})',
    budget_total: 'hébergement au budget : {budget} € ; prix des nuits planifiées : {nights} €',
    stale_todo: '« {name} » cite une nuitée hors programme ({list})',
    stale_note: 'note « {text} » cite {list}, hors programme',
    route_pending: '{n} temps de route pas encore calculé(s) (budget de temps atteint) : relancer le contrôle',
    weekday: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
  },
};

function lang(l) {
  return l === 'fr' ? 'fr' : 'en';
}

/** Render message `key` in language `l` with `{param}` placeholders filled. */
function t(l, key, params = {}) {
  const tpl = MESSAGES[lang(l)][key] ?? MESSAGES.en[key] ?? key;
  return String(tpl).replace(/\{(\w+)\}/g, (_, k) => (params[k] == null ? '' : String(params[k])));
}

function dayName(l, wd) {
  return MESSAGES[lang(l)].weekday[wd];
}

module.exports = { MESSAGES, t, dayName, lang };

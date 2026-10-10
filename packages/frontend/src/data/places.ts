/**
 * Sample list of places that accept FairCoin.
 *
 * This is a hardcoded seed used by the "Places that accept FairCoin" map
 * screen while there is no backend directory. Coordinates are sourced from
 * publicly-known FairCoop community nodes and partner locations (mostly in
 * Spain, where the FairCoin community is historically concentrated), plus a
 * few international entries so the map is visibly populated anywhere.
 *
 * When a real directory backend lands, replace the static `PLACES` array
 * with a fetched/cached collection and keep the `Place` type + helpers.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlaceCategory = 'cafe' | 'restaurant' | 'shop' | 'service' | 'atm' | 'other';

/**
 * Methods a place offers for paying out FairCoin balance to local fiat.
 * Used by the detail view when `acceptsFairToFiat` is true.
 */
export type FiatPayoutMethod = 'cash' | 'bank' | 'card';

export interface Place {
  /** Stable, unique identifier (also used as the map marker id). */
  id: string;
  /** Display name of the place. */
  name: string;
  /** High-level category used for iconography and filtering. */
  category: PlaceCategory;
  /** Optional short description or tagline. */
  description?: string;
  /** Street address (single line). */
  address: string;
  /** City / town. */
  city: string;
  /** ISO country name. */
  country: string;
  /** Latitude in degrees (WGS84). */
  latitude: number;
  /** Longitude in degrees (WGS84). */
  longitude: number;
  /** Optional remote logo URL. */
  logoUrl?: string;
  /** Optional thumbnail image URL shown in the list and as the detail hero. */
  imageUrl?: string;
  /** Optional website URL. */
  website?: string;
  /** Optional phone number for the "Call" action. */
  phone?: string;
  /** Minimum FairCoin spend required to pay here, denominated in FAIR. */
  minimumSpend?: number;
  /** Whether the place will exchange FairCoin for the local fiat currency. */
  acceptsFairToFiat?: boolean;
  /** ISO-4217 currency code used for the local-fiat exchange rate quote. */
  localCurrency?: string;
  /** Supported fiat payout methods when `acceptsFairToFiat` is true. */
  fiatPayoutMethods?: readonly FiatPayoutMethod[];
  /**
   * Maximum fiat amount the place will pay out in a single transaction,
   * expressed in the `localCurrency`.
   */
  maxFiatPayout?: number;
  /** Free-form opening-hours string (e.g. "Mon-Fri 09:00-18:00"). */
  openingHours?: string;
}

// ---------------------------------------------------------------------------
// Seed image URLs
// ---------------------------------------------------------------------------

/**
 * Stock photo URLs served from Unsplash's CDN. These are stable, long-lived
 * photo IDs — the `?w=600&q=80` query params ask the CDN to resize and
 * compress the image for the small thumbnails and hero banners we render.
 *
 * Using a small, shared map instead of hard-coding URLs per seed entry keeps
 * the file compact and makes it trivial to swap to real photos once a
 * directory backend lands.
 */
const CATEGORY_IMAGE: Record<PlaceCategory, string> = {
  cafe: 'https://images.unsplash.com/photo-1495474472287-4d71bcdd2085?w=600&q=80',
  restaurant: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=600&q=80',
  shop: 'https://images.unsplash.com/photo-1441986300917-64674bd600d8?w=600&q=80',
  service: 'https://images.unsplash.com/photo-1581291518633-83b4ebd1d83e?w=600&q=80',
  atm: 'https://images.unsplash.com/photo-1556742504-16b083241fab?w=600&q=80',
  other: 'https://images.unsplash.com/photo-1517248135467-4c7edcad34c4?w=600&q=80',
};

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

export const PLACES: readonly Place[] = [
  {
    id: 'bar-rosa-barcelona',
    name: 'Bar Rosa',
    category: 'restaurant',
    description:
      'Neighbourhood tapas bar in the heart of Gràcia. Small plates, natural wines and one of the first spots in the city to accept FairCoin at the register.',
    address: 'Carrer de Verdi, 7',
    city: 'Barcelona',
    country: 'Spain',
    latitude: 41.4036,
    longitude: 2.1557,
    imageUrl: CATEGORY_IMAGE.restaurant,
    phone: '+34932185529',
    website: 'https://barrosabcn.example',
    minimumSpend: 5,
    localCurrency: 'EUR',
    openingHours: 'Tue-Sun 12:00-23:00',
  },
  {
    id: 'calafou-colonia',
    name: 'Calafou',
    category: 'service',
    description:
      'Post-capitalist, eco-industrial colony and cooperative workshop. Hosts hacklabs, fabrication, farming and cultural events.',
    address: 'Ctra. de la Pobla de Claramunt, s/n',
    city: "Vallbona d'Anoia",
    country: 'Spain',
    latitude: 41.5394,
    longitude: 1.692,
    imageUrl: CATEGORY_IMAGE.service,
    website: 'https://calafou.org',
    acceptsFairToFiat: true,
    localCurrency: 'EUR',
    fiatPayoutMethods: ['cash', 'bank'],
    maxFiatPayout: 500,
    openingHours: 'Mon-Fri 10:00-20:00',
  },
  {
    id: 'cafe-comercial-madrid',
    name: 'Café Fair',
    category: 'cafe',
    description:
      'Specialty coffee shop in Chamberí supporting cooperative projects. Single-origin espresso, oat-milk cortados and a small selection of pastries baked in-house.',
    address: 'Calle de Fuencarral, 124',
    city: 'Madrid',
    country: 'Spain',
    latitude: 40.4313,
    longitude: -3.7024,
    imageUrl: CATEGORY_IMAGE.cafe,
    phone: '+34915944612',
    website: 'https://cafefair.example',
    minimumSpend: 3,
    localCurrency: 'EUR',
    openingHours: 'Mon-Sat 08:00-20:00',
  },
  {
    id: 'ecoxarxa-valencia',
    name: 'Ecoxarxa València',
    category: 'shop',
    description:
      'Cooperative market with local organic produce and artisan goods from the Valencian community network.',
    address: 'Carrer de la Reina, 45',
    city: 'Valencia',
    country: 'Spain',
    latitude: 39.4609,
    longitude: -0.3254,
    imageUrl: CATEGORY_IMAGE.shop,
    localCurrency: 'EUR',
    openingHours: 'Tue-Sat 09:00-14:00, 17:00-20:00',
  },
  {
    id: 'faircoop-bilbao',
    name: 'FairCoop Bilbao',
    category: 'service',
    description:
      'Local FairCoop hub and exchange point. Helps newcomers set up wallets, provides educational resources and runs regular meetups for the community.',
    address: 'Kale Nagusia, 20',
    city: 'Bilbao',
    country: 'Spain',
    latitude: 43.2612,
    longitude: -2.9253,
    imageUrl: CATEGORY_IMAGE.service,
    phone: '+34944157890',
    acceptsFairToFiat: true,
    localCurrency: 'EUR',
    fiatPayoutMethods: ['cash', 'bank', 'card'],
    maxFiatPayout: 1000,
    openingHours: 'Mon-Fri 10:00-19:00',
  },
  {
    id: 'fair-atm-sevilla',
    name: 'Fair ATM Sevilla',
    category: 'atm',
    description: 'FairCoin cash-in / cash-out point on the Calle Sierpes. Open Monday to Saturday.',
    address: 'Calle Sierpes, 48',
    city: 'Seville',
    country: 'Spain',
    latitude: 37.3891,
    longitude: -5.9931,
    imageUrl: CATEGORY_IMAGE.atm,
    acceptsFairToFiat: true,
    localCurrency: 'EUR',
    fiatPayoutMethods: ['cash'],
    maxFiatPayout: 250,
    openingHours: 'Mon-Sat 09:00-21:00',
  },
  {
    id: 'panaderia-zaragoza',
    name: 'Panadería Justa',
    category: 'shop',
    description:
      'Artisan bakery and community-supported grocery. Sourdough, organic flours and locally milled grains.',
    address: 'Calle Alfonso I, 15',
    city: 'Zaragoza',
    country: 'Spain',
    latitude: 41.6523,
    longitude: -0.8782,
    imageUrl: CATEGORY_IMAGE.shop,
    phone: '+34976393021',
    minimumSpend: 2,
    localCurrency: 'EUR',
    openingHours: 'Mon-Sat 07:30-14:30',
  },
  {
    id: 'cooperativa-malaga',
    name: 'Cooperativa Verde',
    category: 'shop',
    description: 'Organic food cooperative with a bulk-goods section and zero-waste refill bar.',
    address: 'Calle Larios, 5',
    city: 'Málaga',
    country: 'Spain',
    latitude: 36.7213,
    longitude: -4.4214,
    imageUrl: CATEGORY_IMAGE.shop,
    minimumSpend: 10,
    localCurrency: 'EUR',
    openingHours: 'Mon-Sat 10:00-21:00',
  },
  {
    id: 'taller-granada',
    name: 'Taller Cooperativo',
    category: 'service',
    description:
      "Bike and electronics repair workshop run as a workers' cooperative. Walk-ins welcome.",
    address: 'Calle Elvira, 41',
    city: 'Granada',
    country: 'Spain',
    latitude: 37.1773,
    longitude: -3.5986,
    imageUrl: CATEGORY_IMAGE.service,
    phone: '+34958221033',
    minimumSpend: 15,
    localCurrency: 'EUR',
    openingHours: 'Mon-Fri 10:00-14:00, 16:00-20:00',
  },
  {
    id: 'restaurante-vegetal-palma',
    name: 'Restaurante Vegetal',
    category: 'restaurant',
    description:
      'Plant-based restaurant in Palma, FairCoin friendly. Seasonal Mediterranean menu and a small natural-wine list.',
    address: 'Carrer dels Oms, 22',
    city: 'Palma',
    country: 'Spain',
    latitude: 39.5741,
    longitude: 2.6503,
    imageUrl: CATEGORY_IMAGE.restaurant,
    website: 'https://restaurantevegetal.example',
    minimumSpend: 8,
    localCurrency: 'EUR',
    openingHours: 'Wed-Mon 13:00-16:00, 20:00-23:30',
  },
  {
    id: 'kafeneio-athens',
    name: 'Kafeneio Koinos',
    category: 'cafe',
    description:
      'Community café in Exarcheia. Greek coffee, homemade spoon sweets and a small library of zines.',
    address: 'Themistokleous 70',
    city: 'Athens',
    country: 'Greece',
    latitude: 37.9869,
    longitude: 23.7303,
    imageUrl: CATEGORY_IMAGE.cafe,
    localCurrency: 'EUR',
    openingHours: 'Daily 09:00-02:00',
  },
  {
    id: 'markthalle-berlin',
    name: 'Markthalle Fair',
    category: 'shop',
    description:
      'Weekly cooperative market stall inside Markthalle Neun, with seasonal vegetables and fermented goods.',
    address: 'Eisenbahnstraße 42',
    city: 'Berlin',
    country: 'Germany',
    latitude: 52.5052,
    longitude: 13.4271,
    imageUrl: CATEGORY_IMAGE.shop,
    minimumSpend: 5,
    localCurrency: 'EUR',
    openingHours: 'Thu 17:00-22:00',
  },
  {
    id: 'cafe-ljubljana',
    name: 'Café Metelkova',
    category: 'cafe',
    description:
      'Autonomous cultural centre café. Open late, vegan kitchen, and regular music and film nights.',
    address: 'Masarykova cesta 24',
    city: 'Ljubljana',
    country: 'Slovenia',
    latitude: 46.0569,
    longitude: 14.5142,
    imageUrl: CATEGORY_IMAGE.cafe,
    localCurrency: 'EUR',
    openingHours: 'Tue-Sun 18:00-02:00',
  },
  {
    id: 'fair-hub-lisbon',
    name: 'Fair Hub Lisboa',
    category: 'service',
    description:
      'Co-working and FairCoin exchange point. Desks by the day, fibre internet and on-site help getting started with FairCoin.',
    address: 'Rua das Janelas Verdes, 9',
    city: 'Lisbon',
    country: 'Portugal',
    latitude: 38.706,
    longitude: -9.1605,
    imageUrl: CATEGORY_IMAGE.service,
    website: 'https://fairhublisboa.example',
    acceptsFairToFiat: true,
    localCurrency: 'EUR',
    fiatPayoutMethods: ['cash', 'bank'],
    maxFiatPayout: 750,
    openingHours: 'Mon-Fri 09:00-19:00',
  },
  {
    id: 'cooperativa-porto',
    name: 'Cooperativa do Porto',
    category: 'shop',
    description:
      'Consumer cooperative accepting FairCoin. Pantry staples, household goods and fresh bread.',
    address: 'Rua de Santa Catarina, 312',
    city: 'Porto',
    country: 'Portugal',
    latitude: 41.1499,
    longitude: -8.6073,
    imageUrl: CATEGORY_IMAGE.shop,
    minimumSpend: 5,
    localCurrency: 'EUR',
    openingHours: 'Mon-Sat 09:00-20:00',
  },
  {
    id: 'fair-atm-paris',
    name: 'Fair ATM Paris',
    category: 'atm',
    description:
      'FairCoin exchange kiosk located inside a Belleville café, open during business hours.',
    address: 'Rue de Belleville, 55',
    city: 'Paris',
    country: 'France',
    latitude: 48.8724,
    longitude: 2.3767,
    imageUrl: CATEGORY_IMAGE.atm,
    acceptsFairToFiat: true,
    localCurrency: 'EUR',
    fiatPayoutMethods: ['cash'],
    maxFiatPayout: 200,
    openingHours: 'Mon-Sat 10:00-20:00',
  },
] as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/**
 * Compute the great-circle distance between two coordinates in kilometres
 * using the Haversine formula.
 *
 * This is an approximation (treats the Earth as a perfect sphere) but it is
 * more than accurate enough for the "how far is this café" use-case and
 * avoids pulling in a third-party geolib.
 */
export function distanceKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
): number {
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);

  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;

  const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
  return EARTH_RADIUS_KM * c;
}

/**
 * Format a kilometre distance for display next to a place. Shows one decimal
 * place for nearby places (< 10 km) and a rounded integer for anything
 * further, matching the Google Maps convention.
 */
export function formatDistanceKm(km: number): string {
  return km < 10 ? km.toFixed(1) : String(Math.round(km));
}

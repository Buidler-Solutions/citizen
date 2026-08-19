/**
 * Geo module — proximity checks for clue check-ins. Haversine distance with
 * the original TreasureNet 1-meter-precision requirement configurable per
 * clue radius.
 */

export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6_371_000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

export interface GeoCheck {
  withinRadius: boolean;
  distanceMeters: number;
  radiusMeters: number;
}

export function checkProximity(
  playerLat: number,
  playerLon: number,
  clueLat: number,
  clueLon: number,
  radiusMeters: number
): GeoCheck {
  const distanceMeters = haversineMeters(playerLat, playerLon, clueLat, clueLon);
  return {
    withinRadius: distanceMeters <= radiusMeters,
    distanceMeters: Math.round(distanceMeters * 100) / 100,
    radiusMeters,
  };
}

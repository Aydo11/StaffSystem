// Geotagging at Start and Finish, and OpenStreetMap embeds for properties and visits.
export type Geo = { lat: number; lng: number; accuracy: number };

// The device's location now, or undefined if it is refused, unavailable or slow. Never blocks a visit.
export const here = () => new Promise<Geo | undefined>((resolve) => {
  if (!('geolocation' in navigator)) return resolve(undefined);
  navigator.geolocation.getCurrentPosition(
    (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
    () => resolve(undefined),
    { enableHighAccuracy: true, timeout: 8000, maximumAge: 60_000 },
  );
});

export const distanceText = (m: number | null | undefined) => (m == null ? null : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);
export const FAR = 250; // metres from the property before a start is flagged

// One pin on an OpenStreetMap embed (no API key, no tracking scripts on our pages).
export function MapEmbed({ lat, lng, title, height = 260 }: { lat: number; lng: number; title: string; height?: number }) {
  const d = 0.004;
  const src = `https://www.openstreetmap.org/export/embed.html?bbox=${lng - d * 1.6},${lat - d},${lng + d * 1.6},${lat + d}&layer=mapnik&marker=${lat},${lng}`;
  return (
    <div>
      <iframe title={title} src={src} loading="lazy" style={{ width: '100%', height, border: 0, borderRadius: 12 }} />
      <p className="small"><a href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=17/${lat}/${lng}`} target="_blank" rel="noreferrer">Open the full map</a> · <a href={`https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`} target="_blank" rel="noreferrer">Directions</a></p>
    </div>
  );
}

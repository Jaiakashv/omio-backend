require('dotenv').config();
const fs = require('fs');
const { Client } = require('pg');

(async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();

  const raw = fs.readFileSync('./12go.json', 'utf8');
  const trips = JSON.parse(raw);

  // ✅ Skip records with no price
  const validTrips = trips.filter(t => {
    return (
      t.Price !== undefined &&
      t.Price !== null &&
      parseFloat(t.Price) > 0 &&
      t["Departure Time"] &&
      t["Arrival Time"] &&
      t.route_url
    );
  });

  console.log(`Found ${trips.length} total records`);
  console.log(`Importing ${validTrips.length} valid records`);
  console.log(`Skipping ${trips.length - validTrips.length} records with missing/invalid price`);

  // Helpers
  const parseDurationMinutes = (v) => {
    if (v === undefined || v === null) return null;
    const s = String(v).toLowerCase().trim();
    let total = 0;
    const h = s.match(/(\d+)\s*h/);
    const m = s.match(/(\d+)\s*m/);
    if (h) total += parseInt(h[1], 10) * 60;
    if (m) total += parseInt(m[1], 10);
    if (total > 0) return total;
    const hm = s.match(/^(\d{1,2}):(\d{2})$/);
    if (hm) {
      return parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
    }
    const num = parseInt(s, 10);
    return Number.isFinite(num) ? num : null;
  };

  const parsePriceNumber = (v) => {
    if (v === undefined || v === null) return null;
    const num = parseFloat(String(v).replace(/[,\s]/g, ''));
    return Number.isFinite(num) ? num : null;
  };

  // Parse datetime safely
  const parseTimestamp = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString(); // PG will accept ISO8601
  };

  const parseDate = (v) => {
    if (!v) return null;
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0]; // YYYY-MM-DD
  };

  // Batch insert for speed
  const BATCH_SIZE = 400;
  let imported = 0;

  for (let i = 0; i < validTrips.length; i += BATCH_SIZE) {
    const batch = validTrips.slice(i, i + BATCH_SIZE);

    const values = batch.map((_, idx) => {
      const base = idx * 13; // ✅ 13 columns
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13})`;
    }).join(',');

    const flatParams = batch.flatMap(t => [
      t.route_url,
      t.From,
      t.To,
      parseTimestamp(t["Departure Time"]),
      parseTimestamp(t["Arrival Time"]),
      t["Transport Type"],
      parseDurationMinutes(t.Duration) || 0,
      parsePriceNumber(t.Price) || 0,
      parsePriceNumber(t['Price in INR']) || 0,
      t.currency || 'THB',
      parseDate(t.Date),
      t.Operator,
      t.provider
    ]);

    await client.query({
      text: `
        INSERT INTO trips (
          route_url, origin, destination,
          departure_time, arrival_time, transport_type,
          duration_min, price, price_inr, currency, travel_date,
          operator_name, provider
        ) VALUES ${values}
      `,
      values: flatParams,
      rowMode: 'array'
    });

    imported += batch.length;
    console.log(`Progress: ${imported}/${validTrips.length} records imported`);
  }
  const start = Date.now();
  let elapsed = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`✅ Import completed! Imported ${imported} records in ${elapsed}s`);
  await client.end();
})();

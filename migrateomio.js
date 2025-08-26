require('dotenv').config();
const fs = require('fs');
const { Client } = require('pg');

(async () => {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  await client.connect();

  const raw = fs.readFileSync('./omio.json', 'utf8');
  const trips = JSON.parse(raw);

  // conversion rate
  const THB_TO_INR = 2.32;

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
    if (!v) return null;
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
    if (!v) return null;
    const num = parseFloat(String(v).replace(/[,\s]/g, ''));
    return Number.isFinite(num) ? num : null;
  };

  const parseTimestamp = (v) => {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d.toISOString();
  };

  const parseDate = (v) => {
    if (!v) return null;
    const d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().split('T')[0];
  };

  // Batch insert
  const BATCH_SIZE = 400;
  let imported = 0;

  for (let i = 0; i < validTrips.length; i += BATCH_SIZE) {
    const batch = validTrips.slice(i, i + BATCH_SIZE);

    const values = batch.map((_, idx) => {
      const base = idx * 13; // ✅ 13 columns
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13})`;
    }).join(',');

    const flatParams = batch.flatMap(t => {
      const priceThb = parsePriceNumber(t.Price) || 0;
      return [
        t.route_url,                       // $1  route_url
        t.From,                            // $2  origin
        t.To,                              // $3  destination
        parseTimestamp(t["Departure Time"]), // $4  departure_time
        parseTimestamp(t["Arrival Time"]),   // $5  arrival_time
        t["Transport Type"],               // $6  transport_type
        parseDurationMinutes(t.Duration) || 0, // $7  duration_min
        priceThb,                          // $8  price
        Math.round(priceThb * THB_TO_INR), // $9  price_inr
        t.currency || "THB",               // $10 currency
        parseDate(t.Date),                 // $11 travel_date
        t.Operator || null,                // $12 operator_name
        t.provider                         // $13 provider
      ];
    });

    await client.query({
      text: `
        INSERT INTO trips (
          route_url, origin, destination,
          departure_time, arrival_time, transport_type,
          duration_min, price, price_inr, currency,
          travel_date, operator_name, provider
        ) VALUES ${values}
      `,
      values: flatParams,
      rowMode: 'array'
    });

    imported += batch.length;
    console.log(`Progress: ${imported}/${validTrips.length} records imported`);
  }

  console.log(`✅ Import completed! Imported ${imported} records`);
  await client.end();
})();

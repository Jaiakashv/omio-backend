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

  // Filter out invalid records first
  const validTrips = trips.filter(t => {
    return t.Price && t["Departure Time"] && t["Arrival Time"] && t.Title && t.route_url;
  });

  console.log(`Found ${trips.length} total records`);
  console.log(`Importing ${validTrips.length} valid records`);
  console.log(`Skipping ${trips.length - validTrips.length} records with missing data`);

  // Helpers
  const parseDurationMinutes = (v) => {
    if (v === undefined || v === null) return null;
    const s = String(v).toLowerCase().trim();
    let total = 0;
    // Match formats like "5h 30m", "5h", "30m"
    const h = s.match(/(\d+)\s*h/);
    const m = s.match(/(\d+)\s*m/);
    if (h) total += parseInt(h[1], 10) * 60;
    if (m) total += parseInt(m[1], 10);
    if (total > 0) return total;
    // Fallback: formats like "5:30"
    const hm = s.match(/^(\d{1,2}):(\d{2})$/);
    if (hm) {
      return parseInt(hm[1], 10) * 60 + parseInt(hm[2], 10);
    }
    // Fallback: plain number meaning minutes
    const num = parseInt(s, 10);
    return Number.isFinite(num) ? num : null;
  };

  const parsePriceNumber = (v) => {
    if (v === undefined || v === null) return null;
    const num = parseFloat(String(v).replace(/[,\s]/g, ''));
    return Number.isFinite(num) ? num : null;
  };

  // Batch insert for speed
  const BATCH_SIZE = 100;
  let imported = 0;

  for (let i = 0; i < validTrips.length; i += BATCH_SIZE) {
    const batch = validTrips.slice(i, i + BATCH_SIZE);
    
    const values = batch.map((_, idx) => {
      const base = idx * 12;
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12})`;
    }).join(',');
    
    const params = batch.flatMap(t => [
      t.route_url, t.Title, t.From, t.To,
      t["Departure Time"], t["Arrival Time"], 
      t["Transport Type"], parseDurationMinutes(t.Duration), 
      parsePriceNumber(t.Price), t.Date, t.Operator, t.provider
    ]);
    
    await client.query(`
      INSERT INTO trips (
        route_url, title, origin, destination,
        departure_time, arrival_time, transport_type,
        duration_min, price_thb, travel_date,
        operator_name, provider
      ) VALUES ${values}
    `, params);
    
    imported += batch.length;
    console.log(`Progress: ${imported}/${validTrips.length} records imported`);
  }

  console.log(`✅ Import completed! Imported ${imported} records`);
  await client.end();
})();

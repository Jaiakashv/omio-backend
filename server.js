const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const { LRUCache } = require('lru-cache');

// Load environment variables
dotenv.config();

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit immediately, give time to log the error
  setTimeout(() => process.exit(1), 1000);
});

// Handle unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
const port = process.env.PORT || 5001; // Different port from server.js

// Create connection pools for both providers
const pools = {
  '12go': new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 10,
  }),
  'bookaway': new Pool({
    connectionString: process.env.BOOKAWAY_URL,
    max: 10,
  })
};

// Test DB connections
Object.entries(pools).forEach(([provider, pool]) => {
  pool.on('error', (err) => {
    console.error(`❌ Unexpected error on ${provider} PostgreSQL client:`, err);
  });
  
  pool.connect((err, client, release) => {
    if (err) {
      console.error(`❌ Error connecting to ${provider} PostgreSQL:`, err);
      // Don't exit, just log the error and continue
      return;
    }
    console.log(`✅ ${provider} PostgreSQL connected successfully`);
    release();
  });
});

// Middleware
app.use(cors());
app.use(express.json());

// LRU Cache settings
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_ITEMS = 50;

// Simple cache tracking
let cacheStats = {
  hits: 0,
  misses: 0
};

// Initialize LRU cache with simplified configuration
const lruCache = new LRUCache({
  max: MAX_CACHE_ITEMS,
  ttl: CACHE_DURATION
});

// Helper functions
const safeStringify = (obj) => {
  try {
    return typeof obj === 'string' ? obj : JSON.stringify(obj);
  } catch (e) {
    console.error('Error stringifying cache value:', e);
    return 'error';
  }
};

const calculateSize = (value, key) => {
  try {
    const keyStr = safeStringify(key);
    const valueStr = safeStringify(value);
    return Buffer.byteLength(valueStr) + Buffer.byteLength(keyStr);
  } catch (e) {
    console.error('Error calculating cache size:', e);
    return 0;
  }
};

// Cache management functions
const getFromCache = (key) => {
  try {
    const cacheKey = safeStringify(key);
    const value = lruCache.get(cacheKey);
    if (value !== undefined) {
      cacheStats.hits++;
      console.log(`✅ Cache hit: ${cacheKey}`);
    } else {
      cacheStats.misses++;
      console.log(`❌ Cache miss: ${cacheKey}`);
    }
    return value;
  } catch (error) {
    console.error('Error getting from cache:', error);
    return undefined;
  }
};

const setInCache = (key, value) => {
  try {
    const cacheKey = safeStringify(key);
    lruCache.set(cacheKey, value);
    cacheStats.currentSize = lruCache.size;
    console.log(`💾 Cached: ${cacheKey}`);
  } catch (error) {
    console.error('Error setting cache:', error);
    if (global.gc) {
      console.log('Running garbage collection...');
      global.gc();
    }
  }
};

// Helper function to execute a query with error handling
const safeQuery = async (pool, query, params = []) => {
  const client = await pool.connect();
  try {
    const result = await client.query(query, params);
    return result.rows;
  } catch (error) {
    console.error('Database query error:', error);
    throw error;
  } finally {
    client.release();
  }
};

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'API is running',
    endpoints: {
      getTrips: '/api/:provider/trips?page=1&limit=10',
      search: '/api/:provider/search?field=origin&q=search_term',
      transportTypes: '/api/transport-types'
    }
  });
});

// Get distinct transport types for both providers
app.get('/api/transport-types', async (req, res) => {
  const cacheKey = 'transport_types';
  const cachedData = getFromCache(cacheKey);
  
  if (cachedData) {
    return res.json(cachedData);
  }

  try {
    // Get transport types for 12go
    const query12go = 'SELECT DISTINCT transport_type FROM trips;';
    const result12go = await safeQuery(pools['12go'], query12go);
    const types12go = result12go.map(row => row.transport_type).join(', ');
    
    // Get transport types for bookaway
    const queryBookaway = 'SELECT DISTINCT transport_type FROM bookaway_trips;';
    const resultBookaway = await safeQuery(pools['bookaway'], queryBookaway);
    const typesBookaway = resultBookaway.map(row => row.transport_type).join(', ');
    
    const response = {
      "12go": {
        "routes": types12go
      },
      "bookaway": {
        "routes": typesBookaway
      },
      success: true,
      timestamp: new Date().toISOString()
    };
    
    setInCache(cacheKey, response);
    res.json(response);
  } catch (error) {
    console.error('Error fetching transport types:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch transport types',
      details: error.message
    });
  }
});

// Helper function to get unique routes count for a provider
async function getUniqueRoutes(pool, tableName, params, conditions) {
  let query = `SELECT COUNT(DISTINCT (origin, destination)) as unique_routes FROM ${tableName}`;
  
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  
  const result = await pool.query(query, params);
  return parseInt(result.rows[0]?.unique_routes || 0);
}

// Helper function to get lowest price for a provider
async function getLowestPrice(pool, tableName, params, conditions) {
  let query = `SELECT MIN(price_inr) as lowest_price FROM ${tableName}`;
  
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  
  const result = await pool.query(query, params);
  return result.rows[0]?.lowest_price || '0.00';
}

// Helper function to get highest price for a provider
async function getHighestPrice(pool, tableName, params, conditions) {
  let query = `SELECT MAX(price_inr) as highest_price FROM ${tableName}`;
  
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  
  const result = await pool.query(query, params);
  return result.rows[0]?.highest_price || '0.00';
}

// Get highest price from all providers
app.get('/api/metrics/highest-price', async (req, res) => {
  const { from, to, transportType } = req.query;
  const timestamp = new Date().toISOString();
  
  try {
    const results = {};
    const conditions = [];
    const params = [];
    
    if (from) {
      params.push(from);
      conditions.push(`origin = $${params.length}`);
    }
    
    if (to) {
      params.push(to);
      conditions.push(`destination = $${params.length}`);
    }
    
    if (transportType) {
      params.push(transportType);
      conditions.push(`transport_type = $${params.length}`);
    }
    
    // Get highest price for each provider
    for (const [provider, pool] of Object.entries(pools)) {
      const tableName = provider === '12go' ? 'trips' : 'bookaway_trips';
      results[provider] = {
        highest_price: await getHighestPrice(pool, tableName, params, [...conditions])
      };
    }
    
    res.json(results);
  } catch (error) {
    console.error('Error in /api/metrics/highest-price:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get lowest price from all providers
app.get('/api/metrics/lowest-price', async (req, res) => {
  const { from, to, transportType } = req.query;
  const timestamp = new Date().toISOString();
  
  try {
    const params = [];
    const conditions = [];
    
    if (from) {
      conditions.push(`LOWER(origin) = LOWER($${params.length + 1})`);
      params.push(from);
    }
    
    if (to) {
      conditions.push(`LOWER(destination) = LOWER($${params.length + 1})`);
      params.push(to);
    }
    
    if (transportType) {
      conditions.push(`LOWER(transport_type) = LOWER($${params.length + 1})`);
      params.push(transportType);
    }
    
    // Execute queries for both providers in parallel
    const [twelveGoPrice, bookawayPrice] = await Promise.all([
      getLowestPrice(pools['12go'], 'trips', [...params], [...conditions]),
      getLowestPrice(pools['bookaway'], 'bookaway_trips', [...params], [...conditions])
    ]);
    
    res.json({
      "12go": {
        lowest_price: twelveGoPrice.toString(),
        timestamp: timestamp
      },
      "bookaway": {
        lowest_price: bookawayPrice.toString(),
        timestamp: timestamp
      }
    });
    
  } catch (error) {
    console.error('Error in /api/metrics/lowest-price:', error);
    res.status(500).json({ 
      error: 'Failed to fetch lowest prices',
      details: error.message 
    });
  }
});

// Get unique routes count for all providers
app.get('/api/metrics/unique-routes', async (req, res) => {
  const { from, to, transportType } = req.query;
  const timestamp = new Date().toISOString();
  
  try {
    const params = [];
    const conditions = [];
    
    if (from) {
      conditions.push(`LOWER(origin) = LOWER($${params.length + 1})`);
      params.push(from);
    }
    
    if (to) {
      conditions.push(`LOWER(destination) = LOWER($${params.length + 1})`);
      params.push(to);
    }
    
    if (transportType) {
      conditions.push(`LOWER(transport_type) = LOWER($${params.length + 1})`);
      params.push(transportType);
    }
    
    // Execute queries for both providers in parallel
    const [twelveGoCount, bookawayCount] = await Promise.all([
      getUniqueRoutes(pools['12go'], 'trips', [...params], [...conditions]),
      getUniqueRoutes(pools['bookaway'], 'bookaway_trips', [...params], [...conditions])
    ]);
    
    res.json({
      "12go": {
        unique_routes: twelveGoCount,
        timestamp: timestamp
      },
      "bookaway": {
        unique_routes: bookawayCount,
        timestamp: timestamp
      }
    });
    
  } catch (error) {
    console.error('Error in /api/metrics/unique-routes:', error);
    res.status(500).json({ 
      error: 'Failed to fetch unique routes',
      details: error.message 
    });
  }
});

// Helper function to get the cheapest carrier for a provider
async function getCheapestCarrier(pool, tableName, params, conditions) {
  let query = `
    SELECT operator_name 
    FROM ${tableName}
    ${conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''}
    ORDER BY price_inr ASC
    LIMIT 1
  `;
  
  const result = await pool.query(query, params);
  return result.rows[0]?.operator_name || null;
}

// Helper function to get unique providers count for a provider
async function getUniqueProviders(pool, tableName, params, conditions) {
  let query = `SELECT COUNT(DISTINCT operator_name) as unique_providers FROM ${tableName}`;
  
  if (conditions.length > 0) {
    query += ' WHERE ' + conditions.join(' AND ');
  }
  
  const result = await pool.query(query, params);
  return parseInt(result.rows[0]?.unique_providers || 0);
}

// Get unique providers count from all providers
app.get('/api/metrics/unique-providers', async (req, res) => {
  const { from, to, transportType } = req.query;
  const timestamp = new Date().toISOString();
  
  try {
    const params = [];
    const conditions = [];
    
    if (from) {
      conditions.push(`LOWER(origin) = LOWER($${params.length + 1})`);
      params.push(from);
    }
    
    if (to) {
      conditions.push(`LOWER(destination) = LOWER($${params.length + 1})`);
      params.push(to);
    }
    
    if (transportType) {
      conditions.push(`LOWER(transport_type) = LOWER($${params.length + 1})`);
      params.push(transportType);
    }
    
    // Get unique providers count for both providers in parallel
    const [twelveGoCount, bookawayCount] = await Promise.all([
      getUniqueProviders(pools['12go'], 'trips', [...params], [...conditions]),
      getUniqueProviders(pools['bookaway'], 'bookaway_trips', [...params], [...conditions])
    ]);
    
    res.json({
      "12go": {
        unique_providers: twelveGoCount,
        timestamp: timestamp
      },
      "bookaway": {
        unique_providers: bookawayCount,
        timestamp: timestamp
      }
    });
    
  } catch (error) {
    console.error('Error in /api/metrics/unique-providers:', error);
    res.status(500).json({ 
      error: 'Failed to fetch unique providers',
      details: error.message 
    });
  }
});

// Get cheapest carriers from all providers
app.get('/api/metrics/cheapest-carriers', async (req, res) => {
  const { from, to, transportType } = req.query;
  const timestamp = new Date().toISOString();
  
  try {
    const params = [];
    const conditions = [];
    
    if (from) {
      conditions.push(`LOWER(origin) = LOWER($${params.length + 1})`);
      params.push(from);
    }
    
    if (to) {
      conditions.push(`LOWER(destination) = LOWER($${params.length + 1})`);
      params.push(to);
    }
    
    if (transportType) {
      conditions.push(`LOWER(transport_type) = LOWER($${params.length + 1})`);
      params.push(transportType);
    }
    
    // Get cheapest carrier for both providers in parallel
    const [twelveGoCarrier, bookawayCarrier] = await Promise.all([
      getCheapestCarrier(pools['12go'], 'trips', [...params], [...conditions]),
      getCheapestCarrier(pools['bookaway'], 'bookaway_trips', [...params], [...conditions])
    ]);
    
    res.json({
      "12go": {
        carriers: twelveGoCarrier ? [twelveGoCarrier] : []
      },
      "bookaway": {
        carriers: bookawayCarrier ? [bookawayCarrier] : []
      },
      timestamp: timestamp
    });
    
  } catch (error) {
    console.error('Error in /api/metrics/cheapest-carriers:', error);
    res.status(500).json({ 
      error: 'Failed to fetch cheapest carriers',
      details: error.message 
    });
  }
});

// Get trips with pagination
app.get('/api/:provider/trips', async (req, res) => {
  const { provider } = req.params;
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 10;
  const offset = (page - 1) * limit;

  if (!pools[provider]) {
    return res.status(400).json({ error: 'Invalid provider. Use either "12go" or "bookaway"' });
  }

  const cacheKey = `${provider}_trips_page${page}_limit${limit}`;
  const cachedData = getFromCache(cacheKey);
  
  if (cachedData) {
    return res.json(cachedData);
  }

  try {
    const pool = pools[provider];
    const tableName = provider === 'bookaway' ? 'bookaway_trips' : 'trips';
    
    // Get total count
    const countResult = await safeQuery(
      pool,
      `SELECT COUNT(*) FROM ${tableName}`
    );
    
    // Get paginated data with COALESCE to handle NULL values
    const trips = await safeQuery(
      pool,
      `SELECT 
        id,
        COALESCE(origin, 'N/A') as "From",
        COALESCE(destination, 'N/A') as "To",
        COALESCE(price_inr, 0) as "Price",
        COALESCE(operator_name, 'N/A') as "Operator",
        COALESCE(TO_CHAR(travel_date, 'YYYY-MM-DD'), 'N/A') as "Date",
        COALESCE(route_url, '#') as route_url,
        COALESCE(transport_type, 'N/A') as transport_type,
        COALESCE(TO_CHAR(departure_time, 'HH24:MI'), 'N/A') as departure_time,
        COALESCE(TO_CHAR(arrival_time, 'HH24:MI'), 'N/A') as arrival_time,
        '${provider}' as source
      FROM ${tableName} 
      ORDER BY id 
      LIMIT $1 OFFSET $2`,
      [limit, offset]
    );

    const total = parseInt(countResult[0].count, 10);
    const totalPages = Math.ceil(total / limit);

    const response = {
      data: trips,
      pagination: {
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      }
    };

    setInCache(cacheKey, response);
    res.json(response);
  } catch (error) {
    console.error(`Error fetching ${provider} trips:`, error);
    res.status(500).json({ error: 'Failed to fetch trips', details: error.message });
  }
});


// Search endpoint
app.get('/api/:provider/search', async (req, res) => {
  const { provider } = req.params;
  const { field, q } = req.query;
  
  if (!pools[provider]) {
    return res.status(400).json({ error: 'Invalid provider. Use either "12go" or "bookaway"' });
  }

  if (!field || !q) {
    return res.status(400).json({ error: 'Both field and q parameters are required' });
  }
  
  const validFields = ['origin', 'destination', 'transport_type', 'operator_name'];
  if (!validFields.includes(field)) {
    return res.status(400).json({ 
      error: `Field must be one of: ${validFields.join(', ')}` 
    });
  }
  
  const cacheKey = `${provider}_search_${field}_${q.toLowerCase()}`;
  const cachedResults = getFromCache(cacheKey);
  
  if (cachedResults) {
    return res.json({ results: cachedResults });
  }
  
  try {
    const pool = pools[provider];
    const tableName = provider === 'bookaway' ? 'bookaway_trips' : 'trips';
    
    let query, params;
    
    if (field === 'origin' || field === 'destination') {
      // For origin/destination search, return complete route information
      query = `
        SELECT DISTINCT 
          origin, 
          destination, 
          transport_type,
          operator_name
        FROM ${tableName}
        WHERE ${field} ILIKE $1
        ORDER BY ${field}
        LIMIT 50
      `;
      params = [`%${q}%`];
    } else {
      // For other fields, just return distinct values
      query = `
        SELECT DISTINCT ${field} as value
        FROM ${tableName}
        WHERE ${field} ILIKE $1
        ORDER BY ${field}
        LIMIT 10
      `;
      params = [`%${q}%`];
    }
    
    const result = await safeQuery(pool, query, params);
    
    let results;
    if (field === 'origin' || field === 'destination') {
      // Format as array of route objects
      results = result.map(row => ({
        origin: row.origin,
        destination: row.destination,
        transport_type: row.transport_type,
        operator_name: row.operator_name
      }));
    } else {
      // For other fields, just return the values
      results = result.map(row => row.value);
    }
    
    setInCache(cacheKey, results);
    res.json({ results });
  } catch (error) {
    console.error(`Error searching ${field}s:`, error);
    res.status(500).json({ 
      error: `Error searching ${field}s`,
      details: error.message 
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start the server
// Get trips by date range
app.get('/api/filter/date', async (req, res) => {
  const { provider, range } = req.query;
  
  if (!provider || !range) {
    return res.status(400).json({ error: 'Provider and range parameters are required' });
  }

  const pool = pools[provider];
  if (!pool) {
    return res.status(400).json({ error: 'Invalid provider' });
  }

  try {
    let query = '';
    let params = [];
    const tableName = provider === '12go' ? 'trips' : 'trips';
    
    switch (range.toLowerCase()) {
      case 'today':
        query = `SELECT * FROM ${tableName} WHERE departure_time::date = CURRENT_DATE`;
        break;
        
      case 'tomorrow':
        query = `SELECT * FROM ${tableName} WHERE departure_time::date = CURRENT_DATE + INTERVAL '1 day'`;
        break;
        
      case 'next 7 days':
        query = `SELECT * FROM ${tableName} WHERE departure_time::date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '7 days'`;
        break;
        
      case 'next 14 days':
        query = `SELECT * FROM ${tableName} WHERE departure_time::date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '14 days'`;
        break;
        
      case 'this month':
        query = `SELECT * FROM ${tableName} WHERE departure_time::date >= date_trunc('month', CURRENT_DATE)::date AND departure_time::date < date_trunc('month', CURRENT_DATE)::date + INTERVAL '1 month'`;
        break;
        
      case 'this year':
        query = `SELECT * FROM ${tableName} WHERE departure_time::date >= date_trunc('year', CURRENT_DATE)::date AND departure_time::date < date_trunc('year', CURRENT_DATE)::date + INTERVAL '1 year'`;
        break;
        
      case 'custom':
        const { startDate, endDate } = req.query;
        if (!startDate || !endDate) {
          return res.status(400).json({ error: 'startDate and endDate are required for custom range' });
        }
        query = `SELECT * FROM ${tableName} WHERE departure_time::date BETWEEN $1 AND $2`;
        params = [startDate, endDate];
        break;
        
      default:
        return res.status(400).json({ error: 'Invalid date range specified' });
    }
    
    const { rows } = await pool.query(query, params);
    res.json({
      success: true,
      count: rows.length,
      data: rows
    });
    
  } catch (error) {
    console.error('Error filtering trips by date:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to filter trips',
      details: error.message 
    });
  }
});

// Get all available filters with caching
app.get('/api/filters', async (req, res) => {
  const cacheKey = 'filters_data';
  
  try {
    // Try to get from cache first
    const cachedData = getFromCache(cacheKey);
    if (cachedData) {
      console.log('Serving filters from cache');
      return res.json(cachedData);
    }
    
    console.log('Cache miss, fetching filters from database');
    const results = {};
    
    // For each provider, get distinct values for each filter field
    for (const [provider, pool] of Object.entries(pools)) {
      const tableName = provider === 'bookaway' ? 'bookaway_trips' : 'trips';
      
      // Get distinct origins
      const origins = await safeQuery(pool, `SELECT DISTINCT origin FROM ${tableName} WHERE origin IS NOT NULL`);
      // Get distinct destinations
      const destinations = await safeQuery(pool, `SELECT DISTINCT destination FROM ${tableName} WHERE destination IS NOT NULL`);
      // Get distinct transport types
      const transportTypes = await safeQuery(pool, `SELECT DISTINCT transport_type FROM ${tableName} WHERE transport_type IS NOT NULL`);
      // Get distinct operators
      const operators = await safeQuery(pool, `SELECT DISTINCT operator_name FROM ${tableName} WHERE operator_name IS NOT NULL`);
      
      // Combine results
      if (!results.origin) results.origin = new Set();
      if (!results.destination) results.destination = new Set();
      if (!results.transport_type) results.transport_type = new Set();
      if (!results.operator_name) results.operator_name = new Set();
      
      origins.forEach(row => row.origin && results.origin.add(row.origin));
      destinations.forEach(row => row.destination && results.destination.add(row.destination));
      transportTypes.forEach(row => row.transport_type && results.transport_type.add(row.transport_type));
      operators.forEach(row => row.operator_name && results.operator_name.add(row.operator_name));
    }
    
    // Convert Sets to comma-separated strings
    const response = {
      origin: Array.from(results.origin || []).join(','),
      destination: Array.from(results.destination || []).join(','),
      transport_type: Array.from(results.transport_type || []).join(','),
      operator_name: Array.from(results.operator_name || []).join(',')
    };
    
    // Cache the response for 1 hour (3600000 ms)
    setInCache(cacheKey, response, 3600000);
    res.json(response);
  } catch (error) {
    console.error('Error fetching filters:', error);
    res.status(500).json({ error: 'Failed to fetch filters' });
  }
});

// Combined trips query endpoint
app.get('/api/combined-trips', async (req, res) => {
  const {
    origin,
    destination,
    operator_name,
    transport_type,
    timeline,
    start_date,
    end_date
  } = req.query;

  try {
    let query12go = `
      SELECT '12go' as provider, * FROM trips 
      WHERE 1=1
    `;

    let queryBookaway = `
      SELECT 'bookaway' as provider, * FROM bookaway_trips 
      WHERE 1=1
    `;

    const params = [];
    let paramIndex = 1;

    const addFilter = (field, value, query) => {
      if (value) {
        query += ` AND ${field} = $${paramIndex}`;
        params.push(value);
        paramIndex++;
      }
      return query;
    };

    query12go = addFilter('origin', origin, query12go);
    query12go = addFilter('destination', destination, query12go);
    query12go = addFilter('operator_name', operator_name, query12go);
    query12go = addFilter('transport_type', transport_type, query12go);

    queryBookaway = addFilter('origin', origin, queryBookaway);
    queryBookaway = addFilter('destination', destination, queryBookaway);
    queryBookaway = addFilter('operator_name', operator_name, queryBookaway);
    queryBookaway = addFilter('transport_type', transport_type, queryBookaway);

    if (timeline === 'Custom' && start_date && end_date) {
      query12go += ` AND travel_date BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
      queryBookaway += ` AND travel_date BETWEEN $${paramIndex} AND $${paramIndex + 1}`;
      params.push(start_date, end_date);
      paramIndex += 2;
    } else if (timeline) {
      let dateCondition = '';
      switch (timeline) {
        case 'Today':
          dateCondition = 'travel_date = CURRENT_DATE';
          break;
        case 'Yesterday':
          dateCondition = 'travel_date = CURRENT_DATE - INTERVAL \'1 day\'';
          break;
        case 'Last 7 Days':
          dateCondition = 'travel_date >= CURRENT_DATE - INTERVAL \'7 days\'';
          break;
        case 'Last 14 Days':
          dateCondition = 'travel_date >= CURRENT_DATE - INTERVAL \'14 days\'';
          break;
        case 'Last 28 Days':
          dateCondition = 'travel_date >= CURRENT_DATE - INTERVAL \'28 days\'';
          break;
        case 'Last 30 Days':
          dateCondition = 'travel_date >= CURRENT_DATE - INTERVAL \'30 days\'';
          break;
        case 'Last 90 Days':
          dateCondition = 'travel_date >= CURRENT_DATE - INTERVAL \'90 days\'';
          break;
        case 'This Month':
          dateCondition = "travel_date >= date_trunc('month', CURRENT_DATE) AND travel_date < date_trunc('month', CURRENT_DATE) + INTERVAL '1 month'"
          break;
        case 'This Year':
          dateCondition = "travel_date >= date_trunc('year', CURRENT_DATE) AND travel_date < date_trunc('year', CURRENT_DATE) + INTERVAL '1 year'"
          break;
      }
      if (dateCondition) {
        query12go += ` AND ${dateCondition}`;
        queryBookaway += ` AND ${dateCondition}`;
      }
    }

    const [result12go, resultBookaway] = await Promise.all([
      safeQuery(pools['12go'], query12go, params),
      safeQuery(pools['bookaway'], queryBookaway, params)
    ]);

    const combinedResults = [
      ...(result12go.rows || []),
      ...(resultBookaway.rows || [])
    ];

    res.json({
      success: true,
      data: combinedResults,
      count: combinedResults.length
    });

  } catch (error) {
    console.error('Error in combined trips query:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch combined trips data'
    });
  }
});

const server = app.listen(port, () => {
  console.log(`🚀 Server v2 running on port ${port}`);
  console.log('Available providers:', Object.keys(pools).join(', '));
  console.log(`API Documentation: http://localhost:${port}/`);
});

// Handle graceful shutdown
const shutdown = async () => {
  console.log('\n🛑 Shutting down server...');
  
  // Close the HTTP server
  server.close(() => {
    console.log('✅ HTTP server closed');
    
    // Close all database connections
    Promise.all(
      Object.entries(pools).map(([provider, pool]) => 
        pool.end()
          .then(() => console.log(`✅ ${provider} pool closed`))
          .catch(err => console.error(`❌ Error closing ${provider} pool:`, err))
      )
    ).then(() => {
      console.log('✅ All database connections closed');
      process.exit(0);
    });
  });
};

// Listen for termination signals
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);